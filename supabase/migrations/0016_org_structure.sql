-- GDXora · 0016 — Organisation structure: each employee reports to one direct
-- manager; departments can sit under a parent department and have a head.
-- Reporting loops are refused. save_employees() accepts manager_ref (code,
-- national ID or full Arabic name) so an Excel import can name managers that
-- are in the same file.

alter table employees add column manager_id uuid references employees(id) on delete set null;
create index on employees(org_id, manager_id);
alter table departments
  add column parent_id uuid references departments(id) on delete set null,
  add column head_employee_id uuid references employees(id) on delete set null;

create or replace function employees_manager_guard()
returns trigger language plpgsql as $$
begin
  if new.manager_id is null then return new; end if;
  if new.manager_id = new.id then raise exception 'an employee cannot be their own manager'; end if;
  if not exists (select 1 from employees where id = new.manager_id and org_id = new.org_id) then raise exception 'manager not found'; end if;
  if exists (with recursive up(id) as (
               select manager_id from employees where id = new.manager_id
               union select e.manager_id from employees e join up on e.id = up.id where e.manager_id is not null)
             select 1 from up where id = new.id) then
    raise exception 'reporting loop: the chosen manager reports to this employee';
  end if;
  return new;
end $$;
create trigger employees_manager_chk before insert or update of manager_id on employees
  for each row execute function employees_manager_guard();

create or replace function departments_parent_guard()
returns trigger language plpgsql as $$
begin
  if new.head_employee_id is not null and not exists (select 1 from employees where id = new.head_employee_id and org_id = new.org_id) then
    raise exception 'department head not found';
  end if;
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'a department cannot be its own parent'; end if;
  if not exists (select 1 from departments where id = new.parent_id and org_id = new.org_id) then raise exception 'parent department not found'; end if;
  if exists (with recursive up(id) as (
               select parent_id from departments where id = new.parent_id
               union select d.parent_id from departments d join up on d.id = up.id where d.parent_id is not null)
             select 1 from up where id = new.id) then
    raise exception 'department loop: the chosen parent is under this department';
  end if;
  return new;
end $$;
create trigger departments_parent_chk before insert or update of parent_id, head_employee_id on departments
  for each row execute function departments_parent_guard();

-- save_employees: + manager_ref, resolved after all rows of the batch exist
create or replace function save_employees(p_rows jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('hr.manage'); r jsonb; v_id uuid; v_ids uuid[] := '{}'; i int := 0; v_ref text; v_mgr uuid;
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
  -- second pass: managers named by reference (they may be later rows of the same batch)
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_ref := nullif(trim(r ->> 'manager_ref'), '');
    if v_ref is null then continue; end if;
    select id into v_mgr from employees
     where org_id = v_org and (code = v_ref or national_id = v_ref
           or regexp_replace(first_name_ar || ' ' || last_name_ar, '\s+', ' ', 'g') = regexp_replace(v_ref, '\s+', ' ', 'g'))
     order by (code = v_ref) desc limit 2;
    if v_mgr is null then raise exception 'row %: manager "%" not found', i, v_ref; end if;
    if (select count(*) from employees where org_id = v_org and code <> v_ref
          and regexp_replace(first_name_ar || ' ' || last_name_ar, '\s+', ' ', 'g') = regexp_replace(v_ref, '\s+', ' ', 'g')) > 1 then
      raise exception 'row %: more than one employee is named "%" — use the employee number', i, v_ref;
    end if;
    update employees set manager_id = v_mgr where id = v_ids[i];
  end loop;
  return v_ids;
end $$;

-- employees imported before this migration carry their manager in the notes
-- ("المدير المباشر: <name> (<title>)") — link them
update employees e set manager_id = m.id
  from employees m
 where e.org_id = m.org_id and e.manager_id is null and e.id <> m.id
   and e.notes like 'المدير المباشر: ' || m.first_name_ar || ' ' || m.last_name_ar || ' (%';
