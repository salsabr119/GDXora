-- GDXora · 0018 — Organisation units of any depth (sector → general
-- department → department → section → unit), saved in one call with
-- references to units / employees in the same batch, and managers derived
-- from unit heads.

alter table departments
  add column unit_type text not null default 'department'
    check (unit_type in ('sector','general_department','department','section','unit')),
  add column code text,
  add constraint departments_code_unique unique (org_id, code);

-- create / update units; parent_ref (unit code or name) and head_ref
-- (employee number, ID or full name) are resolved after the whole batch is in
create or replace function save_departments(p_rows jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('hr.manage'); r jsonb; v_id uuid; v_ids uuid[] := '{}'; i int := 0; v_ref text; v_x uuid; n int;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is null then
      insert into departments (org_id, name_ar, name_en, unit_type, code, parent_id, head_employee_id)
      values (v_org, trim(r ->> 'name_ar'), nullif(r ->> 'name_en', ''), coalesce(nullif(r ->> 'unit_type', ''), 'department'),
              nullif(trim(r ->> 'code'), ''), nullif(r ->> 'parent_id', '')::uuid, nullif(r ->> 'head_employee_id', '')::uuid)
      returning id into v_id;
    else
      if not exists (select 1 from departments where id = v_id and org_id = v_org) then raise exception 'unit not found'; end if;
      update departments set
        name_ar = case when r ? 'name_ar' then trim(r ->> 'name_ar') else name_ar end,
        name_en = case when r ? 'name_en' then nullif(r ->> 'name_en', '') else name_en end,
        unit_type = case when r ? 'unit_type' then coalesce(nullif(r ->> 'unit_type', ''), 'department') else unit_type end,
        code = case when r ? 'code' then nullif(trim(r ->> 'code'), '') else code end,
        parent_id = case when r ? 'parent_id' then nullif(r ->> 'parent_id', '')::uuid else parent_id end,
        head_employee_id = case when r ? 'head_employee_id' then nullif(r ->> 'head_employee_id', '')::uuid else head_employee_id end
       where id = v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_ref := nullif(trim(r ->> 'parent_ref'), '');
    if v_ref is not null then
      select count(*), min(id::text)::uuid into n, v_x from departments where org_id = v_org and (code = v_ref or name_ar = v_ref);
      if n = 0 then raise exception 'row %: parent unit "%" not found', i, v_ref; end if;
      if n > 1 then raise exception 'row %: more than one unit matches "%" — use the unit code', i, v_ref; end if;
      update departments set parent_id = v_x where id = v_ids[i];
    end if;
    v_ref := nullif(trim(r ->> 'head_ref'), '');
    if v_ref is not null then
      select count(*), min(id::text)::uuid into n, v_x from employees
       where org_id = v_org and (code = v_ref or national_id = v_ref
             or regexp_replace(first_name_ar || ' ' || last_name_ar, '\s+', ' ', 'g') = regexp_replace(v_ref, '\s+', ' ', 'g'));
      if n = 0 then raise exception 'row %: head "%" not found', i, v_ref; end if;
      if n > 1 then raise exception 'row %: more than one employee matches "%" — use the employee number', i, v_ref; end if;
      update departments set head_employee_id = v_x where id = v_ids[i];
    end if;
  end loop;
  return v_ids;
end $$;

-- direct managers from the unit structure: an employee reports to the head of
-- their unit; a unit head reports to the nearest head above their unit.
-- Without p_overwrite only employees with no manager are touched.
create or replace function assign_managers_from_units(p_overwrite boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('hr.manage'); e record; v_mgr uuid; v_unit uuid; n int := 0;
begin
  for e in select id, department_id, manager_id from employees
            where org_id = v_org and department_id is not null and status <> 'terminated'
              and (p_overwrite or manager_id is null) order by code loop
    v_mgr := null; v_unit := e.department_id;
    while v_unit is not null and v_mgr is null loop
      select case when head_employee_id is distinct from e.id then head_employee_id end, parent_id
        into v_mgr, v_unit from departments where id = v_unit;
    end loop;
    if v_mgr is not null and v_mgr is distinct from e.manager_id then
      begin
        update employees set manager_id = v_mgr where id = e.id;
        n := n + 1;
      exception when others then null;   -- would create a loop: leave this one as it is
      end;
    end if;
  end loop;
  perform log_audit(v_org, 'org.assign_managers', 'employees', null, jsonb_build_object('updated', n, 'overwrite', p_overwrite));
  return n;
end $$;
