-- ════════════════════════════════════════════════════════════════════════
-- End-to-end database test: tenancy isolation, permissions, accounting,
-- sales + ZATCA chain, progress billings, finance, payroll, integrations.
-- Any failed assertion raises and aborts the run (ON_ERROR_STOP).
-- ════════════════════════════════════════════════════════════════════════
\set QUIET on
set client_min_messages = warning;

create schema if not exists t;
grant usage on schema t to authenticated, service_role;

create or replace function t.ok(p boolean, msg text) returns void language plpgsql as $$
begin
  if p is distinct from true then raise exception 'ASSERTION FAILED: %', msg; end if;
end $$;

-- run SQL and require it to fail with a message matching the pattern
create or replace function t.fails(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'expected error ~ "%" but got "%" for: %', p_pattern, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'expected failure (~ "%") but succeeded: %', p_pattern, p_sql;
end $$;

-- impersonate a user acting in an org (like supabase-js with the x-org-id header)
create or replace function t.act(p_user uuid, p_org uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false),
         set_config('request.headers', json_build_object('x-org-id', p_org)::text, false);
$$;
grant execute on all functions in schema t to authenticated, service_role;

-- scratch values shared between steps
create table t.v (k text primary key, id uuid, txt text);
grant all on t.v to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@a.test', '{"full_name":"Alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@b.test',   '{"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@a.test', '{"full_name":"Carol"}');

-- ── 1. onboarding ───────────────────────────────────────────────────────
set role authenticated;
select t.act('00000000-0000-0000-0000-00000000000a', null);
insert into t.v select 'orgA', create_organization('شركة ألف للمقاولات', 'Alef Contracting', '300000000000003', '1010101010');
select t.act('00000000-0000-0000-0000-00000000000b', null);
insert into t.v select 'orgB', create_organization('شركة باء', 'Beh Co');

select t.fails($$select create_organization('   ')$$, 'company name is required');
select t.act(null, null);
select t.fails($$select create_organization('x')$$, 'authentication required');

-- alice acts in org A
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.ok(current_org_id() = (select id from t.v where k = 'orgA'), 'current org resolves for a member');
select t.ok((select count(*) from accounts) >= 45, 'default chart of accounts seeded');
select t.ok((select count(*) from tax_codes) = 6, 'VAT codes seeded');
select t.ok((select count(*) from fiscal_periods) = 12, 'fiscal periods seeded');
select t.ok(array_length(my_permissions(), 1) = (select count(*) from permissions), 'owner holds every permission');
select t.ok((select count(*) from my_organizations()) = 1, 'org switcher lists own orgs only');

-- ── 2. tenant isolation ─────────────────────────────────────────────────
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
insert into customers (name_ar) values ('عميل باء السري');
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from customers where name_ar = 'عميل باء السري') = 0, 'org A cannot read org B customers');
select t.ok((select count(*) from organizations) = 1, 'org A sees only its own organization row');

-- forged header: alice claims org B
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgB'));
select t.ok(current_org_id() is null, 'forged org header resolves to no org');
select t.ok((select count(*) from accounts) = 0, 'forged header sees no accounts');
select t.ok((select count(*) from customers) = 0, 'forged header sees no customers');
select t.fails($$insert into customers (org_id, name_ar) values ((select id from t.v where k='orgB'), 'x')$$, 'row-level security');
select t.fails($$select create_journal(current_date, 'x', '[]')$$, 'no active organization');

-- ── 3. roles & permissions ─────────────────────────────────────────────
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select add_member('carol@a.test', 'sales', 'Carol');
select t.fails($$select add_member('nobody@x.test', 'sales')$$, 'no user with this e-mail');

select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.ok(has_perm('sales.issue') and not has_perm('accounting.manage'), 'sales role permissions');
select t.fails($$select create_journal(current_date, 'x', '[]')$$, 'permission denied: accounting.manage');
select t.ok((select count(*) from journal_entries) = 0, 'sales role cannot read journals');
insert into customers (name_ar, vat_number, street, building_no, district, city, postal_code)
values ('شركة الرياض القابضة', '310000000000003', 'طريق الملك فهد', '1234', 'العليا', 'الرياض', '12211');

-- ── 4. general ledger ───────────────────────────────────────────────────
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
insert into t.v (k, id) select 'je1', create_journal(current_date, 'رأس المال', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where system_key = 'bank'),    'debit', 500000),
  jsonb_build_object('account_id', (select id from accounts where system_key = 'capital'), 'credit', 500000)), true);
select t.ok((select number from journal_entries where id = (select id from t.v where k = 'je1')) = 'JV-00001', 'first JV number');

select t.fails($$select create_journal(current_date, 'bad', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where system_key = 'bank'), 'debit', 100),
  jsonb_build_object('account_id', (select id from accounts where system_key = 'capital'), 'credit', 90)), true)$$, 'not balanced');
select t.fails($$select create_journal(current_date, 'one line', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where system_key = 'bank'), 'debit', 100)), true)$$, 'at least two lines');
select t.fails($$select create_journal(current_date, 'group', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where code = '1'), 'debit', 100),
  jsonb_build_object('account_id', (select id from accounts where system_key = 'capital'), 'credit', 100)), true)$$, 'group');
update journal_entries set memo = 'hack' where id = (select id from t.v where k='je1');
select t.ok((select memo from journal_entries where id = (select id from t.v where k='je1')) <> 'hack', 'posted entry text cannot be edited');
select t.fails($$update journal_entries set status = 'draft' where id = (select id from t.v where k='je1')$$, 'permission denied');
select t.fails($$delete from journal_lines$$, 'permission denied');

-- draft → post, and reversal
insert into t.v (k, id) select 'je2', create_journal(current_date, 'مصروف إيجار', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where system_key = 'rent'), 'debit', 3000),
  jsonb_build_object('account_id', (select id from accounts where system_key = 'bank'), 'credit', 3000)), false);
select t.ok((select status from journal_entries where id = (select id from t.v where k='je2')) = 'draft', 'draft stays draft');
select post_journal((select id from t.v where k = 'je2'));
select reverse_journal((select id from t.v where k = 'je2'));
select t.ok((select status from journal_entries where id = (select id from t.v where k='je2')) = 'reversed', 'entry marked reversed');
select t.ok((select closing from trial_balance() where code = '6104') = 0, 'reversal nets rent to zero');

-- closed period blocks posting
select t.fails($$select post_journal((select id from t.v where k='je1'))$$, 'already posted');

-- ── 5. sales invoice + ZATCA chain ──────────────────────────────────────
insert into invoices (customer_id, invoice_kind) select id, 'standard' from customers where name_ar = 'شركة الرياض القابضة'
returning id as inv1 \gset
insert into t.v values ('inv1', :'inv1');
insert into invoice_lines (invoice_id, description, quantity, unit_price, discount, tax_code_id)
values (:'inv1', 'أعمال صيانة', 2, 600, 200, (select id from tax_codes where code = 'VAT15'));
select t.ok((select (subtotal, vat_amount, total) = (1000.00, 150.00, 1150.00) from invoices where id = :'inv1'), 'invoice totals computed');

-- clients cannot fake issuing
select t.fails($$update invoices set status = 'issued' where id = (select id from t.v where k='inv1')$$, 'permission denied');
insert into invoices (status, number, zatca_icv) values ('issued', 'FAKE-1', 999) returning id as fake \gset
select t.ok((select status = 'draft' and number is null and zatca_icv is null from invoices where id = :'fake'), 'new invoice forced to clean draft');
delete from invoices where id = :'fake';

select issue_invoice(:'inv1') as r1 \gset
select t.ok((select number = 'INV-00001' and zatca_icv = 1
                and zatca_pih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=='
             from invoices where id = :'inv1'), 'issue assigns number, ICV=1 and initial PIH');
select t.ok((select closing from trial_balance() where code = '1103') = 1150, 'AR debited with invoice total');
select t.ok((select closing from trial_balance() where code = '2102') = -150, 'VAT output credited');
select t.fails($$update invoices set notes = 'changed' where id = (select id from t.v where k='inv1')$$, 'immutable');
select t.fails($$delete from invoices where id = (select id from t.v where k='inv1')$$, 'cannot be deleted');
select t.fails($$insert into invoice_lines (invoice_id, description, quantity, unit_price, tax_code_id)
                 values ((select id from t.v where k='inv1'), 'x', 1, 1, (select id from tax_codes where code='VAT15'))$$, 'cannot change');

-- the next invoice waits for the previous hash
insert into invoices (invoice_kind) values ('simplified') returning id as inv2 \gset
insert into invoice_lines (invoice_id, description, quantity, unit_price, tax_code_id)
values (:'inv2', 'استشارة', 1, 500, (select id from tax_codes where code = 'VAT15'));
select t.fails(format('select issue_invoice(%L)', :'inv2'), 'pending ZATCA');
select zatca_attach(:'inv1', 'HASH-1', 'QR-1', '<Invoice/>');
select t.fails(format('select zatca_attach(%L, %L, %L, %L)', :'inv1', 'H', 'Q', 'X'), 'already attached');
select issue_invoice(:'inv2');
select t.ok((select zatca_icv = 2 and zatca_pih = 'HASH-1' from invoices where id = :'inv2'), 'PIH chains to previous hash');
select zatca_attach(:'inv2', 'HASH-2', 'QR-2', '<Invoice/>');

-- standard invoice needs buyer identification
insert into customers (name_ar) values ('عميل بلا عنوان') returning id as cust_noaddr \gset
insert into invoices (customer_id, invoice_kind) values (:'cust_noaddr', 'standard') returning id as inv3 \gset
insert into invoice_lines (invoice_id, description, quantity, unit_price, tax_code_id)
values (:'inv3', 'x', 1, 100, (select id from tax_codes where code = 'VAT15'));
select t.fails(format('select issue_invoice(%L)', :'inv3'), 'VAT number');

-- credit note
insert into invoices (customer_id, doc_type, ref_invoice_id, reason)
select customer_id, 'credit_note', id, 'خصم متفق عليه' from invoices where id = :'inv1' returning id as cn1 \gset
insert into invoice_lines (invoice_id, description, quantity, unit_price, tax_code_id)
values (:'cn1', 'خصم', 1, 2000, (select id from tax_codes where code = 'VAT15'));
select t.fails(format('select issue_invoice(%L)', :'cn1'), 'exceeds the remaining value');
update invoice_lines set unit_price = 100 where invoice_id = :'cn1';
select issue_invoice(:'cn1');
select zatca_attach(:'cn1', 'HASH-3', 'QR-3', '<Invoice/>');
select t.ok((select number from invoices where id = :'cn1') = 'CN-00001', 'credit note numbering');
select t.ok((select closing from trial_balance() where code = '1103') = 1150 + 575 - 115, 'credit note reduces AR');

-- ── 6. receipts ─────────────────────────────────────────────────────────
insert into payments (direction, purpose, account_id, amount, invoice_id)
select 'receipt', 'invoice', (select id from accounts where system_key = 'bank'), 2000, :'inv1' returning id as pay_over \gset
select t.fails(format('select post_payment(%L)', :'pay_over'), 'exceeds invoice balance');
update payments set amount = 1150 where id = :'pay_over';
select post_payment(:'pay_over');
select t.ok((select amount_paid from invoices where id = :'inv1') = 1150, 'invoice marked paid');
select t.fails(format('update payments set amount = 1 where id = %L', :'pay_over'), 'immutable');

-- ── 7. projects: BOQ, progress billing with retention & advance ────────
insert into projects (name_ar, customer_id, contract_value, retention_pct, advance_amount, advance_recovery_pct)
select 'مشروع برج الأعمال', id, 1000000, 10, 100000, 10 from customers where name_ar = 'شركة الرياض القابضة'
returning id as prj \gset
insert into project_boq_items (project_id, item_no, description, unit, quantity, unit_price) values
  (:'prj', '1', 'أعمال خرسانة', 'م3', 1000, 600),
  (:'prj', '2', 'أعمال تشطيب',  'م2', 4000, 100);
insert into project_budget_lines (project_id, category, amount) values (:'prj', 'labour', 200000), (:'prj', 'materials', 400000);

-- customer advance received (excl. VAT for simplicity of the test)
insert into payments (direction, purpose, account_id, amount, customer_id, project_id)
select 'receipt', 'customer_advance', (select id from accounts where system_key = 'bank'), 100000, customer_id, id
  from projects where id = :'prj' returning id as adv \gset
select post_payment(:'adv');

select prepare_progress_billing(:'prj', current_date) as pb1 \gset
select t.fails(format('select prepare_progress_billing(%L)', :'prj'), 'draft progress billing already exists');
update progress_billing_lines set cumulative_qty = 5000
 where billing_id = :'pb1' and boq_item_id = (select id from project_boq_items where project_id = :'prj' and item_no = '1');
select t.fails(format('select invoice_progress_billing(%L)', :'pb1'), 'exceeds the contract');
update progress_billing_lines set cumulative_qty = 200
 where billing_id = :'pb1' and boq_item_id = (select id from project_boq_items where project_id = :'prj' and item_no = '1');
update progress_billing_lines set cumulative_qty = 1000
 where billing_id = :'pb1' and boq_item_id = (select id from project_boq_items where project_id = :'prj' and item_no = '2');
select invoice_progress_billing(:'pb1') as pinv \gset
-- current gross 120000+100000 = 220000; retention 22000; advance recovery 22000
select t.ok((select (subtotal, advance_deduction, taxable_amount, vat_amount, total, retention_amount, net_payable)
                   = (220000.00, 22000.00, 198000.00, 29700.00, 227700.00, 22000.00, 205700.00)
             from invoices where id = :'pinv'), 'progress invoice: retention + advance recovery');
select issue_invoice(:'pinv');
select zatca_attach(:'pinv', 'HASH-4', 'QR-4', '<Invoice/>');
select t.ok((select closing from trial_balance() where code = '1104') = 22000, 'retention receivable booked');
select t.ok((select closing from trial_balance() where code = '2105') = -78000, 'customer advance partly recovered');
select t.ok((select revenue from project_summary(:'prj')) = 220000, 'project revenue from ledger');

-- second billing starts from the previous cumulative quantities
select prepare_progress_billing(:'prj') as pb2 \gset
select t.ok((select sum(previous_qty) from progress_billing_lines where billing_id = :'pb2') = 1200, 'second billing carries previous qty');

-- ── 8. vendor bill (subcontractor with retention) + payment ────────────
insert into vendors (name_ar, vendor_type, vat_number) values ('مؤسسة البناء المتقدم', 'subcontractor', '311111111111113') returning id as ven \gset
insert into bills (vendor_id, vendor_ref, project_id, retention_amount) values (:'ven', 'S-778', :'prj', 5000) returning id as bill \gset
insert into bill_lines (bill_id, description, account_id, quantity, unit_price, tax_code_id)
values (:'bill', 'أعمال عزل', (select id from accounts where system_key = 'cost_subcontract'), 1, 50000,
        (select id from tax_codes where code = 'VAT15'));
select t.ok((select (total, net_payable) = (57500.00, 52500.00) from bills where id = :'bill'), 'bill totals with retention');
select post_bill(:'bill');
select t.ok((select cost from project_summary(:'prj')) = 50000, 'subcontract cost hits the project');
select t.fails(format('update bills set notes = %L where id = %L', 'x', :'bill'), 'immutable');
insert into payments (direction, purpose, account_id, amount, bill_id)
values ('payment', 'bill', (select id from accounts where system_key = 'bank'), 52500, :'bill') returning id as pv \gset
select post_payment(:'pv');
select t.ok((select closing from trial_balance() where code = '2101') = 0, 'AP settled');
select t.ok((select closing from trial_balance() where code = '2106') = -5000, 'retention payable kept');

-- ── 9. payroll ──────────────────────────────────────────────────────────
insert into employees (first_name_ar, last_name_ar, nationality, hire_date, basic_salary, housing_allowance, transport_allowance, project_id)
values ('فهد', 'العتيبي', 'SA', '2020-01-01', 10000, 2500, 500, :'prj') returning id as emp_sa \gset
insert into employees (first_name_ar, last_name_ar, nationality, hire_date, basic_salary, housing_allowance, gosi_scheme)
values ('راجيش', 'كومار', 'IN', '2023-05-10', 4000, 1000, 'legacy') returning id as emp_in \gset
insert into employees (first_name_ar, last_name_ar, nationality, hire_date, basic_salary, housing_allowance)
values ('سارة', 'القحطاني', 'SA', '2026-09-16', 9000, 0) returning id as emp_mid \gset
update employees set gosi_scheme = 'new' where id = :'emp_mid';

insert into leave_requests (employee_id, leave_type, start_date, end_date, status)
values (:'emp_in', 'unpaid', '2026-09-01', '2026-09-03', 'approved') returning id as lv \gset
select t.ok((select status from leave_requests where id = :'lv') = 'pending', 'leave starts pending');
select decide_leave(:'lv', true);

select generate_payroll('2026-09') as run \gset
select t.fails($$select generate_payroll('2026-09')$$, 'already exists');
select t.ok((select (gosi_wage, gosi_employee, gosi_employer, gross, net) = (12500.00, 1218.75, 1468.75, 13000.00, 11781.25)
             from payroll_lines where run_id = :'run' and employee_id = :'emp_sa'), 'Saudi GOSI (legacy) and net');
select t.ok((select (worked_days, basic, gosi_employee, gosi_employer) = (27.00, 3600.00, 0.00, 100.00)
             from payroll_lines where run_id = :'run' and employee_id = :'emp_in'), 'non-Saudi: unpaid leave + hazards only');
-- joined on the 16th: 15 of 30 days (salary and GOSI prorated); new-scheme annuity 10% (from 2026-07-01)
select t.ok((select (worked_days, basic, gosi_wage, gosi_employee) = (15.00, 4500.00, 4500.00, 483.75)
             from payroll_lines where run_id = :'run' and employee_id = :'emp_mid'), 'mid-month hire + new GOSI scheme');
update payroll_lines set overtime = 500, advance_deduction = 1000 where run_id = :'run' and employee_id = :'emp_sa';
select t.ok((select net from payroll_lines where run_id = :'run' and employee_id = :'emp_sa') = 11281.25, 'net recomputed after edits');
select t.fails(format('select post_payroll(%L)', :'run'), 'approved payroll run not found');
select approve_payroll(:'run');
select t.fails(format('update payroll_lines set overtime = 1 where run_id = %L', :'run'), 'not a draft');
select post_payroll(:'run');
select t.ok((select status from payroll_runs where id = :'run') = 'posted', 'payroll posted');
select t.ok((select closing from trial_balance() where code = '2104')
            = -(select total_gosi_employee + total_gosi_employer from payroll_runs where id = :'run'), 'GOSI payable booked');
select t.ok((select cost from project_summary(:'prj')) > 50000, 'project staff salary charged to the project');

-- end of service
select t.ok(eosb_amount(10000, '2021-01-01', '2023-12-31', 'resignation') = round((1095/365.0) * 5000 / 3, 2), 'EOSB resignation 2–5y = ⅓');
select t.ok(eosb_amount(10000, '2024-01-01', '2025-06-30', 'resignation') = 0, 'EOSB resignation < 2y = 0');
select t.ok(eosb_amount(10000, '2015-01-01', '2024-12-31', 'employer_termination')
            = round(25000 + ((3653/365.0) - 5) * 10000, 2), 'EOSB beyond five years');
select t.ok((employee_eosb(:'emp_sa', '2026-09-30') ->> 'wage')::numeric = 13000, 'EOSB wage includes allowances');

-- ── 10. integrations ────────────────────────────────────────────────────
select create_api_key('Power BI', array['invoices:read']) as apikey \gset
select t.ok(:'apikey' ~ '^gdx_[0-9a-f]{12}_[0-9a-f]{48}$', 'API key format');
select t.fails($$select key_hash from api_keys$$, 'permission denied');
insert into webhooks (url, events) values ('https://example.com/hook', '{invoice.*}');
insert into invoices (invoice_kind) values ('simplified') returning id as inv5 \gset
insert into invoice_lines (invoice_id, description, quantity, unit_price, tax_code_id)
values (:'inv5', 'خدمة', 1, 100, (select id from tax_codes where code = 'VAT15'));
select issue_invoice(:'inv5');
select t.ok((select count(*) from webhook_deliveries) = 1, 'issued invoice enqueues exactly one matching webhook');
select t.fails($$select verify_api_key('x')$$, 'permission denied');

reset role;
set role service_role;
select t.ok((select org_id from verify_api_key(:'apikey')) = (select id from t.v where k = 'orgA'), 'service role verifies API key → org');
select t.ok((select count(*) from verify_api_key(:'apikey' || 'x')) = 0, 'tampered API key rejected');
select t.ok((select count(*) from claim_webhook_deliveries(10)) = 1, 'dispatcher claims pending delivery');
select t.ok((select count(*) from claim_webhook_deliveries(10)) = 0, 'claimed delivery is leased');
reset role;

-- ── 11. ledger integrity across everything above ───────────────────────
select t.ok((select sum(debit) = sum(credit) from journal_lines), 'global ledger balances');
select t.ok(not exists (select 1 from journal_entries e where status <> 'draft' and total <> (
              select sum(debit) from journal_lines where entry_id = e.id)), 'every posted entry balances');
select t.ok((select count(*) from journal_lines l join journal_entries e on e.id = l.entry_id where l.org_id <> e.org_id) = 0,
            'no cross-org journal lines');

\echo '  ✓ erp flow: tenancy, permissions, GL, ZATCA chain, progress billing, finance, payroll, integrations'
