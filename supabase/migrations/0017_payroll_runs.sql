-- GDXora · 0017 — Several payroll runs a month and editable run membership
--  • run_type: regular (one a month, as before) or an extra run — overtime,
--    bonus, other — any number per month; extra runs carry only the amounts
--    entered (no basic pay, no GOSI: contributions follow basic + housing)
--  • add an employee to a draft run (computed the same way as generation);
--    removing one is deleting the draft line

alter table payroll_runs
  add column run_type text not null default 'regular' check (run_type in ('regular','overtime','bonus','other')),
  add column title text;
alter table payroll_runs drop constraint payroll_runs_org_id_period_key;
create unique index payroll_runs_one_regular on payroll_runs(org_id, period) where run_type = 'regular';

-- one employee's line on a draft run
create or replace function _payroll_add_line(p_run uuid, p_employee uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r payroll_runs%rowtype; s payroll_settings%rowtype; e record;
  v_emp_days numeric; v_unpaid numeric; v_factor numeric; v_wage numeric; v_ann numeric;
begin
  select * into r from payroll_runs where id = p_run;
  select * into s from payroll_settings where org_id = r.org_id;
  select emp.*, coalesce(pay.basic_salary, 0) as basic_salary, coalesce(pay.housing_allowance, 0) as housing_allowance,
         coalesce(pay.transport_allowance, 0) as transport_allowance, coalesce(pay.other_allowances, 0) as other_allowances
    into e from employees emp left join employee_pay pay on pay.employee_id = emp.id
   where emp.id = p_employee and emp.org_id = r.org_id;
  if not found then raise exception 'employee not found'; end if;

  if r.run_type <> 'regular' then
    insert into payroll_lines (org_id, run_id, employee_id, project_id, is_saudi, worked_days)
    values (r.org_id, p_run, e.id, e.project_id, e.is_saudi, 0);
    return;
  end if;

  -- days employed within the month on a 30-day basis
  v_emp_days := least(s.month_days,
                      (least(coalesce(e.termination_date, r.period_end), r.period_end) - greatest(e.hire_date, r.period_start) + 1)
                      * s.month_days::numeric / (r.period_end - r.period_start + 1));
  if greatest(e.hire_date, r.period_start) = r.period_start and least(coalesce(e.termination_date, r.period_end), r.period_end) = r.period_end then
    v_emp_days := s.month_days;
  end if;
  if v_emp_days <= 0 then raise exception 'employee was not in service during %', r.period; end if;
  select coalesce(sum(least(end_date, r.period_end) - greatest(start_date, r.period_start) + 1), 0) into v_unpaid
    from leave_requests
   where employee_id = e.id and status = 'approved' and leave_type = 'unpaid'
     and start_date <= r.period_end and end_date >= r.period_start;
  v_unpaid := least(v_unpaid, v_emp_days);
  v_factor := (v_emp_days - v_unpaid) / s.month_days;

  -- no salary on file (e.g. pay not entered yet) → no contribution rather than a negative net on the minimum wage
  v_wage := case when e.gosi_registered and e.basic_salary + e.housing_allowance > 0
                 then least(greatest(e.basic_salary + e.housing_allowance, s.gosi_min_wage), s.gosi_max_wage)
                 else 0 end;
  v_ann := gosi_annuity_rate(e.gosi_scheme, r.period_end, s.legacy_annuity_rate);
  -- partial month (joined/left mid-month): contributions follow the days employed
  v_wage := round(v_wage * v_emp_days / s.month_days, 2);

  insert into payroll_lines (org_id, run_id, employee_id, project_id, is_saudi, worked_days, unpaid_days,
                             basic, housing, transport, other_allowances, gosi_wage, gosi_employee, gosi_employer)
  values (r.org_id, p_run, e.id, e.project_id, e.is_saudi, round(v_emp_days - v_unpaid, 2), v_unpaid,
          round(e.basic_salary * v_factor, 2), round(e.housing_allowance * v_factor, 2),
          round(e.transport_allowance * v_factor, 2), round(e.other_allowances * v_factor, 2),
          v_wage,
          case when e.is_saudi then round(v_wage * (v_ann + s.saned_rate) / 100, 2) else 0 end,
          case when e.is_saudi then round(v_wage * (v_ann + s.saned_rate + s.hazards_rate) / 100, 2)
               else round(v_wage * s.hazards_rate / 100, 2) end);
end $$;
revoke execute on function _payroll_add_line(uuid, uuid) from public, anon, authenticated;

-- the monthly run: every employee in service during the month
create or replace function generate_payroll(p_period text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('payroll.manage'); v_run uuid; v_start date; v_end date; e record;
begin
  insert into payroll_settings (org_id) values (v_org) on conflict do nothing;
  v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  if exists (select 1 from payroll_runs where org_id = v_org and period = p_period and run_type = 'regular') then
    raise exception 'payroll run for % already exists', p_period;
  end if;
  insert into payroll_runs (org_id, period, period_start, period_end, run_type)
  values (v_org, p_period, v_start, v_end, 'regular') returning id into v_run;
  for e in select id from employees
            where org_id = v_org and hire_date <= v_end
              and (termination_date is null or termination_date >= v_start)
              and not (status = 'terminated' and termination_date is null)
            order by code loop
    perform _payroll_add_line(v_run, e.id);
  end loop;
  perform log_audit(v_org, 'payroll.generate', 'payroll_run', v_run::text, jsonb_build_object('period', p_period));
  return v_run;
end $$;

-- an extra run (overtime / bonus / other) for the chosen employees, or all in service
create or replace function create_extra_payroll(p_period text, p_type text, p_title text default null, p_employees uuid[] default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('payroll.manage'); v_run uuid; v_start date; v_end date; e record;
begin
  if p_type not in ('overtime','bonus','other') then raise exception 'invalid extra payroll type'; end if;
  if p_type = 'other' and coalesce(trim(p_title), '') = '' then raise exception 'a title is required for an "other" payroll run'; end if;
  insert into payroll_settings (org_id) values (v_org) on conflict do nothing;
  v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  insert into payroll_runs (org_id, period, period_start, period_end, run_type, title)
  values (v_org, p_period, v_start, v_end, p_type, nullif(trim(p_title), '')) returning id into v_run;
  for e in select id from employees
            where org_id = v_org and hire_date <= v_end
              and (termination_date is null or termination_date >= v_start)
              and not (status = 'terminated' and termination_date is null)
              and (p_employees is null or id = any(p_employees))
            order by code loop
    perform _payroll_add_line(v_run, e.id);
  end loop;
  perform log_audit(v_org, 'payroll.generate', 'payroll_run', v_run::text, jsonb_build_object('period', p_period, 'type', p_type));
  return v_run;
end $$;

-- add an employee to a draft run
create or replace function add_payroll_employee(p_run uuid, p_employee uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('payroll.manage');
begin
  if not exists (select 1 from payroll_runs where id = p_run and org_id = v_org and status = 'draft') then
    raise exception 'draft payroll run not found';
  end if;
  if exists (select 1 from payroll_lines where run_id = p_run and employee_id = p_employee) then
    raise exception 'employee is already in this payroll run';
  end if;
  perform _payroll_add_line(p_run, p_employee);
end $$;

create or replace function post_payroll(p_run uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('payroll.approve');
  r payroll_runs%rowtype; s payroll_settings%rowtype; v_lines jsonb := '[]'::jsonb; x record; v_je uuid; v_kind text;
begin
  select * into r from payroll_runs where id = p_run and org_id = v_org for update;
  if not found or r.status <> 'approved' then raise exception 'approved payroll run not found'; end if;
  select * into s from payroll_settings where org_id = v_org;
  v_kind := case r.run_type when 'overtime' then 'عمل إضافي' when 'bonus' then 'مكافآت' when 'other' then coalesce(r.title, 'مسيّر إضافي') else 'رواتب' end;

  for x in select case when s.labour_cost_to_projects and project_id is not null then 'cost_labour' else 'salaries_expense' end as acc,
                  project_id, sum(gross - other_deductions) amt, sum(gosi_employer) gosi
             from payroll_lines where run_id = p_run group by 1, 2 loop
    v_lines := v_lines
      || jsonb_build_object('account_key', x.acc, 'debit', x.amt, 'project_id', x.project_id, 'description', v_kind || ' ' || r.period)
      || jsonb_build_object('account_key', 'gosi_expense', 'debit', x.gosi, 'project_id', x.project_id, 'description', 'تأمينات ' || r.period);
  end loop;
  v_lines := v_lines
    || jsonb_build_object('account_key','gosi_payable','credit', r.total_gosi_employee + r.total_gosi_employer, 'description', 'تأمينات ' || r.period)
    || jsonb_build_object('account_key','employee_advances','credit',
                          (select coalesce(sum(advance_deduction),0) from payroll_lines where run_id = p_run), 'description', 'استرداد سلف ' || r.period)
    || jsonb_build_object('account_key','salaries_payable','credit', r.total_net, 'description', 'صافي ' || v_kind || ' ' || r.period);

  v_je := gl_post(v_org, r.period_end, 'مسيّر ' || v_kind || ' ' || r.period || ' — ' || r.number, 'payroll', r.id, v_lines);
  update payroll_runs set status = 'posted', journal_entry_id = v_je where id = p_run;
  perform log_audit(v_org, 'payroll.post', 'payroll_run', p_run::text, jsonb_build_object('net', r.total_net));
  perform emit_event(v_org, 'payroll.posted', 'payroll_run', p_run,
                     jsonb_build_object('period', r.period, 'net', r.total_net, 'employees', r.employees_count));
  return v_je;
end $$;
