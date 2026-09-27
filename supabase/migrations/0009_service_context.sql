-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0009 — Trusted server context for the public API
-- ════════════════════════════════════════════════════════════════════════
-- The public REST API (/api/v1) authenticates an org API key on the server,
-- then calls Supabase with the service_role key and the key's org in the
-- x-org-id header. Only the server holds the service key, so for that role
-- the header is trusted: every RPC (issue_invoice, trial_balance …) then runs
-- with exactly the same business rules as a signed-in user. API-key scopes
-- are enforced by the API layer before the call.
-- ════════════════════════════════════════════════════════════════════════

create or replace function request_role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;

create or replace function current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when request_role() = 'service_role' then
      (select o.id from organizations o where o.id = request_org_header() and o.status = 'active')
    else
      (select m.org_id from org_members m
        where m.org_id = request_org_header() and m.user_id = auth.uid() and m.active)
  end
$$;

create or replace function has_perm(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when request_role() = 'service_role' then current_org_id() is not null
    else exists (
      select 1 from org_members m
       where m.org_id = current_org_id() and m.user_id = auth.uid() and m.active
         and (m.is_owner or exists (
               select 1 from role_permissions rp
                where rp.org_id = m.org_id and rp.role_key = m.role_key and rp.perm_key = p_perm)))
  end
$$;
