-- organisation units of any depth; managers derived from unit heads
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

select save_employees('[
  {"code": "U-1", "first_name_ar": "رئيس", "last_name_ar": "القطاع", "hire_date": "2020-01-01"},
  {"code": "U-2", "first_name_ar": "مدير", "last_name_ar": "التشغيل", "hire_date": "2020-01-01"},
  {"code": "U-3", "first_name_ar": "رئيس", "last_name_ar": "العمليات", "hire_date": "2020-01-01"},
  {"code": "U-4", "first_name_ar": "مهندس", "last_name_ar": "تطبيقات", "hire_date": "2022-01-01"},
  {"code": "U-5", "first_name_ar": "فني", "last_name_ar": "دعم", "hire_date": "2023-01-01"}]');
-- five levels in one batch, children listed before their parents
select save_departments('[
  {"name_ar": "قسم عمليات التطبيقات", "unit_type": "section", "code": "S-APP", "parent_ref": "ادارة العمليات التقنية"},
  {"name_ar": "ادارة العمليات التقنية", "unit_type": "department", "parent_ref": "GD-OPS", "head_ref": "U-3"},
  {"name_ar": "الادارة العامة للتشغيل", "unit_type": "general_department", "code": "GD-OPS", "parent_ref": "قطاع التقنية", "head_ref": "مدير التشغيل"},
  {"name_ar": "قطاع التقنية", "unit_type": "sector", "head_ref": "U-1"}]');
select t.ok((with recursive up as (select id, parent_id, 1 as lvl from departments where code = 'S-APP'
                                   union all select d.id, d.parent_id, lvl + 1 from departments d join up on d.id = up.parent_id)
             select max(lvl) from up) = 4, 'four-level unit chain built in one batch');
select t.fails($$select save_departments('[{"name_ar": "x", "parent_ref": "غير موجودة"}]')$$, 'parent unit "غير موجودة" not found');

-- staff into units, then derive managers
update employees set department_id = (select id from departments where name_ar = 'قطاع التقنية') where code = 'U-1';
update employees set department_id = (select id from departments where code = 'GD-OPS') where code = 'U-2';
update employees set department_id = (select id from departments where name_ar = 'ادارة العمليات التقنية') where code = 'U-3';
update employees set department_id = (select id from departments where code = 'S-APP') where code in ('U-4', 'U-5');
select assign_managers_from_units() as n \gset
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'U-4') = 'U-3', 'section member → head above (section has no head)');
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'U-3') = 'U-2', 'unit head → head of the parent unit');
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'U-2') = 'U-1', 'general department head → sector head');
select t.ok((select manager_id from employees where code = 'U-1') is null, 'top head keeps no manager');

-- a section head appears: overwrite re-points its staff, without overwrite nothing changes
update departments set head_employee_id = (select id from employees where code = 'U-4') where code = 'S-APP';
select t.ok(assign_managers_from_units(false) = 0, 'no overwrite: existing managers kept');
select assign_managers_from_units(true);
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'U-5') = 'U-4', 'overwrite: staff report to the new section head');
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'U-4') = 'U-3', 'section head reports up');
reset role;
\echo '  ✓ org units: any depth in one batch, managers derived from unit heads'
