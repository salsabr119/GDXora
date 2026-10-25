-- ZATCA phase 2: secrets are service-only; results are recorded once accepted
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.ok((zatca_onboarding_status() ->> 'active')::boolean = false, 'not onboarded yet');
select t.fails($$select * from zatca_egs$$, 'permission denied');
select t.fails($$insert into zatca_egs (org_id, environment, unit_name, egs_name) values (current_org_id(), 'sandbox', 'x', 'y')$$, 'permission denied');

-- the service (API) records an EGS; the user sees only the summary
reset role;
insert into zatca_egs (org_id, environment, status, unit_name, egs_name, private_key_enc, production_secret_enc, activated_at)
values ((select id from t.v where k = 'orgA'), 'sandbox', 'active', 'الرياض', 'EGS-1', 'secret!', 'secret!', now());
set role authenticated;
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.ok((zatca_onboarding_status() ->> 'active')::boolean and zatca_onboarding_status() ->> 'egs_name' = 'EGS-1'
            and not (zatca_onboarding_status() ? 'private_key_enc'), 'summary without secrets');

-- results: only for signed invoices, and an accepted invoice is final
select id as inv from invoices where status = 'issued' and zatca_hash is not null order by zatca_icv limit 1 \gset
select zatca_set_result(:'inv', 'rejected', '{"errors": ["x"]}');
select zatca_set_result(:'inv', 'cleared', '{}', '<Invoice/>', 'QRDATA');
select t.ok((select zatca_status = 'cleared' and zatca_xml = '<Invoice/>' and zatca_qr = 'QRDATA' from invoices where id = :'inv'), 'cleared XML and QR stored');
select t.fails(format($$select zatca_set_result('%s', 'rejected', '{}')$$, :'inv'), 'already accepted');
select t.fails(format($$select zatca_set_result('%s', 'bogus', '{}')$$, :'inv'), 'invalid ZATCA status');
reset role;
\echo '  ✓ ZATCA phase 2: secrets service-only, summary safe, results recorded once'
