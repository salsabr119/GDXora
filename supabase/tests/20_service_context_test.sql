-- service_role + x-org-id header = trusted API context; anyone else claiming
-- the service role through a header cannot, because the role comes from the JWT.
\set QUIET on
set client_min_messages = warning;

-- a plain authenticated user who is not a member gets nothing even with a valid org id
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false),
       set_config('request.jwt.claim.role', 'authenticated', false),
       set_config('request.headers', json_build_object('x-org-id', (select id from t.v where k = 'orgA'))::text, false);
select t.ok(current_org_id() is null, 'non-member gets no org');
reset role;

-- the API server: service role, org from the API key
set role service_role;
select set_config('request.jwt.claim.sub', '', false),
       set_config('request.jwt.claim.role', 'service_role', false),
       set_config('request.headers', json_build_object('x-org-id', (select id from t.v where k = 'orgA'))::text, false);
select t.ok(current_org_id() = (select id from t.v where k = 'orgA'), 'service context resolves org from header');
select t.ok(has_perm('sales.issue'), 'service context may call business RPCs');
select t.ok((select count(*) from trial_balance()) > 0, 'reports work in service context');

insert into invoices (org_id, invoice_kind) values ((select id from t.v where k = 'orgA'), 'simplified') returning id as api_inv \gset
insert into invoice_lines (org_id, invoice_id, description, quantity, unit_price, tax_code_id)
values ((select id from t.v where k = 'orgA'), :'api_inv', 'API line', 1, 200,
        (select id from tax_codes where org_id = (select id from t.v where k = 'orgA') and code = 'VAT15'));
-- previous invoice (inv5) has no hash yet → chain must block, even for the API
select t.fails(format('select issue_invoice(%L)', :'api_inv'), 'pending ZATCA');

-- suspended org → API context disabled
reset role;
update organizations set status = 'suspended' where id = (select id from t.v where k = 'orgB');
set role service_role;
select set_config('request.headers', json_build_object('x-org-id', (select id from t.v where k = 'orgB'))::text, false);
select t.ok(current_org_id() is null, 'suspended org has no API context');
reset role;
select set_config('request.jwt.claim.role', '', false);
\echo '  ✓ service context: trusted API org, non-members and suspended orgs rejected'

-- delete guards
set role authenticated;
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.fails($$delete from bills where status = 'posted'$$, 'cannot be deleted once posted');
select t.fails($$delete from payments where status = 'posted'$$, 'cannot be deleted once posted');
select t.fails($$delete from payroll_runs where status = 'posted'$$, 'cannot be deleted once posted');
select t.fails($$delete from progress_billings where status = 'invoiced'$$, 'cannot be deleted once invoiced');
select t.fails($$update org_members set active = false where is_owner$$, 'owner cannot be removed');
select t.fails($$update org_members set is_owner = false$$, 'permission denied');
select t.ok((select count(*) from org_members where email is not null) = 2, 'member e-mails captured');
reset role;
\echo '  ✓ delete guards and owner protection'
