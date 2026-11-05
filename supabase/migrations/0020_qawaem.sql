-- GDXora · 0020 — Qawaem (المركز السعودي للأعمال) line map
--  • each account points at the line of the Qawaem statement it is reported
--    on: BS = statement of financial position (liquidity order),
--    PL = profit or loss (by function); line numbers are the platform's own
--  • defaults come from qawaem_default_line(): system_key first, then the
--    account's type and code; a company can override any account
--  • accounts the filing needs and the default chart lacked: loans (short
--    and long term), zakat payable, zakat expense, unpaid capital
--  • the cash-flow statement is derived from the BS lines in the report
--    (PP&E → investing, loans / capital → financing, the rest → operating)

create table qawaem_line_map (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  account_id  uuid not null references accounts(id) on delete cascade,
  statement   text not null check (statement in ('BS','PL')),
  line_no     int not null,
  sign        smallint not null default 1 check (sign in (1, -1)),   -- -1 flips the amount within its line
  updated_at  timestamptz not null default now(),
  unique (org_id, account_id),
  constraint qawaem_line_valid check (
    (statement = 'BS' and line_no in (2,3,4,5,6,7,8,9,10,11,12, 16,17,18,19,20,21,22, 25,26,27,28,30))
    or (statement = 'PL' and line_no in (2,3,4,6,7,8,9,12,13,14,15,18,19)))
);

create or replace function qawaem_line_map_guard()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from accounts where id = new.account_id and org_id = new.org_id and not is_group) then
    raise exception 'account not found or is a group account';
  end if;
  return new;
end $$;
-- "zchk" sorts after the org_id trigger from apply_org_policies, so org_id is filled first
create trigger qawaem_line_map_zchk before insert or update on qawaem_line_map
  for each row execute function qawaem_line_map_guard();
create trigger qawaem_line_map_upd_at before update on qawaem_line_map for each row execute function set_updated_at();

select apply_org_policies('qawaem_line_map', 'accounting.view', 'accounting.manage');

-- the line an account is reported on when the company has not chosen one
create or replace function qawaem_default_line(p_system_key text, p_code text, p_type text, out statement text, out line_no int)
language sql immutable as $$
  select x.s, x.n from (select case
    -- assets
    when p_system_key in ('cash','bank') then 'BS:2'
    when p_system_key in ('ar','retention_receivable','unbilled') then 'BS:3'
    when p_system_key = 'prepaid' then 'BS:4'
    when p_system_key in ('employee_advances','vat_input') then 'BS:12'
    when p_system_key in ('equipment','vehicles','furniture','accum_depreciation') then 'BS:7'
    -- liabilities
    when p_system_key in ('loans_short','loans_long') then 'BS:16'
    when p_system_key in ('ap','retention_payable') then 'BS:17'
    when p_system_key = 'zakat_payable' then 'BS:18'
    when p_system_key = 'vat_output' then 'BS:19'
    when p_system_key in ('salaries_payable','gosi_payable','accrued','customer_advances') then 'BS:20'
    when p_system_key = 'eosb_provision' then 'BS:21'
    -- equity (unpaid capital is a debit balance that reduces line 25)
    when p_system_key in ('capital','capital_unpaid') then 'BS:25'
    when p_system_key = 'retained_earnings' then 'BS:26'
    when p_system_key = 'partners_current' then 'BS:28'
    -- profit or loss
    when p_system_key in ('revenue_contracts','revenue_services') then 'PL:2'
    when p_system_key = 'revenue_other' then 'PL:9'
    when p_system_key = 'zakat_expense' then 'PL:18'
    when p_system_key like 'cost\_%' then 'PL:4'
    -- accounts a company added itself
    when p_type = 'asset' and p_code like '12%' then 'BS:7'
    when p_type = 'asset' then 'BS:12'
    when p_type = 'liability' then 'BS:20'
    when p_type = 'equity' then 'BS:28'
    when p_type = 'revenue' then 'PL:9'
    when p_type = 'expense' and p_code like '5%' then 'PL:4'
    when p_type = 'expense' then 'PL:13'
  end as v) d
  cross join lateral (select split_part(d.v, ':', 1) as s, split_part(d.v, ':', 2)::int as n) x
$$;

-- the accounts the filing needs that older charts lack (skipped when the code or key is taken)
create or replace function add_qawaem_accounts(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_parent uuid;
begin
  for r in select * from (values
    -- code,  parent, name_ar,                     name_en,                    type,        system_key
    ('2108', '21',   'قروض قصيرة الأجل',           'Short-term loans',         'liability', 'loans_short'),
    ('2109', '21',   'الزكاة المستحقة',            'Zakat payable',            'liability', 'zakat_payable'),
    ('2202', '22',   'قروض طويلة الأجل',           'Long-term loans',          'liability', 'loans_long'),
    ('3104', '3',    'رأس المال غير المدفوع',      'Unpaid capital',           'equity',    'capital_unpaid'),
    ('6110', '6',    'مصروف الزكاة',               'Zakat expense',            'expense',   'zakat_expense')
  ) as t(code, parent, name_ar, name_en, type, system_key)
  loop
    if exists (select 1 from accounts where org_id = p_org and (code = r.code or system_key = r.system_key)) then continue; end if;
    select id into v_parent from accounts where org_id = p_org and code = r.parent and is_group;
    insert into accounts (org_id, code, parent_id, name_ar, name_en, type, system_key)
    values (p_org, r.code, v_parent, r.name_ar, r.name_en, r.type, r.system_key);
  end loop;
end $$;
revoke execute on function add_qawaem_accounts(uuid) from public, anon, authenticated;

-- fill the map with the defaults for accounts that have no line yet
create or replace function seed_qawaem_map(p_org uuid)
returns void language sql security definer set search_path = public as $$
  insert into qawaem_line_map (org_id, account_id, statement, line_no)
  select a.org_id, a.id, d.statement, d.line_no
    from accounts a cross join lateral qawaem_default_line(a.system_key, a.code, a.type) d
   where a.org_id = p_org and not a.is_group
  on conflict (org_id, account_id) do nothing
$$;
revoke execute on function seed_qawaem_map(uuid) from public, anon, authenticated;

-- an account added later gets its default line
create or replace function accounts_qawaem_default()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.is_group then
    insert into qawaem_line_map (org_id, account_id, statement, line_no)
    select new.org_id, new.id, d.statement, d.line_no from qawaem_default_line(new.system_key, new.code, new.type) d
    on conflict (org_id, account_id) do nothing;
  end if;
  return null;
end $$;
create trigger accounts_qawaem after insert on accounts for each row execute function accounts_qawaem_default();

select add_qawaem_accounts(id) from organizations;
select seed_qawaem_map(id) from organizations;

-- new companies: as 0014, plus the Qawaem accounts (the map follows from the trigger)
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
  join default_role_permissions() r on p.key like r.pattern
  on conflict do nothing;

  insert into org_modules (org_id, module_key)
  select p_org, unnest(array['accounting','sales','finance','projects','hr','payroll','integrations'])
  on conflict do nothing;

  perform seed_default_coa(p_org);
  perform add_subscriptions_account(p_org);
  perform add_qawaem_accounts(p_org);

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
