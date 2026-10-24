-- report functions: figures match the single-employee functions; RLS decides visibility
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

select t.ok((select count(*) from report_leave_balances('2026-10-01')) >= 3, 'leave report lists employees in service');
select t.ok((select bool_and(r.balance = (leave_balance(r.employee_id, '2026-10-01') ->> 'balance')::numeric)
               from report_leave_balances('2026-10-01') r), 'leave report matches leave_balance()');
select t.ok((select bool_and(r.on_termination = (employee_eosb(r.employee_id, '2026-09-30') ->> 'amount')::numeric)
               from report_eosb('2026-09-30') r), 'EOSB report matches employee_eosb()');
select t.ok((select on_resignation from report_eosb('2026-09-30') where first_name_ar = 'سارة') = 0, 'resignation under 2 years earns nothing');

-- HR clerk (no salary access) sees the leave report but not the EOSB liability
select t.act('00000000-0000-0000-0000-0000000000d3', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from report_leave_balances()) >= 3, 'clerk sees leave balances');
select t.ok((select count(*) from report_eosb()) = 0, 'clerk sees no EOSB amounts');
-- project manager sees neither
select t.act('00000000-0000-0000-0000-0000000000d2', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from report_leave_balances()) = 0 and (select count(*) from report_eosb()) = 0, 'PM sees no HR reports');
reset role;
\echo '  ✓ reports: leave balances and EOSB provision match the per-employee functions, RLS applies'
