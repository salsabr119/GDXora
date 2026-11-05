-- Claims: variation orders join the BOQ and the next billing; retention release never exceeds what is held
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));
select id as prj from projects where name_ar = 'مشروع برج الأعمال' \gset

-- ── variation order ─────────────────────────────────────────────────────
select add_variation_order(:'prj', jsonb_build_object('variation_no', 'VO-01', 'variation_date', '2026-09-01', 'variation_ref', 'خطاب المالك 55/2026',
  'items', jsonb_build_array(jsonb_build_object('description', 'أعمال عزل إضافية', 'unit', 'م2', 'quantity', 500, 'unit_price', 40),
                             jsonb_build_object('item_no', 'V1.2', 'description', 'مظلات مواقف', 'unit', 'مقطوعية', 'quantity', 1, 'unit_price', 30000)))) as n \gset
select t.ok(:n = 2, 'two variation items added');
select t.ok((select count(*) = 2 and sum(amount) = 50000 and min(item_no) = 'V1.2' and max(item_no) = 'VO-01-1' and bool_and(variation_ref = 'خطاب المالك 55/2026')
               from project_boq_items where project_id = :'prj' and variation_no = 'VO-01'), 'items carry the order number, date and reference');
select t.ok((select min(sort) > (select max(sort) from project_boq_items where project_id = :'prj' and variation_no is null)
               from project_boq_items where project_id = :'prj' and variation_no = 'VO-01'), 'variation items listed after the contract items');
select t.fails(format($$select add_variation_order('%s', '{"variation_no":"VO-01","items":[{"description":"x","quantity":1,"unit_price":1}]}')$$, :'prj'), 'already exists');
select t.fails(format($$select add_variation_order('%s', '{"variation_no":"VO-02","items":[{"description":"x","quantity":0,"unit_price":1}]}')$$, :'prj'), 'quantity above zero');
select t.fails(format($$select add_variation_order('%s', '{"items":[{"description":"x","quantity":1,"unit_price":1}]}')$$, :'prj'), 'needs a number');

-- the next billing picks the variation items up with nothing billed before
delete from progress_billings where project_id = :'prj' and status = 'draft';   -- left by the ERP flow test
select prepare_progress_billing(:'prj', current_date) as pb \gset
select t.ok((select count(*) = 2 and sum(previous_qty) = 0 from progress_billing_lines l join project_boq_items b on b.id = l.boq_item_id
              where l.billing_id = :'pb' and b.variation_no = 'VO-01'), 'next billing includes the variation items');
delete from progress_billings where id = :'pb';

-- ── retention release ───────────────────────────────────────────────────
select t.ok((select held = 22000 and claimed = 0 and received = 0 and available = 22000 from project_retention(:'prj')), 'retention held from the issued invoice');
select create_retention_release(:'prj', 12000, current_date, 'completion', 'استلام ابتدائي') as r1 \gset
select t.ok((select number like 'RET-%' and amount = 12000 and customer_id is not null from retention_releases where id = :'r1'), 'numbered claim for the customer');
select t.ok((select claimed = 12000 and available = 10000 from project_retention(:'prj')), 'claimed amount leaves the rest available');
select t.fails(format($$select create_retention_release('%s', 10000.01)$$, :'prj'), 'exceeds the retention still held');
select t.fails(format($$select create_retention_release('%s', 0)$$, :'prj'), 'above zero');
select t.fails(format($$update retention_releases set amount = 1 where id = '%s'$$, :'r1'), 'permission denied');
select t.fails(format($$delete from retention_releases where id = '%s'$$, :'r1'), 'permission denied');

-- received with a receipt voucher against the retention account
insert into payments (direction, purpose, account_id, amount, counter_account_id, project_id, memo)
values ('receipt', 'other', (select id from accounts where system_key = 'bank'), 12000, (select id from accounts where system_key = 'retention_receivable'), :'prj', 'محتجزات')
returning id as pay \gset
select post_payment(:'pay');
select t.ok((select received = 12000 and outstanding = 10000 from project_retention(:'prj')), 'receipt reduces the outstanding retention');

-- a sales user reads the figures but cannot claim; org B sees nothing
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.ok((select held = 22000 from project_retention(:'prj')), 'sales reads the retention figures');
select t.fails(format($$select create_retention_release('%s', 1)$$, :'prj'), 'permission denied: projects.manage');
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
select t.ok((select held = 0 from project_retention(:'prj')), 'org B sees no retention of org A');
select t.fails(format($$select add_variation_order('%s', '{"variation_no":"X","items":[{"description":"x","quantity":1,"unit_price":1}]}')$$, :'prj'), 'project not found');
reset role;
\echo '  ✓ claims: variation orders join the BOQ and billings; retention release capped and tracked'
