-- GDXora · 0024 — Quotations (عروض الأسعار)
--  • a quotation to a customer — or to a prospect not yet in the customers
--    list — with lines, VAT per line and a validity date; printed on the
--    company letterhead
--  • draft → sent → accepted | rejected; a sent quotation can go back to draft
--    for a revision (its revision number goes up); past its validity date a
--    sent quotation shows as expired
--  • an accepted quotation becomes a project in one step: the customer (created
--    from the prospect if needed), the contract value and the BOQ from its lines
--  • header and lines are saved in one call; numbers (QUO-…), totals and
--    status are written only by the functions below

create table quotations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  number          text,
  revision        int not null default 0,
  customer_id     uuid references customers(id),
  prospect_name   text,                        -- when the customer is not in the system yet
  prospect_vat    text,
  prospect_phone  text,
  prospect_email  text,
  title           text not null,               -- subject / project name
  issue_date      date not null default current_date,
  valid_until     date not null default (current_date + 30),
  status          text not null default 'draft' check (status in ('draft','sent','accepted','rejected')),
  subtotal        numeric(18,2) not null default 0,
  vat_amount      numeric(18,2) not null default 0,
  total           numeric(18,2) not null default 0,
  notes           text,
  terms           text,                        -- payment terms, scope, exclusions…
  reject_reason   text,
  project_id      uuid references projects(id),
  sent_at         timestamptz,
  decided_at      timestamptz,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, number),
  constraint quotations_party check (customer_id is not null or coalesce(trim(prospect_name), '') <> ''),
  constraint quotations_validity check (valid_until >= issue_date)
);
create index on quotations(org_id, issue_date desc);

create table quotation_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  quotation_id  uuid not null references quotations(id) on delete cascade,
  line_no       int not null,
  item_no       text,
  description   text not null,
  unit          text,
  quantity      numeric(18,3) not null check (quantity > 0),
  unit_price    numeric(18,2) not null check (unit_price >= 0),
  vat_rate      numeric(5,2) not null default 15 check (vat_rate between 0 and 100),
  line_net      numeric(18,2) generated always as (round(quantity * unit_price, 2)) stored,
  unique (quotation_id, line_no)
);

select apply_org_policies('quotations',      'sales.view', 'sales.manage');
select apply_org_policies('quotation_lines', 'sales.view', 'sales.manage');
create trigger quotations_upd_at before update on quotations for each row execute function set_updated_at();
-- writes go through save_quotation() and the status functions only
revoke insert, update on quotations, quotation_lines from authenticated;

create or replace function _quotation_totals(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update quotations q set subtotal = s.net, vat_amount = s.vat, total = s.net + s.vat
    from (select coalesce(sum(line_net), 0) as net, coalesce(sum(round(line_net * vat_rate / 100, 2)), 0) as vat
            from quotation_lines where quotation_id = p_id) s
   where q.id = p_id
$$;
revoke execute on function _quotation_totals(uuid) from public, anon, authenticated;

-- only drafts can be deleted (their lines go with them)
create trigger quotations_no_delete before delete on quotations for each row execute function guard_delete_non_draft();

-- create or update a draft with its lines in one call
--   p: { id?, customer_id?, prospect_name?, prospect_vat?, prospect_phone?, prospect_email?, title, issue_date?, valid_until?,
--        notes?, terms?, lines: [{ item_no?, description, unit?, quantity, unit_price, vat_rate? }] }
create or replace function save_quotation(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('sales.manage'); v_id uuid := nullif(p ->> 'id', '')::uuid; v_cust uuid := nullif(p ->> 'customer_id', '')::uuid;
begin
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'the quotation needs a title'; end if;
  if v_cust is null and coalesce(trim(p ->> 'prospect_name'), '') = '' then raise exception 'choose a customer or enter the prospect''s name'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'a quotation needs at least one line'; end if;
  if v_cust is not null and not exists (select 1 from customers where id = v_cust and org_id = v_org) then raise exception 'customer not found'; end if;
  if v_id is null then
    -- the number comes from the QUO sequence (created on first use)
    insert into quotations (org_id, number, customer_id, prospect_name, title)
    values (v_org, next_doc_number(v_org, 'QUO'), v_cust, trim(p ->> 'prospect_name'), trim(p ->> 'title'))
    returning id into v_id;
  elsif not exists (select 1 from quotations where id = v_id and org_id = v_org and status = 'draft') then
    raise exception 'draft quotation not found';
  end if;
  update quotations set
    customer_id = v_cust,
    prospect_name = case when v_cust is null then nullif(trim(p ->> 'prospect_name'), '') end,
    prospect_vat = case when v_cust is null then nullif(trim(p ->> 'prospect_vat'), '') end,
    prospect_phone = case when v_cust is null then nullif(trim(p ->> 'prospect_phone'), '') end,
    prospect_email = case when v_cust is null then nullif(trim(p ->> 'prospect_email'), '') end,
    title = trim(p ->> 'title'),
    issue_date = coalesce(nullif(p ->> 'issue_date', '')::date, issue_date),
    valid_until = coalesce(nullif(p ->> 'valid_until', '')::date, valid_until),
    notes = nullif(p ->> 'notes', ''), terms = nullif(p ->> 'terms', '')
   where id = v_id;

  delete from quotation_lines where quotation_id = v_id;
  insert into quotation_lines (org_id, quotation_id, line_no, item_no, description, unit, quantity, unit_price, vat_rate)
  select v_org, v_id, ord, nullif(trim(l ->> 'item_no'), ''), trim(l ->> 'description'), nullif(trim(l ->> 'unit'), ''),
         (l ->> 'quantity')::numeric, (l ->> 'unit_price')::numeric, coalesce(nullif(l ->> 'vat_rate', '')::numeric, 15)
    from jsonb_array_elements(p -> 'lines') with ordinality as x(l, ord);
  if exists (select 1 from quotation_lines where quotation_id = v_id and description = '') then raise exception 'every line needs a description'; end if;
  perform _quotation_totals(v_id);
  return v_id;
end $$;

-- draft → sent, sent → draft (revision), sent → accepted | rejected
create or replace function set_quotation_status(p_id uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('sales.manage'); q quotations%rowtype;
begin
  select * into q from quotations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'quotation not found'; end if;
  if (q.status, p_status) = ('draft', 'sent') then
    update quotations set status = 'sent', sent_at = now() where id = p_id;
  elsif (q.status, p_status) = ('sent', 'draft') then
    update quotations set status = 'draft', revision = revision + 1, sent_at = null where id = p_id;
  elsif q.status = 'sent' and p_status = 'accepted' then
    update quotations set status = 'accepted', decided_at = now(), reject_reason = null where id = p_id;
  elsif q.status = 'sent' and p_status = 'rejected' then
    if coalesce(trim(p_reason), '') = '' then raise exception 'a rejection reason is required'; end if;
    update quotations set status = 'rejected', decided_at = now(), reject_reason = trim(p_reason) where id = p_id;
  else
    raise exception 'cannot change a % quotation to %', q.status, p_status;
  end if;
  perform log_audit(v_org, 'quotation.' || p_status, 'quotation', p_id::text, jsonb_build_object('number', q.number, 'reason', p_reason));
  perform emit_event(v_org, 'quotation.' || p_status, 'quotation', p_id, jsonb_build_object('number', q.number, 'total', q.total));
end $$;

-- an accepted quotation → a project with its customer, contract value and BOQ
create or replace function quotation_to_project(p_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('projects.manage'); q quotations%rowtype; v_cust uuid; v_prj uuid;
begin
  select * into q from quotations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'quotation not found'; end if;
  if q.status <> 'accepted' then raise exception 'only an accepted quotation becomes a project'; end if;
  if q.project_id is not null then raise exception 'this quotation is already a project'; end if;
  v_cust := q.customer_id;
  if v_cust is null then
    if not has_perm('sales.manage') then raise exception 'permission denied: sales.manage (adding the customer)' using errcode = '42501'; end if;
    insert into customers (org_id, name_ar, vat_number, phone, email)
    values (v_org, q.prospect_name, case when q.prospect_vat ~ '^3[0-9]{13}3$' then q.prospect_vat end, q.prospect_phone, q.prospect_email)
    returning id into v_cust;
    update quotations set customer_id = v_cust where id = p_id;
  end if;
  insert into projects (org_id, name_ar, customer_id, contract_no, contract_value, start_date, status, notes)
  values (v_org, q.title, v_cust, q.number, q.subtotal, current_date, 'active', 'من عرض السعر ' || q.number)
  returning id into v_prj;
  insert into project_boq_items (org_id, project_id, item_no, description, unit, quantity, unit_price, sort)
  select v_org, v_prj, coalesce(item_no, line_no::text), description, unit, quantity, unit_price, line_no
    from quotation_lines where quotation_id = p_id;
  update quotations set project_id = v_prj where id = p_id;
  perform log_audit(v_org, 'quotation.to_project', 'quotation', p_id::text, jsonb_build_object('project_id', v_prj));
  return v_prj;
end $$;
