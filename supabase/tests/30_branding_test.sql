-- company branding: only settings.manage may edit; format checks enforced
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);

select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
update organizations set logo_data = 'data:image/png;base64,iVBORw0KGgo=', phone = '+966500000000',
       iban = 'SA0380000000608010167519', invoice_footer = 'شكراً لتعاملكم'
 where id = (select id from t.v where k = 'orgA');
select t.ok((select logo_data is not null and iban = 'SA0380000000608010167519' from organizations where id = (select id from t.v where k = 'orgA')), 'owner updates branding');
select t.fails($$update organizations set logo_data = 'javascript:alert(1)' where id = (select id from t.v where k = 'orgA')$$, 'org_logo_data_format');
select t.fails($$update organizations set iban = 'SA12' where id = (select id from t.v where k = 'orgA')$$, 'org_iban_format');

-- a sales user cannot change company details (policy filters the row → 0 rows)
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
update organizations set phone = 'hacked' where id = (select id from t.v where k = 'orgA');
select t.ok((select phone from organizations where id = (select id from t.v where k = 'orgA')) = '+966500000000', 'sales role cannot edit company');
reset role;
\echo '  ✓ company branding: owner edits, formats validated, other roles blocked'
