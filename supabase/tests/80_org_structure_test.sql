-- organisation structure: managers, loops refused, import by reference, department tree
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

-- one batch where the manager comes after the reports in the file
select save_employees('[
  {"code": "OS-3", "first_name_ar": "مطور", "last_name_ar": "أول", "hire_date": "2024-01-01", "manager_ref": "مدير  التقنية"},
  {"code": "OS-2", "first_name_ar": "مدير", "last_name_ar": "التقنية", "hire_date": "2020-01-01", "manager_ref": "OS-1"},
  {"code": "OS-1", "first_name_ar": "الرئيس", "last_name_ar": "التنفيذي", "hire_date": "2015-01-01"}]') as ids \gset
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'OS-3') = 'OS-2', 'manager by name resolved within the batch');
select t.ok((select m.code from employees e join employees m on m.id = e.manager_id where e.code = 'OS-2') = 'OS-1', 'manager by code resolved');
select t.fails($$select save_employees('[{"first_name_ar": "x", "last_name_ar": "y", "hire_date": "2024-01-01", "manager_ref": "غير موجود"}]')$$, 'manager "غير موجود" not found');
select t.ok((select count(*) from employees where first_name_ar = 'x') = 0, 'failed manager lookup rolls back the batch');

-- loops are refused
select t.fails($$update employees set manager_id = (select id from employees where code = 'OS-3') where code = 'OS-1'$$, 'reporting loop');
select t.fails($$update employees set manager_id = id where code = 'OS-1'$$, 'own manager');

-- department tree with a head
insert into departments (name_ar) values ('التقنية'), ('التطوير');
update departments set parent_id = (select id from departments where name_ar = 'التقنية'), head_employee_id = (select id from employees where code = 'OS-2')
 where name_ar = 'التطوير';
select t.ok((select p.name_ar from departments d join departments p on p.id = d.parent_id where d.name_ar = 'التطوير') = 'التقنية', 'sub-department');
select t.fails($$update departments set parent_id = (select id from departments where name_ar = 'التطوير') where name_ar = 'التقنية'$$, 'department loop');
reset role;
\echo '  ✓ org structure: managers by reference in one batch, loops refused, department tree'
