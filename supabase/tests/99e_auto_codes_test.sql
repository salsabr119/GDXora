-- Automatic codes skip codes already taken by hand or by an import
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

-- the next two numbers the sequence would hand out are already used by hand
select prefix || lpad(next_value::text, pad, '0') as n1, prefix || lpad((next_value + 1)::text, pad, '0') as n2
  from doc_sequences where org_id = current_org_id() and doc_type = 'PRJ' \gset
insert into projects (code, name_ar) values (:'n1', 'مشروع برمز يدوي 1'), (:'n2', 'مشروع برمز يدوي 2');
insert into projects (name_ar) values ('مشروع برمز تلقائي') returning code as auto \gset
select t.ok(:'auto' not in (:'n1', :'n2') and :'auto' like 'PRJ-%', 'automatic code skips the taken numbers');
select t.ok((select count(*) from projects where code = :'auto') = 1, 'automatic code is unique');

-- the same for customers
select prefix || lpad(next_value::text, pad, '0') as c1 from doc_sequences where org_id = current_org_id() and doc_type = 'CUS' \gset
insert into customers (code, name_ar) values (:'c1', 'عميل برمز يدوي');
insert into customers (name_ar) values ('عميل برمز تلقائي') returning code as cauto \gset
select t.ok(:'cauto' <> :'c1', 'customer code skips the taken number');

-- a code typed by hand that is taken still fails, naming the code
select t.fails(format($$insert into projects (code, name_ar) values ('%s', 'x')$$, :'auto'), 'duplicate key');
reset role;
\echo '  ✓ automatic codes: never collide with codes entered by hand or imported'
