-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0006 — HR & payroll (Saudi Arabia)
-- ════════════════════════════════════════════════════════════════════════
-- • GOSI: contribution wage = basic + housing, clamped to [min, max].
--   Saudi: annuity (employee & employer) + SANED (both) + occupational
--   hazards (employer). Non-Saudi: occupational hazards (employer) only.
--   Employees who first registered under the 2024 Social Insurance Law
--   (gosi_scheme = 'new') follow the gradual annuity schedule below.
--   All rates are data (payroll_settings / gosi_annuity_schedule) so they
--   can be updated without code changes — VERIFY against GOSI before go-live.
-- • End of service (Labour Law art. 84/85): half a month's wage per year for
--   the first five years, a full month per year after; resignation reduces it
--   (<2y none, 2–5y ⅓, 5–10y ⅔, ≥10y full).
-- • Payroll uses a 30-day month for proration (common Saudi practice); GOSI is
--   prorated by days employed in the month (joiners/leavers), not by unpaid leave.
-- ════════════════════════════════════════════════════════════════════════

create table departments (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references organizations(id) on delete cascade,
  name_ar  text not null,
  name_en  text,
  unique (org_id, name_ar)
);

create table employees (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  code                text,
  user_id             uuid references auth.users(id),       -- optional self-service login
  first_name_ar       text not null,
  last_name_ar        text not null,
  first_name_en       text,
  last_name_en        text,
  nationality         text not null default 'SA',
  is_saudi            boolean generated always as (nationality = 'SA') stored,
  national_id         text,              -- national ID (Saudi) or Iqama number
  id_expiry           date,
  passport_no         text,
  passport_expiry     date,
  birth_date          date,
  gender              text check (gender in ('male','female')),
  phone               text,
  email               text,
  department_id       uuid references departments(id),
  project_id          uuid references projects(id),         -- default cost allocation
  job_title           text,
  hire_date           date not null,
  contract_type       text not null default 'unlimited' check (contract_type in ('limited','unlimited')),
  contract_end_date   date,
  status              text not null default 'active' check (status in ('active','on_leave','terminated')),
  termination_date    date,
  termination_reason  text check (termination_reason in ('resignation','employer_termination','contract_end',
                                                          'mutual','article_80','article_87','death','retirement')),
  -- compensation (monthly, SAR)
  basic_salary        numeric(18,2) not null default 0 check (basic_salary >= 0),
  housing_allowance   numeric(18,2) not null default 0 check (housing_allowance >= 0),
  transport_allowance numeric(18,2) not null default 0 check (transport_allowance >= 0),
  other_allowances    numeric(18,2) not null default 0 check (other_allowances >= 0),
  gosi_registered     boolean not null default true,
  gosi_scheme         text not null default 'legacy' check (gosi_scheme in ('legacy','new')),
  gosi_number         text,
  bank_name           text,
  iban                text check (iban is null or iban ~ '^SA[0-9]{22}$'),
  annual_leave_days   int not null default 21,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, code),
  check (termination_date is null or termination_date >= hire_date)
);
create index on employees(org_id, status);

create table leave_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  employee_id  uuid not null references employees(id) on delete cascade,
  leave_type   text not null check (leave_type in ('annual','sick','unpaid','maternity','hajj','marriage','bereavement','other')),
  start_date   date not null,
  end_date     date not null,
  days         int generated always as (end_date - start_date + 1) stored,
  status       text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  notes        text,
  decided_by   uuid,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (end_date >= start_date)
);
create index on leave_requests(employee_id, start_date);

create table payroll_settings (
  org_id              uuid primary key references organizations(id) on delete cascade,
  gosi_min_wage       numeric(18,2) not null default 1500,
  gosi_max_wage       numeric(18,2) not null default 45000,
  legacy_annuity_rate numeric(5,2)  not null default 9.00,   -- % each side
  saned_rate          numeric(5,2)  not null default 0.75,   -- % each side (Saudi)
  hazards_rate        numeric(5,2)  not null default 2.00,   -- % employer (all)
  month_days          int           not null default 30,
  labour_cost_to_projects boolean   not null default true    -- post project staff salaries to project labour cost
);

-- annuity rate (% each side) for employees under the 2024 law, by effective date
create table gosi_annuity_schedule (
  effective_from date primary key,
  rate           numeric(5,2) not null
);
insert into gosi_annuity_schedule values
  ('2024-07-03', 9.00), ('2025-07-01', 9.50), ('2026-07-01', 10.00),
  ('2027-07-01', 10.50), ('2028-07-01', 11.00);

create table payroll_runs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  number           text,
  period           text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  period_start     date not null,
  period_end       date not null,
  status           text not null default 'draft' check (status in ('draft','approved','posted')),
  employees_count  int not null default 0,
  total_gross      numeric(18,2) not null default 0,
  total_gosi_employee numeric(18,2) not null default 0,
  total_gosi_employer numeric(18,2) not null default 0,
  total_deductions numeric(18,2) not null default 0,
  total_net        numeric(18,2) not null default 0,
  journal_entry_id uuid references journal_entries(id),
  approved_by      uuid,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (org_id, period)
);

create table payroll_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  run_id            uuid not null references payroll_runs(id) on delete cascade,
  employee_id       uuid not null references employees(id),
  project_id        uuid references projects(id),
  is_saudi          boolean not null,
  worked_days       numeric(5,2) not null default 30,
  unpaid_days       numeric(5,2) not null default 0,
  basic             numeric(18,2) not null default 0,
  housing           numeric(18,2) not null default 0,
  transport         numeric(18,2) not null default 0,
  other_allowances  numeric(18,2) not null default 0,
  overtime          numeric(18,2) not null default 0 check (overtime >= 0),
  additions         numeric(18,2) not null default 0 check (additions >= 0),
  gosi_wage         numeric(18,2) not null default 0,
  gosi_employee     numeric(18,2) not null default 0,
  gosi_employer     numeric(18,2) not null default 0,
  advance_deduction numeric(18,2) not null default 0 check (advance_deduction >= 0),
  other_deductions  numeric(18,2) not null default 0 check (other_deductions >= 0),
  gross             numeric(18,2) not null default 0,
  net               numeric(18,2) not null default 0,
  notes             text,
  unique (run_id, employee_id)
);

-- ── rates & formulas ────────────────────────────────────────────────────
create or replace function gosi_annuity_rate(p_scheme text, p_on date, p_legacy numeric)
returns numeric language sql stable as $$
  select case when p_scheme = 'new'
              then coalesce((select rate from gosi_annuity_schedule where effective_from <= p_on
                              order by effective_from desc limit 1), p_legacy)
              else p_legacy end
$$;

-- end-of-service award (pure function; mirrored by app/src/lib/payroll.js)
create or replace function eosb_amount(p_monthly_wage numeric, p_start date, p_end date, p_reason text)
returns numeric language plpgsql immutable as $$
declare v_years numeric; v_full numeric; v_factor numeric := 1;
begin
  if p_end < p_start then return 0; end if;
  v_years := (p_end - p_start + 1) / 365.0;
  v_full := case when v_years <= 5 then v_years * p_monthly_wage / 2
                 else 5 * p_monthly_wage / 2 + (v_years - 5) * p_monthly_wage end;
  if p_reason = 'resignation' then
    v_factor := case when v_years < 2 then 0 when v_years < 5 then 1.0/3
                     when v_years < 10 then 2.0/3 else 1 end;
  elsif p_reason = 'article_80' then
    v_factor := 0;                       -- dismissal for cause
  end if;
  return round(v_full * v_factor, 2);
end $$;

create or replace function employee_eosb(p_employee uuid, p_end date default current_date, p_reason text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare e employees%rowtype; v_wage numeric; v_reason text;
begin
  select * into e from employees where id = p_employee and org_id = current_org_id();
  if not found then raise exception 'employee not found'; end if;
  v_wage := e.basic_salary + e.housing_allowance + e.transport_allowance + e.other_allowances;
  v_reason := coalesce(p_reason, e.termination_reason, 'employer_termination');
  return jsonb_build_object(
    'wage', v_wage, 'years', round((coalesce(p_end, current_date) - e.hire_date + 1) / 365.0, 3),
    'reason', v_reason, 'amount', eosb_amount(v_wage, e.hire_date, coalesce(p_end, current_date), v_reason));
end $$;

-- recompute a payroll line from its components
create or replace function compute_payroll_line()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from payroll_runs where id = new.run_id and status <> 'draft') then
    raise exception 'payroll run is not a draft';
  end if;
  new.gross := new.basic + new.housing + new.transport + new.other_allowances + new.overtime + new.additions;
  new.net := new.gross - new.gosi_employee - new.advance_deduction - new.other_deductions;
  if new.net < 0 then raise exception 'net salary cannot be negative for employee %', new.employee_id; end if;
  return new;
end $$;
create trigger payroll_lines_compute before insert or update on payroll_lines
  for each row execute function compute_payroll_line();

create or replace function payroll_lines_guard_delete()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from payroll_runs where id = old.run_id and status <> 'draft') then
    raise exception 'payroll run is not a draft';
  end if;
  return old;
end $$;
create trigger payroll_lines_del before delete on payroll_lines
  for each row execute function payroll_lines_guard_delete();

create or replace function refresh_payroll_totals(p_run uuid)
returns void language sql security definer set search_path = public as $$
  update payroll_runs r set
    employees_count = s.n, total_gross = s.g, total_gosi_employee = s.ge, total_gosi_employer = s.gr,
    total_deductions = s.d, total_net = s.net
  from (select count(*) n, coalesce(sum(gross),0) g, coalesce(sum(gosi_employee),0) ge,
               coalesce(sum(gosi_employer),0) gr, coalesce(sum(advance_deduction + other_deductions),0) d,
               coalesce(sum(net),0) net
          from payroll_lines where run_id = p_run) s
  where r.id = p_run
$$;

create or replace function payroll_lines_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform refresh_payroll_totals(coalesce(new.run_id, old.run_id)); return null; end $$;
create trigger payroll_lines_totals after insert or update or delete on payroll_lines
  for each row execute function payroll_lines_touch();

-- ── generate a monthly payroll run ──────────────────────────────────────
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

  for e in select * from employees
            where org_id = v_org and hire_date <= v_end
              and (termination_date is null or termination_date >= v_start)
              and not (status = 'terminated' and termination_date is null)
            order by code
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

create or replace function approve_payroll(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('payroll.approve');
begin
  update payroll_runs set status = 'approved', approved_by = auth.uid(), approved_at = now(),
                          number = coalesce(number, next_doc_number(v_org, 'PAY'))
   where id = p_run and org_id = v_org and status = 'draft';
  if not found then raise exception 'draft payroll run not found'; end if;
  if not exists (select 1 from payroll_lines where run_id = p_run) then raise exception 'payroll run has no lines'; end if;
  perform log_audit(v_org, 'payroll.approve', 'payroll_run', p_run::text);
end $$;

-- post an approved run: Dr salaries (or project labour) + GOSI employer expense /
-- Cr GOSI payable, salaries payable, employee advances; deductions reduce the expense
create or replace function post_payroll(p_run uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('payroll.approve');
  r payroll_runs%rowtype; s payroll_settings%rowtype; v_lines jsonb := '[]'::jsonb; x record; v_je uuid;
begin
  select * into r from payroll_runs where id = p_run and org_id = v_org for update;
  if not found or r.status <> 'approved' then raise exception 'approved payroll run not found'; end if;
  select * into s from payroll_settings where org_id = v_org;

  for x in select case when s.labour_cost_to_projects and project_id is not null then 'cost_labour' else 'salaries_expense' end as acc,
                  project_id, sum(gross - other_deductions) amt, sum(gosi_employer) gosi
             from payroll_lines where run_id = p_run group by 1, 2 loop
    v_lines := v_lines
      || jsonb_build_object('account_key', x.acc, 'debit', x.amt, 'project_id', x.project_id, 'description', 'رواتب ' || r.period)
      || jsonb_build_object('account_key', 'gosi_expense', 'debit', x.gosi, 'project_id', x.project_id, 'description', 'تأمينات ' || r.period);
  end loop;
  v_lines := v_lines
    || jsonb_build_object('account_key','gosi_payable','credit', r.total_gosi_employee + r.total_gosi_employer, 'description', 'تأمينات ' || r.period)
    || jsonb_build_object('account_key','employee_advances','credit',
                          (select coalesce(sum(advance_deduction),0) from payroll_lines where run_id = p_run), 'description', 'استرداد سلف ' || r.period)
    || jsonb_build_object('account_key','salaries_payable','credit', r.total_net, 'description', 'صافي رواتب ' || r.period);

  v_je := gl_post(v_org, r.period_end, 'مسيّر رواتب ' || r.period || ' — ' || r.number, 'payroll', r.id, v_lines);
  update payroll_runs set status = 'posted', journal_entry_id = v_je where id = p_run;
  perform log_audit(v_org, 'payroll.post', 'payroll_run', p_run::text, jsonb_build_object('net', r.total_net));
  perform emit_event(v_org, 'payroll.posted', 'payroll_run', p_run,
                     jsonb_build_object('period', r.period, 'net', r.total_net, 'employees', r.employees_count));
  return v_je;
end $$;

create or replace function decide_leave(p_leave uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('hr.manage');
begin
  update leave_requests set status = case when p_approve then 'approved' else 'rejected' end,
                            decided_by = auth.uid(), decided_at = now()
   where id = p_leave and org_id = v_org and status = 'pending';
  if not found then raise exception 'pending leave request not found'; end if;
  perform log_audit(v_org, 'leave.decide', 'leave_request', p_leave::text, jsonb_build_object('approved', p_approve));
end $$;

-- annual leave balance (accrual pro-rata: 21 days/yr, 30 after five years of service)
create or replace function leave_balance(p_employee uuid, p_as_of date default current_date)
returns jsonb language sql stable security invoker set search_path = public as $$
  with e as (select * from employees where id = p_employee and org_id = current_org_id()),
  acc as (
    select e.id,
           round(least((p_as_of - e.hire_date + 1), 5 * 365) / 365.0 * e.annual_leave_days
                 + greatest((p_as_of - e.hire_date + 1) - 5 * 365, 0) / 365.0 * greatest(e.annual_leave_days, 30), 1) as accrued
      from e)
  select jsonb_build_object(
    'accrued', acc.accrued,
    'taken', coalesce((select sum(days) from leave_requests l where l.employee_id = acc.id
                        and l.leave_type = 'annual' and l.status = 'approved' and l.start_date <= p_as_of), 0),
    'balance', acc.accrued - coalesce((select sum(days) from leave_requests l where l.employee_id = acc.id
                        and l.leave_type = 'annual' and l.status = 'approved' and l.start_date <= p_as_of), 0))
  from acc
$$;

create or replace function normalize_new_leave()
returns trigger language plpgsql as $$
begin
  new.status := 'pending'; new.decided_by := null; new.decided_at := null;
  return new;
end $$;
create trigger leave_new before insert on leave_requests
  for each row execute function normalize_new_leave();

-- ── RLS ─────────────────────────────────────────────────────────────────
select apply_org_policies('departments',    'hr.view',      'hr.manage');
select apply_org_policies('employees',      'hr.view',      'hr.manage');
select apply_org_policies('leave_requests', 'hr.view',      'hr.manage');
select apply_org_policies('payroll_runs',   'payroll.view', 'payroll.manage');
select apply_org_policies('payroll_lines',  'payroll.view', 'payroll.manage');
select apply_org_policies('payroll_settings','payroll.view','payroll.approve');
alter table gosi_annuity_schedule enable row level security;
create policy gosi_schedule_read on gosi_annuity_schedule for select to authenticated using (true);

create trigger employees_zcode before insert on employees for each row execute function assign_party_code('EMP');
create trigger employees_upd before update on employees for each row execute function set_updated_at();

-- statuses / totals only change through the functions above
revoke update on payroll_runs, leave_requests from authenticated;
revoke insert on payroll_runs from authenticated;
grant update (employee_id, leave_type, start_date, end_date, notes) on leave_requests to authenticated;
revoke insert, update on payroll_lines from authenticated;
grant update (overtime, additions, advance_deduction, other_deductions, notes, project_id) on payroll_lines to authenticated;
