-- GDXora · 0015 — Report queries that need per-employee calculation in SQL.
-- Both are security invoker: row-level security decides what the caller sees
-- (employees need hr.view; the EOSB provision also needs read access to
-- employee_pay, i.e. hr.salaries or payroll.view).

-- annual leave balance of every employee in service on p_as_of
create or replace function report_leave_balances(p_as_of date default current_date)
returns table (employee_id uuid, code text, first_name_ar text, last_name_ar text, department text,
               hire_date date, annual_leave_days int, accrued numeric, taken numeric, balance numeric, unpaid_taken numeric)
language sql stable security invoker set search_path = public as $$
  with e as (
    select e.*, d.name_ar as dept,
           (p_as_of - e.hire_date + 1) as days_served
      from employees e left join departments d on d.id = e.department_id
     where e.org_id = current_org_id() and e.hire_date <= p_as_of
       and (e.termination_date is null or e.termination_date >= p_as_of)
       and e.status <> 'terminated'),
  lv as (
    select l.employee_id,
           sum(l.days) filter (where l.leave_type = 'annual') as annual,
           sum(l.days) filter (where l.leave_type = 'unpaid') as unpaid
      from leave_requests l
     where l.org_id = current_org_id() and l.status = 'approved' and l.start_date <= p_as_of
     group by l.employee_id)
  select e.id, e.code, e.first_name_ar, e.last_name_ar, e.dept, e.hire_date, e.annual_leave_days,
         a.accrued, coalesce(lv.annual, 0), a.accrued - coalesce(lv.annual, 0), coalesce(lv.unpaid, 0)
    from e
    cross join lateral (select round(least(e.days_served, 5 * 365) / 365.0 * e.annual_leave_days
                                     + greatest(e.days_served - 5 * 365, 0) / 365.0 * greatest(e.annual_leave_days, 30), 1) as accrued) a
    left join lv on lv.employee_id = e.id
   order by e.code
$$;

-- end-of-service liability per employee on p_as_of (Saudi Labour Law art. 84/85)
--   on_termination: award if the employer ends the contract
--   on_resignation: award if the employee resigns
create or replace function report_eosb(p_as_of date default current_date)
returns table (employee_id uuid, code text, first_name_ar text, last_name_ar text, department text,
               hire_date date, years numeric, monthly_wage numeric, on_termination numeric, on_resignation numeric)
language sql stable security invoker set search_path = public as $$
  select e.id, e.code, e.first_name_ar, e.last_name_ar, d.name_ar, e.hire_date,
         round((p_as_of - e.hire_date + 1) / 365.0, 2),
         w.wage, eosb_amount(w.wage, e.hire_date, p_as_of, 'employer_termination'), eosb_amount(w.wage, e.hire_date, p_as_of, 'resignation')
    from employees e
    join employee_pay p on p.employee_id = e.id
    left join departments d on d.id = e.department_id
    cross join lateral (select p.basic_salary + p.housing_allowance + p.transport_allowance + p.other_allowances as wage) w
   where e.org_id = current_org_id() and e.hire_date <= p_as_of
     and (e.termination_date is null or e.termination_date >= p_as_of) and e.status <> 'terminated'
   order by e.code
$$;
