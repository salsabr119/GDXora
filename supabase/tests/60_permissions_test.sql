-- strict roles: each department sees its own module; salaries need hr.salaries;
-- name-only lookups work across modules; custom roles
\set QUIET on
set client_min_messages = warning;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'hr@a.test', '{}'),
  ('00000000-0000-0000-0000-0000000000d2', 'pm@a.test', '{}'),
  ('00000000-0000-0000-0000-0000000000d3', 'clerk@a.test', '{}'),
  ('00000000-0000-0000-0000-0000000000d4', 'fm@a.test', '{}');
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select add_member('hr@a.test', 'hr'); select add_member('pm@a.test', 'project_manager');
-- a custom role: HR clerk without access to salaries
insert into roles (org_id, key, name_ar, name_en) values (current_org_id(), 'hr_clerk', 'موظف شؤون موظفين', 'HR clerk');
insert into role_permissions (org_id, role_key, perm_key) values (current_org_id(), 'hr_clerk', 'hr.view'), (current_org_id(), 'hr_clerk', 'hr.manage');
select add_member('clerk@a.test', 'hr_clerk'); select add_member('fm@a.test', 'finance_manager');
select t.ok((select count(*) from employee_pay) >= 3, 'owner sees salaries');

-- HR officer: employees + salaries
select t.act('00000000-0000-0000-0000-0000000000d1', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from employees) >= 3 and (select count(*) from employee_pay) >= 3, 'HR sees employees and salaries');
select t.ok((select count(*) from invoices) = 0 and (select count(*) from journal_entries) = 0, 'HR sees no invoices or journals');
select t.ok((select count(*) from lookup_projects()) >= 1, 'HR can pick a project for salary cost');
select (save_employees('[{"first_name_ar": "منى", "last_name_ar": "سالم", "nationality": "SA", "hire_date": "2026-01-01", "basic_salary": 7000, "iban": "SA0380000000608010167519"}]'))[1] as emp \gset
select t.ok((select basic_salary = 7000 and iban like 'SA03%' from employee_pay where employee_id = :'emp'), 'HR saves employee with pay');
select save_employees(format('[{"id": "%s", "job_title": "محاسبة", "housing_allowance": 1750}]', :'emp')::jsonb);
select t.ok((select e.job_title = 'محاسبة' and p.housing_allowance = 1750 and p.basic_salary = 7000
               from employees e join employee_pay p on p.employee_id = e.id where e.id = :'emp'), 'update touches only the given fields');
select t.fails($$select save_employees('[{"first_name_ar": "x", "last_name_ar": "y", "hire_date": "2026-01-01", "iban": "SA12"}]')$$, 'employee_pay_iban');
select t.ok((select count(*) from employees where first_name_ar = 'x') = 0, 'failed save leaves nothing behind');

-- HR clerk: employees yes, salaries no
select t.act('00000000-0000-0000-0000-0000000000d3', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from employees) >= 4, 'clerk sees employees');
select t.ok((select count(*) from employee_pay) = 0, 'clerk sees no salaries');
select t.fails(format($$select save_employees('[{"id": "%s", "basic_salary": 99999}]')$$, :'emp'), 'permission denied: hr.salaries');
select save_employees(format('[{"id": "%s", "phone": "0500000000"}]', :'emp')::jsonb);
select t.ok((select phone = '0500000000' from employees where id = :'emp'), 'clerk edits non-salary fields');
select t.fails(format($$select employee_eosb('%s')$$, :'emp'), 'permission denied: hr.salaries');

-- project manager: projects only
select t.act('00000000-0000-0000-0000-0000000000d2', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from projects) >= 1, 'PM sees projects');
select t.ok((select count(*) from employees) = 0 and (select count(*) from employee_pay) = 0, 'PM sees no employees or salaries');
select t.ok((select count(*) from invoices) = 0 and (select count(*) from bills) = 0, 'PM sees no invoices or bills');
select t.ok((select count(*) from lookup_customers()) >= 1, 'PM can pick a customer by name');
select t.ok((select count(*) from lookup_employees()) = 0, 'PM gets no employee list');
select t.ok((select sum(revenue) from project_summary()) > 0, 'PM sees project profitability without the ledger');

-- finance manager: names and bank details on the payroll run it approves; no HR or projects module
select t.act('00000000-0000-0000-0000-0000000000d4', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from employees) >= 4 and (select count(*) from employee_pay) >= 4, 'finance manager reads names/bank for payroll');
select t.fails(format($$select save_employees('[{"id": "%s", "phone": "1"}]')$$, :'emp'), 'permission denied: hr.manage');
select t.ok((select count(*) from projects) = 0 and (select count(*) from journal_entries) > 0, 'finance manager: accounting yes, projects no');

-- sales: no projects module, but can tag an invoice with a project
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from projects) = 0, 'sales does not open projects');
select t.ok((select count(*) from lookup_projects()) >= 1, 'sales can pick a project on an invoice');
reset role;

-- a new company gets the strict roles and the subscriptions account
set role authenticated;
select t.act('00000000-0000-0000-0000-00000000000b', null);
select create_organization('شركة جيم', 'Jeem Co') as orgc \gset
reset role;
select t.ok(not exists (select 1 from role_permissions where org_id = :'orgc' and role_key = 'project_manager' and perm_key not like 'projects.%'), 'new org: PM role limited to projects');
select t.ok(exists (select 1 from role_permissions where org_id = :'orgc' and role_key = 'hr' and perm_key = 'hr.salaries'), 'new org: HR role has salaries');
select t.ok(exists (select 1 from accounts where org_id = :'orgc' and code = '6109' and system_key = 'subscriptions'), 'new org: subscriptions account');
select t.ok((select count(*) from accounts where code = '6109') = (select count(*) from organizations), 'every org has the subscriptions account');
\echo '  ✓ permissions: strict roles, salaries behind hr.salaries, name-only lookups, custom roles'
