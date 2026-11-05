-- Letterhead: members read it, only company settings change it, one per company
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

insert into org_letterhead (image_data, top_mm) values ('data:image/jpeg;base64,/9j/AAAA', 45);
select t.ok((select top_mm = 45 and bottom_mm = 25 and org_id = current_org_id() from org_letterhead), 'letterhead saved with default margins');
select t.fails($$insert into org_letterhead (image_data) values ('data:image/jpeg;base64,/9j/BBBB')$$, 'duplicate key');
select t.fails($$update org_letterhead set image_data = 'https://example.com/x.png'$$, 'org_letterhead_image');
select t.fails($$update org_letterhead set top_mm = 200$$, 'check constraint');
update org_letterhead set bottom_mm = 30;
select t.ok((select bottom_mm = 30 from org_letterhead), 'margins updated');

-- a member without settings.manage reads it but cannot change it
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from org_letterhead) = 1, 'any member reads the letterhead');
update org_letterhead set top_mm = 10;
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select t.ok((select top_mm = 45 from org_letterhead), 'members without settings.manage cannot change it');

-- another company sees nothing
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
select t.ok((select count(*) from org_letterhead) = 0, 'org B cannot read org A letterhead');
reset role;
\echo '  ✓ letterhead: one per company, readable by members, changed only with settings.manage'
