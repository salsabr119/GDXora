-- Qawaem line map: every account has a line, the filing accounts exist, overrides are validated
\set QUIET on
set client_min_messages = warning;
create or replace function t.line(p_key text) returns text language sql stable as $$
  select m.statement || ':' || m.line_no from qawaem_line_map m join accounts a on a.id = m.account_id where a.system_key = p_key
$$;
grant execute on function t.line(text) to authenticated;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

-- the accounts the filing needs
select t.ok((select count(*) from accounts where system_key in ('loans_short','loans_long','zakat_payable','zakat_expense','capital_unpaid')) = 5,
            'loans, zakat and unpaid capital accounts seeded');
select t.ok((select code = '2202' and type = 'liability' and parent_id = (select id from accounts where code = '22') from accounts where system_key = 'loans_long'),
            'long-term loans under non-current liabilities');

-- every posting account has a line
select t.ok(not exists (select 1 from accounts a where not a.is_group
                          and not exists (select 1 from qawaem_line_map m where m.account_id = a.id)), 'every posting account is mapped');
select t.ok(not exists (select 1 from qawaem_line_map m join accounts a on a.id = m.account_id where a.is_group), 'group accounts are not mapped');

select t.ok(t.line('cash') = 'BS:2' and t.line('bank') = 'BS:2', 'cash and bank → BS 2');
select t.ok(t.line('ar') = 'BS:3' and t.line('unbilled') = 'BS:3', 'receivables → BS 3');
select t.ok(t.line('accum_depreciation') = 'BS:7', 'accumulated depreciation nets into PP&E');
select t.ok(t.line('loans_short') = 'BS:16' and t.line('loans_long') = 'BS:16', 'loans → BS 16');
select t.ok(t.line('zakat_payable') = 'BS:18' and t.line('vat_output') = 'BS:19', 'zakat and VAT payable');
select t.ok(t.line('eosb_provision') = 'BS:21', 'end of service → BS 21');
select t.ok(t.line('capital') = 'BS:25' and t.line('capital_unpaid') = 'BS:25', 'capital and unpaid capital → BS 25');
select t.ok(t.line('retained_earnings') = 'BS:26', 'retained earnings → BS 26');
select t.ok(t.line('revenue_services') = 'PL:2' and t.line('revenue_other') = 'PL:9', 'revenue lines');
select t.ok(t.line('cost_labour') = 'PL:4' and t.line('cost_materials') = 'PL:4', 'project costs → cost of sales');
select t.ok(t.line('depreciation') = 'PL:13' and t.line('subscriptions') = 'PL:13', 'G&A → PL 13');
select t.ok(t.line('zakat_expense') = 'PL:18', 'zakat expense → PL 18');

-- an account added later gets its default line
insert into accounts (code, parent_id, name_ar, type) values ('1110', (select id from accounts where code = '11'), 'تأمينات مستردة', 'asset');
select t.ok((select m.statement = 'BS' and m.line_no = 12 from qawaem_line_map m join accounts a on a.id = m.account_id where a.code = '1110'),
            'new asset account → other assets');
insert into accounts (code, parent_id, name_ar, type) values ('1204', (select id from accounts where code = '12'), 'برامج', 'asset');
select t.ok((select m.line_no = 7 from qawaem_line_map m join accounts a on a.id = m.account_id where a.code = '1204'), 'new non-current asset → PP&E');

-- the company can move an account to another line; invalid choices are refused
update qawaem_line_map set line_no = 8 where account_id = (select id from accounts where code = '1204');
select t.ok((select line_no = 8 from qawaem_line_map where account_id = (select id from accounts where code = '1204')), 'override saved');
select t.fails($$update qawaem_line_map set line_no = 13 where account_id = (select id from accounts where code = '1204')$$, 'qawaem_line_valid');
select t.fails($$update qawaem_line_map set statement = 'PL', line_no = 5 where account_id = (select id from accounts where code = '1204')$$, 'qawaem_line_valid');
select t.fails($$insert into qawaem_line_map (account_id, statement, line_no) values ((select id from accounts where code = '11'), 'BS', 12)$$, 'group account');

-- another company sees none of these rows
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
select t.ok(not exists (select 1 from qawaem_line_map m join accounts a on a.id = m.account_id where a.code = '1204'), 'org B cannot see org A map');
reset role;
\echo '  ✓ Qawaem line map: defaults from system keys, new accounts mapped, overrides validated'
