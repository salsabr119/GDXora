-- GDXora · 0014 — Permissions
--  • salaries and bank details move to employee_pay behind a new permission
--    hr.salaries (payroll viewers can read them too, they see the amounts in
--    the payroll anyway); employees without it see names and jobs only
--  • default roles no longer see other departments' data
--  • name-only lookups (projects, customers, employees) so a form in one
--    module can offer a dropdown without opening another module's records
--  • save_employees(): one atomic call for the form and the Excel import

insert into permissions (key, module, name_ar, name_en) values
  ('hr.salaries', 'hr', 'عرض وتعديل الرواتب وبيانات البنك', 'View & edit salaries and bank details')
on conflict do nothing;

-- ── salaries ────────────────────────────────────────────────────────────
create table employee_pay (
  employee_id         uuid primary key references employees(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  basic_salary        numeric(18,2) not null default 0 check (basic_salary >= 0),
  housing_allowance   numeric(18,2) not null default 0 check (housing_allowance >= 0),
  transport_allowance numeric(18,2) not null default 0 check (transport_allowance >= 0),
  other_allowances    numeric(18,2) not null default 0 check (other_allowances >= 0),
  bank_name           text,
  iban                text constraint employee_pay_iban check (iban is null or iban ~ '^SA[0-9]{22}$'),
  updated_at          timestamptz not null default now()
);
insert into employee_pay (employee_id, org_id, basic_salary, housing_allowance, transport_allowance, other_allowances, bank_name, iban)
select id, org_id, basic_salary, housing_allowance, transport_allowance, other_allowances, bank_name, iban from employees;

alter table employee_pay enable row level security;
create policy employee_pay_read on employee_pay for select to authenticated
  using (org_id = (select current_org_id()) and (has_perm('hr.salaries') or has_perm('payroll.view')));
create policy employee_pay_ins on employee_pay for insert to authenticated
  with check (org_id = (select current_org_id()) and has_perm('hr.salaries'));
create policy employee_pay_upd on employee_pay for update to authenticated
  using (org_id = (select current_org_id()) and has_perm('hr.salaries'))
  with check (org_id = (select current_org_id()) and has_perm('hr.salaries'));
create policy employee_pay_del on employee_pay for delete to authenticated
  using (org_id = (select current_org_id()) and has_perm('hr.salaries'));
create trigger employee_pay_org before insert or update on employee_pay for each row execute function enforce_org_id();
create trigger employee_pay_upd_at before update on employee_pay for each row execute function set_updated_at();

create or replace function generate_payroll(p_period text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('payroll.manage');
  s payroll_settings%rowtype; v_run uuid; v_start date; v_end date; e record;
  v_emp_days numeric; v_unpaid numeric; v_factor numeric; v_wage numeric; v_ann numeric;
begin
  insert into payroll_settings (org_id) values (v_org) on conflict do nothing;
  select * into s from payroll_settings where org_id = v_org;
  v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month' - interval '1 day')::date;

  if exists (select 1 from payroll_runs where org_id = v_org and period = p_period) then
    raise exception 'payroll run for % already exists', p_period;
  end if;
  insert into payroll_runs (org_id, period, period_start, period_end)
  values (v_org, p_period, v_start, v_end) returning id into v_run;

  for e in select emp.*, coalesce(pay.basic_salary, 0) as basic_salary, coalesce(pay.housing_allowance, 0) as housing_allowance,
                  coalesce(pay.transport_allowance, 0) as transport_allowance, coalesce(pay.other_allowances, 0) as other_allowances
             from employees emp left join employee_pay pay on pay.employee_id = emp.id
            where emp.org_id = v_org and hire_date <= v_end
              and (termination_date is null or termination_date >= v_start)
              and not (status = 'terminated' and termination_date is null)
            order by emp.code
  loop
    -- days employed within the month on a 30-day basis
    v_emp_days := least(s.month_days,
                        (least(coalesce(e.termination_date, v_end), v_end) - greatest(e.hire_date, v_start) + 1)
                        * s.month_days::numeric / (v_end - v_start + 1));
    if greatest(e.hire_date, v_start) = v_start and least(coalesce(e.termination_date, v_end), v_end) = v_end then
      v_emp_days := s.month_days;
    end if;
    select coalesce(sum(least(end_date, v_end) - greatest(start_date, v_start) + 1), 0) into v_unpaid
      from leave_requests
     where employee_id = e.id and status = 'approved' and leave_type = 'unpaid'
       and start_date <= v_end and end_date >= v_start;
    v_unpaid := least(v_unpaid, v_emp_days);
    v_factor := (v_emp_days - v_unpaid) / s.month_days;

    v_wage := case when e.gosi_registered
                   then least(greatest(e.basic_salary + e.housing_allowance, s.gosi_min_wage), s.gosi_max_wage)
                   else 0 end;
    v_ann := gosi_annuity_rate(e.gosi_scheme, v_end, s.legacy_annuity_rate);
    -- partial month (joined/left mid-month): contributions follow the days employed
    v_wage := round(v_wage * v_emp_days / s.month_days, 2);

    insert into payroll_lines (org_id, run_id, employee_id, project_id, is_saudi, worked_days, unpaid_days,
                               basic, housing, transport, other_allowances, gosi_wage, gosi_employee, gosi_employer)
    values (v_org, v_run, e.id, e.project_id, e.is_saudi, round(v_emp_days - v_unpaid, 2), v_unpaid,
            round(e.basic_salary * v_factor, 2), round(e.housing_allowance * v_factor, 2),
            round(e.transport_allowance * v_factor, 2), round(e.other_allowances * v_factor, 2),
            v_wage,
            case when e.is_saudi then round(v_wage * (v_ann + s.saned_rate) / 100, 2) else 0 end,
            case when e.is_saudi then round(v_wage * (v_ann + s.saned_rate + s.hazards_rate) / 100, 2)
                 else round(v_wage * s.hazards_rate / 100, 2) end);
  end loop;

  perform log_audit(v_org, 'payroll.generate', 'payroll_run', v_run::text, jsonb_build_object('period', p_period));
  return v_run;
end $$;

-- EOSB from the stored wage (needs read access to the salary)
create or replace function employee_eosb(p_employee uuid, p_end date default current_date, p_reason text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare e employees%rowtype; p employee_pay%rowtype; v_wage numeric; v_reason text;
begin
  select * into e from employees where id = p_employee and org_id = current_org_id();
  if not found then raise exception 'employee not found'; end if;
  select * into p from employee_pay where employee_id = p_employee;
  if not found then raise exception 'permission denied: hr.salaries' using errcode = '42501'; end if;
  v_wage := p.basic_salary + p.housing_allowance + p.transport_allowance + p.other_allowances;
  v_reason := coalesce(p_reason, e.termination_reason, 'employer_termination');
  return jsonb_build_object(
    'wage', v_wage, 'years', round((coalesce(p_end, current_date) - e.hire_date + 1) / 365.0, 3),
    'reason', v_reason, 'amount', eosb_amount(v_wage, e.hire_date, coalesce(p_end, current_date), v_reason));
end $$;

alter table employees drop column basic_salary, drop column housing_allowance, drop column transport_allowance,
                      drop column other_allowances, drop column bank_name, drop column iban;

-- create / update employees with their pay in one transaction
--   p_rows: [{ id?, ...employees columns, basic_salary?, housing_allowance?, transport_allowance?, other_allowances?, bank_name?, iban? }]
-- pay fields need hr.salaries; without it they must be absent
create or replace function save_employees(p_rows jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('hr.manage'); r jsonb; v_id uuid; v_ids uuid[] := '{}';
  pay_keys text[] := array['basic_salary','housing_allowance','transport_allowance','other_allowances','bank_name','iban'];
  emp_cols text[]; v_set text; v_has_pay boolean;
begin
  select array_agg(column_name::text) into emp_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'employees'
     and column_name not in ('id','org_id','is_saudi','created_at','updated_at','user_id');
  for r in select * from jsonb_array_elements(p_rows) loop
    v_has_pay := r ?| pay_keys;
    if v_has_pay and not has_perm('hr.salaries') then raise exception 'permission denied: hr.salaries' using errcode = '42501'; end if;
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is null then
      execute format('insert into employees (org_id, %s) select $1, %s from jsonb_populate_record(null::employees, $2) returning id',
                     (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(r) k where k = any(emp_cols)),
                     (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(r) k where k = any(emp_cols)))
        into v_id using v_org, r;
    else
      if not exists (select 1 from employees where id = v_id and org_id = v_org) then raise exception 'employee not found'; end if;
      select string_agg(format('%1$I = x.%1$I', k), ', ') into v_set from jsonb_object_keys(r) k where k = any(emp_cols);
      if v_set is not null then
        execute format('update employees e set %s from jsonb_populate_record(null::employees, $1) x where e.id = $2', v_set) using r, v_id;
      end if;
    end if;
    if v_has_pay then
      insert into employee_pay (employee_id, org_id) values (v_id, v_org) on conflict (employee_id) do nothing;
      select string_agg(format('%1$I = x.%1$I', k), ', ') into v_set from jsonb_object_keys(r) k where k = any(pay_keys);
      execute format('update employee_pay p set %s from jsonb_populate_record(null::employee_pay, $1) x where p.employee_id = $2', v_set) using r, v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end $$;

-- payroll viewers (e.g. the finance manager approving a run) need the names on the run
create policy employees_read_payroll on employees for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('payroll.view'));

-- project profitability for project managers, who do not open the general ledger
create or replace function project_summary(p_project uuid default null)
returns table (project_id uuid, code text, name_ar text, contract_value numeric,
               budget numeric, revenue numeric, cost numeric, profit numeric, margin_pct numeric)
language sql stable security definer set search_path = public as $$
  with gl as (
    select l.project_id,
           sum(case when a.type = 'revenue' then l.credit - l.debit else 0 end) as revenue,
           sum(case when a.type = 'expense' then l.debit - l.credit else 0 end) as cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.org_id = current_org_id() and e.status in ('posted','reversed') and l.project_id is not null
     group by l.project_id),
  bud as (select project_id, sum(amount) as budget from project_budget_lines where org_id = current_org_id() group by project_id)
  select p.id, p.code, p.name_ar, p.contract_value, coalesce(b.budget,0),
         coalesce(g.revenue,0), coalesce(g.cost,0), coalesce(g.revenue,0) - coalesce(g.cost,0),
         case when coalesce(g.revenue,0) = 0 then null
              else round((coalesce(g.revenue,0) - coalesce(g.cost,0)) / g.revenue * 100, 1) end
    from projects p
    left join gl g on g.project_id = p.id
    left join bud b on b.project_id = p.id
   where p.org_id = current_org_id() and (p_project is null or p.id = p_project)
     and (has_perm('projects.view') or has_perm('accounting.view'))
   order by p.code
$$;

-- ── name-only lookups for dropdowns in other modules ────────────────────
create or replace function lookup_projects()
returns table (id uuid, code text, name_ar text, name_en text, customer_id uuid, status text, retention_pct numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.code, p.name_ar, p.name_en, p.customer_id, p.status, p.retention_pct from projects p
   where p.org_id = current_org_id()
     and (has_perm('projects.view') or has_perm('sales.view') or has_perm('finance.view') or has_perm('accounting.view')
          or has_perm('hr.view') or has_perm('payroll.view'))
   order by p.code
$$;
create or replace function lookup_customers()
returns table (id uuid, code text, name_ar text, name_en text, vat_number text)
language sql stable security definer set search_path = public as $$
  select c.id, c.code, c.name_ar, c.name_en, c.vat_number from customers c
   where c.org_id = current_org_id() and c.active
     and (has_perm('sales.view') or has_perm('projects.view') or has_perm('accounting.view') or has_perm('finance.view'))
   order by c.name_ar
$$;
create or replace function lookup_employees()
returns table (id uuid, code text, first_name_ar text, last_name_ar text, status text)
language sql stable security definer set search_path = public as $$
  select e.id, e.code, e.first_name_ar, e.last_name_ar, e.status from employees e
   where e.org_id = current_org_id()
     and (has_perm('hr.view') or has_perm('payroll.view') or has_perm('accounting.view') or has_perm('finance.view'))
   order by e.code
$$;

-- ── default roles: each department sees its own module only ─────────────
create or replace function default_role_permissions()
returns table (role_key text, pattern text) language sql immutable as $$
  values ('admin', '%'),
    ('accountant', 'accounting.view'), ('accountant', 'accounting.manage'), ('accountant', 'accounting.post'),
    ('accountant', 'sales.view'), ('accountant', 'sales.manage'), ('accountant', 'sales.issue'),
    ('accountant', 'finance.view'), ('accountant', 'finance.manage'),
    ('finance_manager', 'accounting.%'), ('finance_manager', 'sales.%'), ('finance_manager', 'finance.%'),
    ('finance_manager', 'payroll.view'), ('finance_manager', 'payroll.approve'), ('finance_manager', 'audit.view'),
    ('sales', 'sales.view'), ('sales', 'sales.manage'), ('sales', 'sales.issue'),
    ('project_manager', 'projects.%'),
    ('hr', 'hr.%'), ('hr', 'payroll.view'), ('hr', 'payroll.manage'),
    ('viewer', '%.view')
$$;

-- existing companies: drop the cross-department grants of the old defaults
-- (only the exact old default pairs — permissions an owner added stay)
delete from role_permissions rp using (values
    ('accountant', 'projects.view'), ('accountant', 'payroll.view'), ('finance_manager', 'projects.view'),
    ('sales', 'projects.view'), ('project_manager', 'sales.view'), ('project_manager', 'finance.view'),
    ('project_manager', 'hr.view'), ('hr', 'projects.view')) as old(role_key, perm_key)
 where rp.role_key = old.role_key and rp.perm_key = old.perm_key;
-- and give hr / admin the new salary permission
insert into role_permissions (org_id, role_key, perm_key)
select r.org_id, r.key, 'hr.salaries' from roles r where r.key in ('admin', 'hr')
on conflict do nothing;

-- software & IT subscriptions (Microsoft 365, domains, SaaS) — a common
-- overhead that had no account of its own
create or replace function add_subscriptions_account(p_org uuid)
returns void language sql security definer set search_path = public as $$
  insert into accounts (org_id, code, parent_id, name_ar, name_en, type, system_key)
  select p_org, '6109', g.id, 'اشتراكات البرامج والتقنية', 'Software & IT subscriptions', 'expense', 'subscriptions'
    from accounts g where g.org_id = p_org and g.code = '6'
     and not exists (select 1 from accounts where org_id = p_org and (code = '6109' or system_key = 'subscriptions'))
$$;
revoke execute on function add_subscriptions_account(uuid) from public, anon, authenticated;
select add_subscriptions_account(id) from organizations;

-- new companies get the strict roles and the subscriptions account
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
