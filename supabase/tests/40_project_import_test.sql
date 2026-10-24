-- project import: atomic insert of project + BOQ (+ new customer); a project
-- already under way continues billing from its paper billings
\set QUIET on
set client_min_messages = warning;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', false);
select t.act('00000000-0000-0000-0000-00000000000a', (select id from t.v where k = 'orgA'));

select import_project($j${
  "project": {"code": "IMP-1", "name_ar": "مشروع مستورد", "contract_value": 100000, "retention_pct": 10,
              "advance_amount": 20000, "advance_recovery_pct": 20, "status": "active",
              "opening_billing_count": 2, "opening_advance_recovered": 6000},
  "new_customer": {"name_ar": "عميل مستورد", "vat_number": "311111111111113", "building_no": "1234", "street": "شارع",
                   "district": "حي", "city": "الرياض", "postal_code": "12345"},
  "boq": [{"item_no": "1", "description": "حفر", "unit": "م3", "quantity": 1000, "unit_price": 50, "opening_billed_qty": 400},
          {"item_no": "2", "description": "خرسانة", "unit": "م3", "quantity": 100, "unit_price": 500}]
}$j$::jsonb) as prj \gset
select t.ok((select count(*) = 2 from project_boq_items where project_id = :'prj'), 'BOQ imported');
select t.ok((select c.name_ar = 'عميل مستورد' from projects p join customers c on c.id = p.customer_id where p.id = :'prj'), 'new customer created and linked');
select t.ok((select sort from project_boq_items where project_id = :'prj' and item_no = '2') = 2, 'BOQ keeps file order');

-- next billing is no. 3 and starts from the 400 m3 billed on paper
select prepare_progress_billing(:'prj') as pb \gset
select t.ok((select billing_no from progress_billings where id = :'pb') = 3, 'billing number continues after paper billings');
select t.ok((select previous_qty from progress_billing_lines l join project_boq_items b on b.id = l.boq_item_id
              where l.billing_id = :'pb' and b.item_no = '1') = 400, 'previous quantity starts from opening billed qty');
update progress_billing_lines set cumulative_qty = 600
 where billing_id = :'pb' and boq_item_id = (select id from project_boq_items where project_id = :'prj' and item_no = '1');
select invoice_progress_billing(:'pb') as inv \gset
-- current = 200 m3 × 50 = 10,000; advance recovery 20% = 2,000 (14,000 left of 20,000)
select t.ok((select current_gross = 10000 and previous_gross = 20000 and advance_recovery = 2000 from progress_billings where id = :'pb'),
            'billing amounts account for paper billings');

-- opening advance cannot exceed the advance; opening qty cannot exceed the BOQ qty
select t.fails($$select import_project('{"project": {"name_ar": "x", "advance_amount": 100, "opening_advance_recovered": 200}}'::jsonb)$$, 'project_opening_advance');
select t.fails($$select import_project('{"project": {"name_ar": "y"}, "boq": [{"description": "a", "quantity": 1, "unit_price": 1, "opening_billed_qty": 5}]}'::jsonb)$$, 'boq_opening_within_qty');
-- all or nothing: the failed imports left no project behind
select t.ok((select count(*) from projects where name_ar in ('x', 'y')) = 0, 'failed import leaves nothing behind');

-- a sales user (no projects.manage) cannot import
select t.act('00000000-0000-0000-0000-00000000000c', (select id from t.v where k = 'orgA'));
select t.fails($$select import_project('{"project": {"name_ar": "z"}}'::jsonb)$$, 'permission denied');
reset role;
\echo '  ✓ project import: atomic, new customer, opening quantities and billing number carried forward'
