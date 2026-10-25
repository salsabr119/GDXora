-- GDXora · 0019 — ZATCA phase 2 (integration): the e-invoice generation
-- solution unit (EGS) of each company, its key and CSIDs, and the result of
-- clearance / reporting for each invoice.
--
-- Secrets (private key, CSID secrets) are stored encrypted (AES-256-GCM, see
-- api/_zatca.js) and are readable only with the service role: authenticated
-- users have no privilege on zatca_egs at all — the app reads the safe
-- summary through zatca_onboarding_status().

create table zatca_egs (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  environment           text not null check (environment in ('sandbox','simulation','production')),
  status                text not null default 'pending' check (status in ('pending','active','failed','replaced')),
  egs_serial            uuid not null default gen_random_uuid(),
  unit_name             text not null,          -- CSR OU (branch / organisation unit)
  egs_name              text not null,          -- CSR CN
  private_key_enc       text,
  csr                   text,
  compliance_request_id text,
  compliance_cert       text,
  compliance_secret_enc text,
  production_cert       text,
  production_secret_enc text,
  cert_expires_at       timestamptz,
  checks                jsonb,                  -- compliance check results (per sample document)
  error                 text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  activated_at          timestamptz
);
create unique index zatca_egs_one_active on zatca_egs(org_id) where status = 'active';
alter table zatca_egs enable row level security;            -- no policies: service role only
revoke all on zatca_egs from anon, authenticated;

-- safe summary for the settings screen and the invoice flow
create or replace function zatca_onboarding_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not (has_perm('settings.manage') or has_perm('sales.view')) then null else coalesce((
    select jsonb_build_object('active', e.status = 'active', 'status', e.status, 'environment', e.environment,
                              'unit_name', e.unit_name, 'egs_name', e.egs_name, 'cert_expires_at', e.cert_expires_at,
                              'activated_at', e.activated_at, 'checks', e.checks, 'error', e.error, 'created_at', e.created_at)
      from zatca_egs e where e.org_id = current_org_id()
     order by (e.status = 'active') desc, e.created_at desc limit 1), jsonb_build_object('active', false)) end
$$;

-- result of clearance / reporting; a cleared invoice gets ZATCA's stamped XML and QR
create or replace function zatca_set_result(p_invoice uuid, p_status text, p_response jsonb, p_xml text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('sales.issue');
begin
  if p_status not in ('not_submitted','reported','cleared','warning','rejected') then raise exception 'invalid ZATCA status'; end if;
  update invoices set zatca_status = p_status, zatca_response = p_response,
                      zatca_xml = coalesce(p_xml, zatca_xml), zatca_qr = coalesce(p_qr, zatca_qr)
   where id = p_invoice and org_id = v_org and status = 'issued' and zatca_hash is not null
     and zatca_status not in ('cleared','reported');
  if not found then raise exception 'invoice not found, not signed yet, or already accepted by ZATCA'; end if;
end $$;
