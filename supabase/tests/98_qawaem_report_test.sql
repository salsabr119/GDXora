-- report_qawaem: Global Drive's 2025 filing figures, then a second year with
-- depreciation, a receivable and a rounding difference
\set QUIET on
set client_min_messages = warning;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner@gd.test', '{"full_name":"GD Owner"}');
create or replace function t.acc(p_key text) returns uuid language sql stable as $$
  select id from accounts where system_key = p_key
$$;
-- a posted journal entry: pairs of (account key, debit, credit)
create or replace function t.je(p_date date, p_memo text, p_lines jsonb) returns uuid language sql as $$
  select create_journal(p_date, p_memo,
           (select jsonb_agg(jsonb_build_object('account_id', t.acc(x ->> 0), 'debit', (x ->> 1)::numeric, 'credit', (x ->> 2)::numeric))
              from jsonb_array_elements(p_lines) x), true)
$$;
grant execute on function t.acc(text), t.je(date, text, jsonb) to authenticated;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-0000000000e1', null);
insert into t.v select 'orgGD', create_organization('شركة انطلاقة العالم', 'Global Drive');
select t.act('00000000-0000-0000-0000-0000000000e1', (select id from t.v where k = 'orgGD'));

-- ── 2025 (first year) ───────────────────────────────────────────────────
select t.je('2025-01-05', 'رأس المال', '[["bank", 2315, 0], ["capital_unpaid", 47685, 0], ["capital", 0, 50000]]');
select t.je('2025-01-10', 'قرض',       '[["bank", 50000, 0], ["loans_long", 0, 50000]]');
select t.je('2025-02-01', 'معدات',      '[["equipment", 6449, 0], ["bank", 0, 6449]]');
select t.je('2025-06-30', 'إيرادات',    '[["bank", 61455, 0], ["revenue_services", 0, 61455]]');
select t.je('2025-12-31', 'مصاريف',     '[["rent", 95546, 0], ["bank", 0, 95546]]');

select report_qawaem(2025) as r \gset
select t.ok((:'r'::jsonb -> 'landing') = '{"revenue": 61455, "total_assets": 18224, "employees": 0}', 'landing page');
select t.ok((:'r'::jsonb -> 'inputs' ->> 'first_time')::boolean, 'first filing since establishment');
select t.ok((:'r'::jsonb -> 'bs') @> '{"2": 11775, "3": 0, "7": 6449, "13": 18224, "16": 50000, "23": 50000,
                                       "25": 2315, "26": -34091, "29": -31776, "31": -31776, "32": 18224}', 'balance sheet');
select t.ok((select count(*) from jsonb_object_keys(:'r'::jsonb -> 'bs')) = 28, 'every balance-sheet line present (zeros included)');
select t.ok((:'r'::jsonb -> 'pl') @> '{"2": 61455, "4": 0, "13": 95546, "18": 0, "23": -34091}', 'profit or loss: expenses positive');
select t.ok((:'r'::jsonb -> 'oci') @> '{"9": -34091}', 'comprehensive income = net loss');
select t.ok((:'r'::jsonb -> 'cf') @> '{"operating": -34091, "16": 6449, "investing": -6449, "20": 2315, "21": 50000,
                                       "financing": 52315, "27": 0, "28": 11775}', 'cash flow');
select t.ok((:'r'::jsonb -> 'soce' -> '1' ->> 'total')::numeric = 0, 'equity opens at zero');
select t.ok((:'r'::jsonb -> 'soce' -> '9') @> '{"capital": 2315, "retained": 0}', 'paid capital as an other change');
select t.ok((:'r'::jsonb -> 'soce' -> '11') @> '{"capital": 2315, "retained": -34091, "total": -31776}', 'equity closes at the balance sheet');
select t.ok(not exists (select 1 from jsonb_array_elements(:'r'::jsonb -> 'checks') c where c ->> 'severity' = 'error' and not (c ->> 'ok')::boolean),
            'all consistency checks pass');
select t.ok(exists (select 1 from jsonb_array_elements(:'r'::jsonb -> 'checks') c where c ->> 'key' = 'half_capital' and not (c ->> 'ok')::boolean),
            'losses above half the capital flagged');
select t.ok(exists (select 1 from jsonb_array_elements(:'r'::jsonb -> 'checks') c where c ->> 'key' = 'negative_equity' and not (c ->> 'ok')::boolean),
            'negative equity flagged');
select t.ok((:'r'::jsonb ->> 'rounding')::numeric = 0, 'whole riyals: no rounding difference');

-- ── 2026: depreciation, a receivable, fractions that round ───────────────
select t.je('2026-03-31', 'فاتورة',  '[["ar", 5000.60, 0], ["revenue_services", 0, 5000.60]]');
select t.je('2026-12-31', 'إهلاك',   '[["depreciation", 1000.40, 0], ["accum_depreciation", 0, 1000.40]]');
select create_journal('2026-12-15', 'مسودة', jsonb_build_array(
  jsonb_build_object('account_id', t.acc('rent'), 'debit', 10), jsonb_build_object('account_id', t.acc('bank'), 'credit', 10)), false);

select report_qawaem(2026) as r \gset
select t.ok(not (:'r'::jsonb -> 'inputs' ->> 'first_time')::boolean, 'second year is not the first filing');
select t.ok((:'r'::jsonb -> 'bs') @> '{"2": 11775, "3": 5001, "7": 5449, "13": 22225, "26": -30090, "31": -27775, "32": 22225}',
            'rounded balance sheet, difference in retained earnings');
select t.ok((:'r'::jsonb ->> 'rounding')::numeric = 1, 'rounding difference reported');
select t.ok((:'r'::jsonb -> 'pl') @> '{"2": 5001, "13": 1000, "23": 4001}', 'profit or loss');
select t.ok((:'r'::jsonb -> 'cf') @> '{"4": 1000, "10": -5001, "operating": 0, "16": 0, "27": 11775, "28": 11775}', 'cash flow with depreciation');
select t.ok((:'r'::jsonb -> 'soce' -> '1') @> '{"retained": -34091, "total": -31776}', 'opens at last year''s close');
select t.ok((:'r'::jsonb -> 'soce' -> '11') @> '{"retained": -30090, "total": -27775}', 'closes at this year''s balance sheet');
select t.ok(not exists (select 1 from jsonb_array_elements(:'r'::jsonb -> 'checks') c where c ->> 'severity' = 'error' and not (c ->> 'ok')::boolean),
            'consistency checks pass after rounding');
select t.ok(exists (select 1 from jsonb_array_elements(:'r'::jsonb -> 'checks') c where c ->> 'key' = 'drafts' and not (c ->> 'ok')::boolean),
            'draft entries in the year flagged');

-- a remapped account moves its amount; another company cannot read this report
update qawaem_line_map set line_no = 12 where account_id = t.acc('ar');
select t.ok((report_qawaem(2026) -> 'bs') @> '{"3": 0, "12": 5001}', 'line map override respected');
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgGD'));
select t.fails($$select report_qawaem(2026)$$, 'no active organization');
reset role;
\echo '  ✓ Qawaem report: Global Drive 2025 figures, rounding, cash flow and equity reconcile'
