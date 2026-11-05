-- Quotations: one-call save with totals, status flow with revisions, accepted → project with BOQ
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

-- a prospect not yet in the customers list
select save_quotation(jsonb_build_object(
  'prospect_name', 'شركة الأفق للتطوير', 'prospect_phone', '0500000000', 'title', 'تشطيب مبنى إداري',
  'valid_until', current_date + 15, 'terms', '50% دفعة مقدمة',
  'lines', jsonb_build_array(
    jsonb_build_object('item_no', '1.1', 'description', 'لياسة', 'unit', 'م2', 'quantity', 1000, 'unit_price', 35),
    jsonb_build_object('description', 'دهانات', 'unit', 'م2', 'quantity', 800.5, 'unit_price', 20.10, 'vat_rate', 15),
    jsonb_build_object('description', 'رسوم بلدية (خارج الضريبة)', 'quantity', 1, 'unit_price', 1000, 'vat_rate', 0)))) as q \gset
select t.ok((select number like 'QUO-%' and status = 'draft' and subtotal = 35000 + 16090.05 + 1000
                    and vat_amount = round(35000 * 0.15, 2) + round(16090.05 * 0.15, 2) and total = subtotal + vat_amount
               from quotations where id = :'q'), 'numbered draft with totals and per-line VAT');
select t.ok((select count(*) from quotation_lines where quotation_id = :'q') = 3, 'three lines');

-- validation and direct writes
select t.fails($$select save_quotation('{"title":"x","lines":[{"description":"a","quantity":1,"unit_price":1}]}')$$, 'customer or enter the prospect');
select t.fails($$select save_quotation('{"title":"x","prospect_name":"p","lines":[]}')$$, 'at least one line');
select t.fails($$select save_quotation('{"title":"x","prospect_name":"p","lines":[{"description":"a","quantity":0,"unit_price":1}]}')$$, 'check constraint');
select t.fails(format($$update quotations set status = 'accepted' where id = '%s'$$, :'q'), 'permission denied');
select t.fails(format($$insert into quotation_lines (quotation_id, line_no, description, quantity, unit_price) values ('%s', 9, 'x', 1, 1)$$, :'q'), 'permission denied');

-- edit the draft: lines replaced, totals follow
select save_quotation(jsonb_build_object('id', :'q', 'prospect_name', 'شركة الأفق للتطوير', 'title', 'تشطيب مبنى إداري',
  'lines', jsonb_build_array(jsonb_build_object('item_no', '1.1', 'description', 'لياسة', 'unit', 'م2', 'quantity', 1200, 'unit_price', 35),
                             jsonb_build_object('item_no', '1.2', 'description', 'دهانات', 'unit', 'م2', 'quantity', 900, 'unit_price', 20))));
select t.ok((select subtotal = 60000 and vat_amount = 9000 and total = 69000 from quotations where id = :'q'), 'totals follow the edit');

-- status flow: send, revise, send again, accept
select set_quotation_status(:'q', 'sent');
select t.fails(format($$select save_quotation('{"id":"%s","title":"x","prospect_name":"p","lines":[{"description":"a","quantity":1,"unit_price":1}]}')$$, :'q'), 'draft quotation not found');
select set_quotation_status(:'q', 'draft');
select t.ok((select revision = 1 and status = 'draft' from quotations where id = :'q'), 'back to draft for a revision');
select set_quotation_status(:'q', 'sent');
select t.fails(format($$select set_quotation_status('%s', 'rejected')$$, :'q'), 'rejection reason');
select t.fails(format($$select quotation_to_project('%s')$$, :'q'), 'only an accepted quotation');
select set_quotation_status(:'q', 'accepted');
select t.fails(format($$select set_quotation_status('%s', 'draft')$$, :'q'), 'cannot change a accepted quotation');
select t.fails(format($$delete from quotations where id = '%s'$$, :'q'), 'cannot be deleted');

-- accepted → project: customer created from the prospect, contract value and BOQ from the lines
select quotation_to_project(:'q') as prj \gset
select t.ok((select p.contract_value = 60000 and p.name_ar = 'تشطيب مبنى إداري' and c.name_ar = 'شركة الأفق للتطوير' and c.phone = '0500000000'
               from projects p join customers c on c.id = p.customer_id where p.id = :'prj'), 'project and customer created');
select t.ok((select count(*) = 2 and sum(amount) = 60000 and min(item_no) = '1.1' from project_boq_items where project_id = :'prj'), 'BOQ from the quotation lines');
select t.ok((select project_id = :'prj' and customer_id is not null from quotations where id = :'q'), 'quotation linked to the project');
select t.fails(format($$select quotation_to_project('%s')$$, :'q'), 'already a project');

-- a rejected quotation keeps its reason; a draft can be deleted
select save_quotation(jsonb_build_object('customer_id', (select id from customers where name_ar = 'شركة الأفق للتطوير'), 'title', 'صيانة',
  'lines', jsonb_build_array(jsonb_build_object('description', 'صيانة شهرية', 'quantity', 12, 'unit_price', 5000)))) as q2 \gset
select set_quotation_status(:'q2', 'sent');
select set_quotation_status(:'q2', 'rejected', 'السعر أعلى من الميزانية');
select t.ok((select status = 'rejected' and reject_reason = 'السعر أعلى من الميزانية' from quotations where id = :'q2'), 'rejection reason kept');
select save_quotation(jsonb_build_object('prospect_name', 'س', 'title', 'مسودة', 'lines', jsonb_build_array(jsonb_build_object('description', 'x', 'quantity', 1, 'unit_price', 1)))) as q3 \gset
delete from quotations where id = :'q3';
select t.ok(not exists (select 1 from quotation_lines where quotation_id = :'q3'), 'draft deleted with its lines');

-- a sales user manages quotations but cannot turn one into a project; org B sees nothing
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.ok((select count(*) from quotations) >= 2, 'sales reads quotations');
select t.fails(format($$select quotation_to_project('%s')$$, :'q2'), 'permission denied: projects.manage');
select t.act('00000000-0000-0000-0000-00000000000b', (select id from t.v where k = 'orgB'));
select t.ok((select count(*) from quotations) = 0, 'org B sees no quotations');
reset role;
\echo '  ✓ quotations: totals, revisions, accept → project with BOQ, permissions'
