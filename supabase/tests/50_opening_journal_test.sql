-- manual / opening journals keep the line party; parties must belong to the org
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

insert into customers (name_ar) values ('عميل رصيد افتتاحي');
select create_journal(date '2026-01-01', 'الأرصدة الافتتاحية', jsonb_build_array(
  jsonb_build_object('account_id', (select id from accounts where system_key = 'ar'), 'debit', 5000,
                     'party_type', 'customer', 'party_id', (select id from customers where name_ar = 'عميل رصيد افتتاحي')),
  jsonb_build_object('account_id', (select id from accounts where system_key = 'bank'), 'debit', 15000),
  jsonb_build_object('account_id', (select id from accounts where type = 'equity' and not is_group order by code limit 1), 'credit', 20000)
), false, 'opening') as je \gset
select t.ok((select source_type = 'opening' and status = 'draft' from journal_entries where id = :'je'), 'opening entry saved as draft');
select t.ok((select party_type = 'customer' from journal_lines where entry_id = :'je' and debit = 5000), 'line keeps its party');

-- editing the draft keeps parties too
select update_journal_draft(:'je', date '2026-01-01', 'الأرصدة الافتتاحية', (
  select jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', debit, 'credit', credit, 'party_type', party_type, 'party_id', party_id) order by line_no)
    from journal_lines where entry_id = :'je'), true);
select t.ok((select status = 'posted' from journal_entries where id = :'je'), 'opening entry posted');
select t.ok((select count(*) = 1 from journal_lines where entry_id = :'je' and party_type = 'customer'), 'party survives edit + post');

-- a party from another company is refused; party type and party go together
select t.fails(format($$select create_journal(current_date, 'x', '[{"account_id": "%s", "debit": 1, "party_type": "customer", "party_id": "%s"},
                                                                  {"account_id": "%s", "credit": 1}]')$$,
               (select id from accounts where system_key = 'ar'), gen_random_uuid(), (select id from accounts where system_key = 'bank')), 'party not found');
select t.fails(format($$select create_journal(current_date, 'x', '[{"account_id": "%s", "debit": 1, "party_type": "customer"}, {"account_id": "%s", "credit": 1}]')$$,
               (select id from accounts where system_key = 'ar'), (select id from accounts where system_key = 'bank')), 'go together');
select t.fails($$select create_journal(current_date, 'x', '[]', false, 'invoice')$$, 'invalid journal source');
reset role;
\echo '  ✓ journals: line parties kept on create/edit, opening entries, foreign parties refused'
