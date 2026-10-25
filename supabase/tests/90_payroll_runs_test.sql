-- several runs a month: one regular + extra runs; add / remove employees on drafts
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

select generate_payroll('2026-11') as reg \gset
select t.fails($$select generate_payroll('2026-11')$$, 'already exists');
select (select count(*) from payroll_lines where run_id = :'reg') as n_reg \gset

-- remove an employee from the draft, then add them back with the same figures
select employee_id as emp, net as net_before from payroll_lines where run_id = :'reg' order by net desc limit 1 \gset
delete from payroll_lines where run_id = :'reg' and employee_id = :'emp';
select t.ok((select employees_count from payroll_runs where id = :'reg') = :n_reg - 1, 'removing a line updates the run totals');
select add_payroll_employee(:'reg', :'emp');
select t.ok((select net from payroll_lines where run_id = :'reg' and employee_id = :'emp') = :net_before, 'adding back recomputes the same line');
select t.fails(format($$select add_payroll_employee('%s', '%s')$$, :'reg', :'emp'), 'already in this payroll run');

-- an overtime run for two employees in the same month: no basic pay, no GOSI
select create_extra_payroll('2026-11', 'overtime', null,
         array(select id from employees where first_name_ar in ('فهد', 'راجيش'))) as ot \gset
select t.ok((select count(*) from payroll_lines where run_id = :'ot') = 2, 'extra run holds the chosen employees');
update payroll_lines set overtime = 1500 where run_id = :'ot';
select t.ok((select total_gross = 3000 and total_gosi_employee = 0 and total_gosi_employer = 0 and total_net = 3000 from payroll_runs where id = :'ot'),
            'overtime run: amounts only, no GOSI');
select create_extra_payroll('2026-11', 'bonus') as bonus \gset
select t.ok((select count(*) from payroll_runs where period = '2026-11') = 3, 'three runs in one month');
select t.fails($$select create_extra_payroll('2026-11', 'other')$$, 'title is required');

-- post the overtime run: salaries expense / salaries payable, memo names the run type
select approve_payroll(:'ot');
select post_payroll(:'ot') as je \gset
select t.ok((select memo like 'مسيّر عمل إضافي 2026-11%' and total = 3000 from journal_entries where id = :'je'), 'overtime run posted with its own memo');
reset role;
\echo '  ✓ payroll runs: one regular + extra runs per month, add/remove employees on drafts'
