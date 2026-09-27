-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0007 — Integrations: API keys, outbound webhooks
-- ════════════════════════════════════════════════════════════════════════
-- External systems use the public REST API (/api/v1) with an org API key,
-- and subscribe to domain events (outbox) through signed webhooks.
-- Key format:  gdx_<prefix>_<secret>   — only the SHA-256 hash is stored,
-- the plaintext is shown once at creation.
-- ════════════════════════════════════════════════════════════════════════

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  prefix       text not null unique,
  key_hash     text not null,
  scopes       text[] not null default '{}',     -- e.g. {invoices:read, invoices:write, customers:read}
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table webhooks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  url         text not null check (url ~ '^https://'),
  secret      text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  events      text[] not null default '{*}',     -- exact names, 'invoice.*' prefixes or '*'
  active      boolean not null default true,
  description text,
  created_at  timestamptz not null default now()
);

create table webhook_deliveries (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  webhook_id      uuid not null references webhooks(id) on delete cascade,
  event_id        bigint not null references outbox(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending','success','failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status int,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index on webhook_deliveries(status, next_attempt_at) where status = 'pending';

-- fan out each new event to the org's matching webhooks
create or replace function enqueue_webhooks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into webhook_deliveries (org_id, webhook_id, event_id)
  select new.org_id, w.id, new.id
    from webhooks w
   where w.org_id = new.org_id and w.active
     and exists (select 1 from unnest(w.events) ev
                  where ev = '*' or ev = new.event_type
                     or (right(ev, 2) = '.*' and new.event_type like left(ev, -1) || '%'));
  return null;
end $$;
create trigger outbox_webhooks after insert on outbox
  for each row execute function enqueue_webhooks();

-- ── API keys ────────────────────────────────────────────────────────────
create or replace function create_api_key(p_name text, p_scopes text[], p_expires_at timestamptz default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('integrations.manage'); v_prefix text; v_secret text;
begin
  v_prefix := encode(extensions.gen_random_bytes(6), 'hex');
  v_secret := encode(extensions.gen_random_bytes(24), 'hex');
  insert into api_keys (org_id, name, prefix, key_hash, scopes, expires_at)
  values (v_org, p_name, v_prefix, encode(extensions.digest('gdx_' || v_prefix || '_' || v_secret, 'sha256'), 'hex'),
          coalesce(p_scopes, '{}'), p_expires_at);
  perform log_audit(v_org, 'api_key.create', 'api_key', v_prefix, jsonb_build_object('name', p_name, 'scopes', p_scopes));
  return 'gdx_' || v_prefix || '_' || v_secret;       -- shown once
end $$;

create or replace function revoke_api_key(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('integrations.manage');
begin
  update api_keys set revoked_at = now() where id = p_id and org_id = v_org and revoked_at is null;
  if not found then raise exception 'api key not found'; end if;
  perform log_audit(v_org, 'api_key.revoke', 'api_key', p_id::text);
end $$;

-- server-side only (service_role): resolve a presented key → org + scopes
create or replace function verify_api_key(p_key text)
returns table (key_id uuid, org_id uuid, scopes text[])
language plpgsql security definer set search_path = public as $$
declare v_prefix text := split_part(p_key, '_', 2); k api_keys%rowtype;
begin
  select * into k from api_keys a
   where a.prefix = v_prefix and a.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
     and a.revoked_at is null and (a.expires_at is null or a.expires_at > now());
  if not found then return; end if;
  if exists (select 1 from organizations o where o.id = k.org_id and o.status <> 'active') then return; end if;
  update api_keys set last_used_at = now() where id = k.id;
  return query select k.id, k.org_id, k.scopes;
end $$;

-- ── webhook dispatcher (service_role, called by the cron function) ─────
create or replace function claim_webhook_deliveries(p_limit int default 50)
returns table (delivery_id bigint, url text, secret text, event_type text, event_id bigint,
               org_id uuid, payload jsonb, created_at timestamptz, attempts int)
language sql security definer set search_path = public as $$
  with c as (
    select d.id from webhook_deliveries d
     where d.status = 'pending' and d.next_attempt_at <= now()
     order by d.id limit p_limit
     for update skip locked)
  update webhook_deliveries d set attempts = d.attempts + 1,
         next_attempt_at = now() + interval '5 minutes'     -- lease; overwritten by mark_*
    from c, webhooks w, outbox o
   where d.id = c.id and w.id = d.webhook_id and o.id = d.event_id
  returning d.id, w.url, w.secret, o.event_type, o.id, o.org_id,
            jsonb_build_object('id', o.id, 'type', o.event_type, 'org_id', o.org_id, 'entity', o.entity,
                               'entity_id', o.entity_id, 'data', o.payload, 'created_at', o.created_at),
            o.created_at, d.attempts
$$;

-- exponential backoff: 1m, 5m, 30m, 2h, 12h, then give up after 6 attempts
create or replace function mark_webhook_delivery(p_id bigint, p_ok boolean, p_status int, p_error text)
returns void language sql security definer set search_path = public as $$
  update webhook_deliveries set
    status = case when p_ok then 'success' when attempts >= 6 then 'failed' else 'pending' end,
    response_status = p_status, last_error = left(p_error, 1000),
    delivered_at = case when p_ok then now() end,
    next_attempt_at = now() + (array['1 minute','5 minutes','30 minutes','2 hours','12 hours','24 hours'])[least(attempts, 6)]::interval
  where id = p_id
$$;

revoke execute on function verify_api_key(text) from public, anon, authenticated;
revoke execute on function claim_webhook_deliveries(int) from public, anon, authenticated;
revoke execute on function mark_webhook_delivery(bigint, boolean, int, text) from public, anon, authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table api_keys enable row level security;
create policy api_keys_read on api_keys for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('integrations.manage'));
revoke insert, update, delete on api_keys from authenticated;
revoke select on api_keys from authenticated;
grant select (id, org_id, name, prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at)
  on api_keys to authenticated;

select apply_org_policies('webhooks', 'integrations.manage', 'integrations.manage');

alter table webhook_deliveries enable row level security;
create policy deliveries_read on webhook_deliveries for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('integrations.manage'));
