-- GDXora · 0012 — Projects already under way when they enter the system, and
-- an atomic project import (project + BOQ + optional new customer).
--
-- opening_billed_qty    quantity of a BOQ item already billed on paper
-- opening_billing_count number of progress billings issued before the system
-- opening_advance_recovered advance already recovered in those billings
-- The next progress billing starts from these, so nothing is billed twice.

alter table projects
  add column opening_billing_count int not null default 0 check (opening_billing_count >= 0),
  add column opening_advance_recovered numeric(18,2) not null default 0 check (opening_advance_recovered >= 0),
  add constraint project_opening_advance check (opening_advance_recovered <= advance_amount);
alter table project_boq_items
  add column opening_billed_qty numeric(18,3) not null default 0 check (opening_billed_qty >= 0),
  add constraint boq_opening_within_qty check (opening_billed_qty <= quantity);

-- start the next progress billing for a project, prefilled from the BOQ and the previous billing
create or replace function prepare_progress_billing(p_project uuid, p_period_to date default current_date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('projects.manage'); v_id uuid; v_no int; v_prev uuid;
begin
  if not exists (select 1 from projects where id = p_project and org_id = v_org) then raise exception 'project not found'; end if;
  if exists (select 1 from progress_billings where project_id = p_project and status = 'draft') then
    raise exception 'a draft progress billing already exists for this project';
  end if;
  select id into v_prev from progress_billings where project_id = p_project order by billing_no desc limit 1;
  select greatest(coalesce(max(billing_no),0), (select opening_billing_count from projects where id = p_project)) + 1
    into v_no from progress_billings where project_id = p_project;

  insert into progress_billings (org_id, project_id, billing_no, period_to)
  values (v_org, p_project, v_no, p_period_to) returning id into v_id;

  insert into progress_billing_lines (org_id, billing_id, boq_item_id, previous_qty, cumulative_qty, unit_price)
  select v_org, v_id, b.id, coalesce(pl.cumulative_qty, b.opening_billed_qty), coalesce(pl.cumulative_qty, b.opening_billed_qty), b.unit_price
    from project_boq_items b
    left join progress_billing_lines pl on pl.billing_id = v_prev and pl.boq_item_id = b.id
   where b.project_id = p_project;
  return v_id;
end $$;

-- turn a draft progress billing into a draft invoice (retention + advance recovery applied)
create or replace function invoice_progress_billing(p_billing uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('projects.manage');
  pb progress_billings%rowtype; p projects%rowtype; v_inv uuid; v_tax uuid;
  v_cur numeric; v_prev numeric; v_ret numeric; v_adv numeric; v_adv_left numeric;
begin
  select * into pb from progress_billings where id = p_billing and org_id = v_org for update;
  if not found or pb.status <> 'draft' then raise exception 'draft progress billing not found'; end if;
  select * into p from projects where id = pb.project_id;
  if exists (select 1 from progress_billing_lines where billing_id = p_billing and cumulative_qty < previous_qty) then
    raise exception 'cumulative quantity cannot be less than previous quantity';
  end if;
  if exists (select 1 from progress_billing_lines l join project_boq_items b on b.id = l.boq_item_id
              where l.billing_id = p_billing and l.cumulative_qty > b.quantity) then
    raise exception 'cumulative quantity exceeds the contract (BOQ) quantity';
  end if;

  select coalesce(sum(current_amount),0), coalesce(sum(round(previous_qty * unit_price, 2)),0)
    into v_cur, v_prev from progress_billing_lines where billing_id = p_billing;
  if v_cur <= 0 then raise exception 'nothing to bill in this period'; end if;

  v_ret := round(v_cur * p.retention_pct / 100, 2);
  select p.advance_amount - p.opening_advance_recovered - coalesce(sum(advance_recovery),0) into v_adv_left
    from progress_billings where project_id = p.id and status = 'invoiced';
  v_adv := least(round(v_cur * p.advance_recovery_pct / 100, 2), greatest(v_adv_left, 0));

  select id into v_tax from tax_codes where org_id = v_org and category = 'S' and active order by rate desc limit 1;
  if v_tax is null then raise exception 'no standard VAT tax code configured'; end if;

  insert into invoices (org_id, invoice_kind, doc_type, customer_id, project_id, supply_date, notes,
                        retention_amount, advance_deduction)
  values (v_org, 'standard', 'invoice', p.customer_id, p.id, pb.period_to,
          'مستخلص رقم ' || pb.billing_no || ' — ' || p.name_ar, v_ret, 0)
  returning id into v_inv;

  insert into invoice_lines (org_id, invoice_id, line_no, description, unit, quantity, unit_price, tax_code_id)
  select v_org, v_inv, row_number() over (order by b.sort, b.item_no),
         coalesce(b.item_no || ' — ', '') || b.description, b.unit,
         l.cumulative_qty - l.previous_qty, l.unit_price, v_tax
    from progress_billing_lines l join project_boq_items b on b.id = l.boq_item_id
   where l.billing_id = p_billing and l.cumulative_qty > l.previous_qty;

  update invoices set advance_deduction = v_adv where id = v_inv;   -- triggers recalc

  update progress_billings set status = 'invoiced', invoice_id = v_inv,
         gross_to_date = v_prev + v_cur, previous_gross = v_prev, current_gross = v_cur,
         retention = v_ret, advance_recovery = v_adv
   where id = p_billing;
  perform log_audit(v_org, 'progress_billing.invoice', 'progress_billing', p_billing::text,
                    jsonb_build_object('invoice_id', v_inv, 'current_gross', v_cur));
  return v_inv;
end $$;


-- import a whole project from the Excel template in one transaction
--   p: { project: {...projects columns}, boq: [{item_no, description, unit, quantity, unit_price, opening_billed_qty}],
--        customer_id: uuid | null, new_customer: {...customers columns} | null }
create or replace function import_project(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('projects.manage');
  pr jsonb := p -> 'project'; v_cust uuid := nullif(p ->> 'customer_id', '')::uuid; v_id uuid;
begin
  if coalesce(trim(pr ->> 'name_ar'), '') = '' then raise exception 'project name is required'; end if;
  if p -> 'new_customer' is not null and jsonb_typeof(p -> 'new_customer') = 'object' then
    if not has_perm('sales.manage') then raise exception 'permission denied: sales.manage (adding a new customer)'; end if;
    insert into customers (org_id, name_ar, name_en, vat_number, cr_number, building_no, street, district, city, postal_code, email, phone)
    select v_org, c.name_ar, c.name_en, c.vat_number, c.cr_number, c.building_no, c.street, c.district, c.city, c.postal_code, c.email, c.phone
      from jsonb_to_record(p -> 'new_customer') as c(name_ar text, name_en text, vat_number text, cr_number text, building_no text,
                                                    street text, district text, city text, postal_code text, email text, phone text)
    returning id into v_cust;
  elsif v_cust is not null and not exists (select 1 from customers where id = v_cust and org_id = v_org) then
    raise exception 'customer not found';
  end if;

  insert into projects (org_id, code, name_ar, name_en, customer_id, contract_no, contract_value, retention_pct,
                        advance_amount, advance_recovery_pct, start_date, end_date, status, manager_name, location, notes,
                        opening_billing_count, opening_advance_recovered)
  select v_org, nullif(x.code, ''), x.name_ar, x.name_en, v_cust, x.contract_no, coalesce(x.contract_value, 0), coalesce(x.retention_pct, 0),
         coalesce(x.advance_amount, 0), coalesce(x.advance_recovery_pct, 0), x.start_date, x.end_date, coalesce(x.status, 'active'),
         x.manager_name, x.location, x.notes, coalesce(x.opening_billing_count, 0), coalesce(x.opening_advance_recovered, 0)
    from jsonb_to_record(pr) as x(code text, name_ar text, name_en text, contract_no text, contract_value numeric, retention_pct numeric,
                                  advance_amount numeric, advance_recovery_pct numeric, start_date date, end_date date, status text,
                                  manager_name text, location text, notes text, opening_billing_count int, opening_advance_recovered numeric)
  returning id into v_id;

  insert into project_boq_items (org_id, project_id, item_no, description, unit, quantity, unit_price, opening_billed_qty, sort)
  select v_org, v_id, e ->> 'item_no', e ->> 'description', e ->> 'unit', (e ->> 'quantity')::numeric, (e ->> 'unit_price')::numeric,
         coalesce((e ->> 'opening_billed_qty')::numeric, 0), ord::int
    from jsonb_array_elements(coalesce(p -> 'boq', '[]'::jsonb)) with ordinality as b(e, ord);

  perform log_audit(v_org, 'project.import', 'project', v_id::text,
                    jsonb_build_object('boq_items', jsonb_array_length(coalesce(p -> 'boq', '[]'::jsonb)), 'new_customer', p -> 'new_customer' is not null));
  return v_id;
end $$;
grant execute on function import_project(jsonb) to authenticated;
