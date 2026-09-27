-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0008 — Onboarding: create a company, invite members
-- ════════════════════════════════════════════════════════════════════════
-- create_organization() is the single entry point for a new tenant (self
-- sign-up now, billing plans later). It seeds everything a Saudi services
-- company needs on day one: roles, chart of accounts, VAT codes, fiscal
-- periods, numbering, payroll & ZATCA settings.
-- ════════════════════════════════════════════════════════════════════════

create or replace function seed_org_defaults(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare y int := extract(year from current_date)::int; m int;
begin
  -- roles (the owner bypasses role checks)
  insert into roles (org_id, key, name_ar, name_en) values
    (p_org, 'admin',           'مدير النظام',        'Administrator'),
    (p_org, 'accountant',      'محاسب',              'Accountant'),
    (p_org, 'finance_manager', 'المدير المالي',      'Finance manager'),
    (p_org, 'sales',           'مسؤول مبيعات',       'Sales officer'),
    (p_org, 'project_manager', 'مدير مشروع',         'Project manager'),
    (p_org, 'hr',              'موارد بشرية',        'HR officer'),
    (p_org, 'viewer',          'اطلاع فقط',          'Viewer')
  on conflict do nothing;

  insert into role_permissions (org_id, role_key, perm_key)
  select p_org, r.role_key, p.key from permissions p
  join (values
    ('admin',           '%'),
    ('accountant',      'accounting.view'), ('accountant', 'accounting.manage'), ('accountant', 'accounting.post'),
    ('accountant',      'sales.view'), ('accountant', 'sales.manage'), ('accountant', 'sales.issue'),
    ('accountant',      'finance.view'), ('accountant', 'finance.manage'),
    ('accountant',      'projects.view'), ('accountant', 'payroll.view'),
    ('finance_manager', 'accounting.%'), ('finance_manager', 'sales.%'), ('finance_manager', 'finance.%'),
    ('finance_manager', 'projects.view'), ('finance_manager', 'payroll.view'), ('finance_manager', 'payroll.approve'),
    ('finance_manager', 'audit.view'),
    ('sales',           'sales.view'), ('sales', 'sales.manage'), ('sales', 'sales.issue'), ('sales', 'projects.view'),
    ('project_manager', 'projects.%'), ('project_manager', 'sales.view'), ('project_manager', 'finance.view'),
    ('project_manager', 'hr.view'),
    ('hr',              'hr.%'), ('hr', 'payroll.view'), ('hr', 'payroll.manage'), ('hr', 'projects.view'),
    ('viewer',          '%.view')
  ) as r(role_key, pattern) on p.key like r.pattern
  on conflict do nothing;

  insert into org_modules (org_id, module_key)
  select p_org, unnest(array['accounting','sales','finance','projects','hr','payroll','integrations'])
  on conflict do nothing;

  perform seed_default_coa(p_org);

  insert into tax_codes (org_id, code, name_ar, name_en, rate, category, exemption_code, exemption_reason) values
    (p_org, 'VAT15',   'ضريبة القيمة المضافة 15%',     'VAT 15%',                    15, 'S', null, null),
    (p_org, 'ZR-EXP',  'صفرية — تصدير خدمات',          'Zero-rated — export of services', 0, 'Z', 'VATEX-SA-33', 'Export of services'),
    (p_org, 'ZR-GDS',  'صفرية — تصدير سلع',            'Zero-rated — export of goods',    0, 'Z', 'VATEX-SA-32', 'Export of goods'),
    (p_org, 'EX-FIN',  'معفاة — خدمات مالية',          'Exempt — financial services',     0, 'E', 'VATEX-SA-29', 'Financial services'),
    (p_org, 'EX-RE',   'معفاة — توريد عقار سكني',      'Exempt — residential real estate',0, 'E', 'VATEX-SA-30', 'Real estate transactions'),
    (p_org, 'OOS',     'خارج نطاق الضريبة',            'Out of scope',                    0, 'O', 'VATEX-SA-OOS', 'Out of scope')
  on conflict do nothing;

  -- monthly fiscal periods for the current year
  for m in 1..12 loop
    insert into fiscal_periods (org_id, name, start_date, end_date)
    values (p_org, to_char(make_date(y, m, 1), 'YYYY-MM'), make_date(y, m, 1),
            (make_date(y, m, 1) + interval '1 month - 1 day')::date)
    on conflict do nothing;
  end loop;

  insert into doc_sequences (org_id, doc_type, prefix) values
    (p_org, 'JV', 'JV-'), (p_org, 'INV', 'INV-'), (p_org, 'CN', 'CN-'), (p_org, 'DN', 'DN-'),
    (p_org, 'BIL', 'BIL-'), (p_org, 'RV', 'RV-'), (p_org, 'PV', 'PV-'), (p_org, 'PAY', 'PAY-'),
    (p_org, 'CUS', 'CUS-'), (p_org, 'VEN', 'VEN-'), (p_org, 'PRJ', 'PRJ-'), (p_org, 'EMP', 'EMP-'),
    (p_org, 'ITM', 'ITM-')
  on conflict do nothing;

  insert into payroll_settings (org_id) values (p_org) on conflict do nothing;
  insert into zatca_state (org_id) values (p_org) on conflict do nothing;
end $$;

create or replace function create_organization(p_name_ar text, p_name_en text default null,
                                               p_vat_number text default null, p_cr_number text default null,
                                               p_full_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if coalesce(trim(p_name_ar), '') = '' then raise exception 'company name is required'; end if;

  insert into organizations (name_ar, name_en, vat_number, cr_number)
  values (trim(p_name_ar), nullif(trim(p_name_en), ''), nullif(trim(p_vat_number), ''), nullif(trim(p_cr_number), ''))
  returning id into v_org;

  perform seed_org_defaults(v_org);

  insert into org_members (org_id, user_id, role_key, is_owner, full_name, email)
  select v_org, u.id, 'admin', true, coalesce(p_full_name, u.raw_user_meta_data->>'full_name', u.email), u.email
    from auth.users u where u.id = auth.uid();

  insert into audit_log (org_id, actor_id, action, entity, entity_id)
  values (v_org, auth.uid(), 'org.create', 'organization', v_org::text);
  perform emit_event(v_org, 'organization.created', 'organization', v_org, jsonb_build_object('name', p_name_ar));
  return v_org;
end $$;

-- add an existing user (by e-mail) to the current org; invitations for new
-- e-mails go through the server function /api/members/invite
create or replace function add_member(p_email text, p_role text, p_full_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('users.manage'); v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'no user with this e-mail — send an invitation'; end if;
  if not exists (select 1 from roles where org_id = v_org and key = p_role) then raise exception 'unknown role'; end if;
  insert into org_members (org_id, user_id, role_key, full_name, email)
  select v_org, u.id, p_role, coalesce(p_full_name, u.raw_user_meta_data->>'full_name', u.email), u.email
    from auth.users u where u.id = v_user
  on conflict (org_id, user_id) do update set role_key = excluded.role_key, active = true,
                                              full_name = coalesce(excluded.full_name, org_members.full_name);
  perform log_audit(v_org, 'member.add', 'org_member', v_user::text, jsonb_build_object('role', p_role));
  return v_user;
end $$;

-- the current user's orgs with their role — feeds the org switcher
create or replace function my_organizations()
returns table (org_id uuid, name_ar text, name_en text, role_key text, is_owner boolean)
language sql stable security definer set search_path = public as $$
  select o.id, o.name_ar, o.name_en, m.role_key, m.is_owner
    from org_members m join organizations o on o.id = m.org_id
   where m.user_id = auth.uid() and m.active and o.status = 'active'
   order by o.name_ar
$$;

-- permissions of the current user in the current org (UI gating only; the DB enforces)
create or replace function my_permissions()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.key order by p.key), '{}')
    from permissions p where has_perm(p.key)
$$;

-- internal helpers must not be callable by clients
revoke execute on function seed_org_defaults(uuid)   from public, anon, authenticated;
revoke execute on function seed_default_coa(uuid)    from public, anon, authenticated;
revoke execute on function gl_post(uuid, date, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function _post_entry(uuid)          from public, anon, authenticated;
revoke execute on function _reverse_entry(uuid, date, text) from public, anon, authenticated;
revoke execute on function next_doc_number(uuid, text) from public, anon, authenticated;
revoke execute on function log_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function emit_event(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function apply_org_policies(text, text, text) from public, anon, authenticated;
revoke execute on function refresh_payroll_totals(uuid) from public, anon, authenticated;
revoke execute on function recalc_invoice(uuid) from public, anon, authenticated;
