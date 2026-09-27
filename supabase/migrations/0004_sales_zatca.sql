-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0004 — Sales: tax codes, items, invoices, progress billings, ZATCA
-- ════════════════════════════════════════════════════════════════════════
-- ZATCA (Fatoora) essentials handled here:
--   • invoice kinds: standard (B2B, 0100000) / simplified (B2C, 0200000)
--   • document types: 388 invoice · 381 credit note · 383 debit note
--   • UUID per invoice, ICV (invoice counter, gap-free per org) and PIH
--     (previous invoice hash) chain — assigned atomically at issue time
--   • issued invoices are immutable; corrections go through credit/debit notes
-- The UBL XML, invoice hash and QR (TLV) are built by the ZATCA library
-- (app/src/lib/zatca) and stored back via zatca_attach(). The next invoice
-- cannot be issued until the previous one has its hash (keeps the chain intact).
-- ════════════════════════════════════════════════════════════════════════

create table tax_codes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text not null,
  name_ar         text not null,
  name_en         text,
  rate            numeric(5,2) not null check (rate >= 0),
  -- ZATCA / UN-5305 category: S standard · Z zero-rated · E exempt · O out of scope
  category        text not null check (category in ('S','Z','E','O')),
  exemption_code  text,            -- e.g. VATEX-SA-32 (required for Z/E/O)
  exemption_reason text,
  active          boolean not null default true,
  unique (org_id, code),
  check (category = 'S' or exemption_code is not null)
);

create table items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  code               text,
  name_ar            text not null,
  name_en            text,
  kind               text not null default 'service' check (kind in ('service','goods')),
  unit               text not null default 'وحدة',
  unit_price         numeric(18,2) not null default 0,
  tax_code_id        uuid references tax_codes(id),
  revenue_account_id uuid references accounts(id),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (org_id, code)
);

-- per-org ZATCA chain state
create table zatca_state (
  org_id     uuid primary key references organizations(id) on delete cascade,
  last_icv   bigint not null default 0,
  -- ZATCA initial PIH: base64( hex( sha256("0") ) )
  last_hash  text not null default 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  environment text not null default 'sandbox' check (environment in ('sandbox','simulation','production')),
  -- phase-2 onboarding material (CSID certificate); private keys never stored here — see docs
  csid_certificate text,
  csid_expires_at  timestamptz,
  updated_at timestamptz not null default now()
);

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  number           text,
  invoice_kind     text not null default 'standard' check (invoice_kind in ('standard','simplified')),
  doc_type         text not null default 'invoice' check (doc_type in ('invoice','credit_note','debit_note')),
  customer_id      uuid references customers(id),
  project_id       uuid references projects(id),
  ref_invoice_id   uuid references invoices(id),          -- original invoice for credit/debit notes
  reason           text,                                   -- mandatory for credit/debit notes
  issue_date       date,
  issue_time       time,
  supply_date      date,
  due_date         date,
  currency         text not null default 'SAR',
  status           text not null default 'draft' check (status in ('draft','issued')),
  notes            text,
  -- totals (computed by recalc_invoice)
  subtotal         numeric(18,2) not null default 0,       -- Σ line net (after line discounts)
  advance_deduction numeric(18,2) not null default 0 check (advance_deduction >= 0),
  taxable_amount   numeric(18,2) not null default 0,
  vat_amount       numeric(18,2) not null default 0,
  total            numeric(18,2) not null default 0,       -- taxable + VAT
  retention_amount numeric(18,2) not null default 0 check (retention_amount >= 0),
  net_payable      numeric(18,2) not null default 0,       -- total − retention
  amount_paid      numeric(18,2) not null default 0,
  -- ZATCA
  zatca_uuid       uuid not null default gen_random_uuid(),
  zatca_icv        bigint,
  zatca_pih        text,
  zatca_hash       text,
  zatca_qr         text,
  zatca_xml        text,
  zatca_status     text not null default 'not_submitted'
                   check (zatca_status in ('not_submitted','reported','cleared','warning','rejected')),
  zatca_response   jsonb,
  journal_entry_id uuid references journal_entries(id),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  issued_at        timestamptz,
  unique (org_id, number),
  unique (org_id, zatca_icv),
  check (doc_type = 'invoice' or ref_invoice_id is not null or status = 'draft')
);
create index on invoices(org_id, issue_date desc);
create index on invoices(org_id, customer_id);
create index on invoices(project_id) where project_id is not null;

create table invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  invoice_id   uuid not null references invoices(id) on delete cascade,
  line_no      int not null default 1,
  item_id      uuid references items(id),
  description  text not null,
  unit         text,
  quantity     numeric(18,3) not null default 1 check (quantity > 0),
  unit_price   numeric(18,2) not null default 0 check (unit_price >= 0),
  discount     numeric(18,2) not null default 0 check (discount >= 0),
  tax_code_id  uuid not null references tax_codes(id),
  -- snapshots / computed
  tax_rate     numeric(5,2) not null default 0,
  tax_category text not null default 'S',
  line_net     numeric(18,2) not null default 0,
  line_vat     numeric(18,2) not null default 0,
  line_total   numeric(18,2) not null default 0,
  revenue_account_id uuid references accounts(id)
);
create index on invoice_lines(invoice_id);

-- issued invoices (and their lines) are immutable except for ZATCA / payment bookkeeping
create or replace function guard_issued_invoice()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'issued' then raise exception 'issued invoices cannot be deleted — issue a credit note'; end if;
    return old;
  end if;
  if old.status = 'issued' then
    -- journal_entry_id may be set once (right after issue); the rest is bookkeeping
    if (to_jsonb(new) - array['zatca_hash','zatca_qr','zatca_xml','zatca_status','zatca_response','amount_paid','updated_at']
                      - case when old.journal_entry_id is null then 'journal_entry_id' else '' end)
       is distinct from
       (to_jsonb(old) - array['zatca_hash','zatca_qr','zatca_xml','zatca_status','zatca_response','amount_paid','updated_at']
                      - case when old.journal_entry_id is null then 'journal_entry_id' else '' end) then
      raise exception 'issued invoices are immutable — issue a credit/debit note';
    end if;
  end if;
  return new;
end $$;
-- a new invoice always starts as a clean draft (issuing only happens in issue_invoice)
create or replace function normalize_new_invoice()
returns trigger language plpgsql as $$
begin
  new.status := 'draft'; new.number := null; new.issued_at := null;
  new.zatca_icv := null; new.zatca_pih := null; new.zatca_hash := null; new.zatca_qr := null;
  new.zatca_xml := null; new.zatca_status := 'not_submitted'; new.zatca_response := null;
  new.amount_paid := 0; new.journal_entry_id := null;
  return new;
end $$;
create trigger invoices_new before insert on invoices
  for each row execute function normalize_new_invoice();

create trigger invoices_guard before update or delete on invoices
  for each row execute function guard_issued_invoice();

create or replace function guard_issued_invoice_lines()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from invoices where id = coalesce(new.invoice_id, old.invoice_id) and status = 'issued') then
    raise exception 'lines of an issued invoice cannot change';
  end if;
  return coalesce(new, old);
end $$;
create trigger invoice_lines_guard before insert or update or delete on invoice_lines
  for each row execute function guard_issued_invoice_lines();

-- line computation (snapshot tax rate/category from the tax code)
create or replace function compute_invoice_line()
returns trigger language plpgsql as $$
declare t tax_codes%rowtype;
begin
  select * into t from tax_codes where id = new.tax_code_id;
  new.tax_rate     := t.rate;
  new.tax_category := t.category;
  new.line_net     := round(new.quantity * new.unit_price - new.discount, 2);
  if new.line_net < 0 then raise exception 'line discount exceeds line amount'; end if;
  new.line_vat     := round(new.line_net * t.rate / 100, 2);
  new.line_total   := new.line_net + new.line_vat;
  return new;
end $$;
create trigger invoice_lines_compute before insert or update on invoice_lines
  for each row execute function compute_invoice_line();

-- invoice totals. Advance recovery reduces the taxable base (VAT on the
-- advance was already accounted for when the advance was received).
create or replace function recalc_invoice(p_invoice uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_sub numeric; v_vat numeric; inv invoices%rowtype; v_taxable numeric; v_adv_vat numeric := 0;
begin
  select * into inv from invoices where id = p_invoice;
  if inv.status = 'issued' then return; end if;
  select coalesce(sum(line_net),0), coalesce(sum(line_vat),0) into v_sub, v_vat
    from invoice_lines where invoice_id = p_invoice;
  if inv.advance_deduction > v_sub then raise exception 'advance deduction exceeds invoice subtotal'; end if;
  if inv.advance_deduction > 0 then
    -- VAT relief on the recovered advance at the standard rate of the lines
    v_adv_vat := round(inv.advance_deduction * coalesce(
      (select max(tax_rate) from invoice_lines where invoice_id = p_invoice), 0) / 100, 2);
  end if;
  v_taxable := v_sub - inv.advance_deduction;
  v_vat := v_vat - v_adv_vat;
  update invoices set subtotal = v_sub, taxable_amount = v_taxable, vat_amount = v_vat,
                      total = v_taxable + v_vat, net_payable = v_taxable + v_vat - retention_amount
   where id = p_invoice;
end $$;

create or replace function invoice_lines_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform recalc_invoice(coalesce(new.invoice_id, old.invoice_id)); return null; end $$;
create trigger invoice_lines_recalc after insert or update or delete on invoice_lines
  for each row execute function invoice_lines_touch();

create or replace function invoices_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'draft' and (new.advance_deduction, new.retention_amount) is distinct from (old.advance_deduction, old.retention_amount) then
    perform recalc_invoice(new.id);
  end if;
  return null;
end $$;
create trigger invoices_recalc after update of advance_deduction, retention_amount on invoices
  for each row execute function invoices_touch();

-- ── issue ───────────────────────────────────────────────────────────────
create or replace function issue_invoice(p_invoice uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('sales.issue');
  inv invoices%rowtype; c customers%rowtype; ref invoices%rowtype;
  st zatca_state%rowtype;
  v_lines jsonb := '[]'::jsonb; v_sign int; v_je uuid; v_type text; r record;
  v_default_rev text;
begin
  select * into inv from invoices where id = p_invoice and org_id = v_org for update;
  if not found then raise exception 'invoice not found'; end if;
  if inv.status <> 'draft' then raise exception 'invoice already issued'; end if;
  if not exists (select 1 from invoice_lines where invoice_id = p_invoice) then
    raise exception 'invoice has no lines';
  end if;

  perform recalc_invoice(p_invoice);
  select * into inv from invoices where id = p_invoice;
  if inv.total <= 0 then raise exception 'invoice total must be positive'; end if;

  -- standard (B2B) invoices need a fully identified buyer
  if inv.invoice_kind = 'standard' then
    select * into c from customers where id = inv.customer_id;
    if not found then raise exception 'standard invoice requires a customer'; end if;
    if c.customer_type = 'business' and c.vat_number is null then
      raise exception 'standard invoice requires the customer VAT number';
    end if;
    if c.street is null or c.building_no is null or c.city is null or c.postal_code is null or c.district is null then
      raise exception 'standard invoice requires the customer national address';
    end if;
  end if;

  if inv.doc_type <> 'invoice' then
    select * into ref from invoices where id = inv.ref_invoice_id and org_id = v_org;
    if not found or ref.status <> 'issued' or ref.doc_type <> 'invoice' then
      raise exception 'credit/debit notes must reference an issued invoice';
    end if;
    if coalesce(inv.reason, '') = '' then raise exception 'credit/debit notes require a reason'; end if;
    if inv.doc_type = 'credit_note' and inv.total > ref.total - coalesce((
         select sum(total) from invoices where ref_invoice_id = ref.id and doc_type = 'credit_note' and status = 'issued'), 0) then
      raise exception 'credit note exceeds the remaining value of the original invoice';
    end if;
  end if;

  -- ZATCA chain: lock state, previous invoice must be hashed
  insert into zatca_state (org_id) values (v_org) on conflict do nothing;
  select * into st from zatca_state where org_id = v_org for update;
  if st.last_icv > 0 and exists (select 1 from invoices where org_id = v_org and zatca_icv = st.last_icv and zatca_hash is null) then
    raise exception 'previous invoice is still pending ZATCA processing (hash)';
  end if;

  v_type := case inv.doc_type when 'invoice' then 'INV' when 'credit_note' then 'CN' else 'DN' end;
  update invoices set
      status = 'issued', issued_at = now(),
      number = next_doc_number(v_org, v_type),
      issue_date = coalesce(issue_date, (now() at time zone 'Asia/Riyadh')::date),
      issue_time = (now() at time zone 'Asia/Riyadh')::time(0),
      supply_date = coalesce(supply_date, issue_date, (now() at time zone 'Asia/Riyadh')::date),
      due_date = coalesce(due_date, coalesce(issue_date, current_date) + coalesce(
                   (select payment_terms_days from customers where id = inv.customer_id), 0)),
      zatca_icv = st.last_icv + 1,
      zatca_pih = st.last_hash
   where id = p_invoice;
  update zatca_state set last_icv = st.last_icv + 1, updated_at = now() where org_id = v_org;
  select * into inv from invoices where id = p_invoice;

  -- GL: invoice/debit note → Dr AR, Dr retention, Dr customer advances / Cr revenue, Cr VAT
  --     credit note        → mirror image
  v_sign := case when inv.doc_type = 'credit_note' then -1 else 1 end;
  v_default_rev := case when inv.project_id is not null then 'revenue_contracts' else 'revenue_services' end;

  v_lines := v_lines || jsonb_build_object('account_key','ar',
      case when v_sign > 0 then 'debit' else 'credit' end, inv.net_payable,
      'description', inv.number, 'party_type', case when inv.customer_id is not null then 'customer' end,
      'party_id', inv.customer_id, 'project_id', inv.project_id);
  v_lines := v_lines || jsonb_build_object('account_key','retention_receivable',
      case when v_sign > 0 then 'debit' else 'credit' end, inv.retention_amount,
      'description', inv.number, 'party_type', case when inv.customer_id is not null then 'customer' end,
      'party_id', inv.customer_id, 'project_id', inv.project_id);
  v_lines := v_lines || jsonb_build_object('account_key','customer_advances',
      case when v_sign > 0 then 'debit' else 'credit' end, inv.advance_deduction,
      'description', inv.number, 'party_type', case when inv.customer_id is not null then 'customer' end,
      'party_id', inv.customer_id, 'project_id', inv.project_id);
  for r in select coalesce(l.revenue_account_id, i.revenue_account_id) as acc, sum(l.line_net) as amt
             from invoice_lines l left join items i on i.id = l.item_id
            where l.invoice_id = p_invoice group by 1 loop
    v_lines := v_lines || jsonb_build_object(
      'account_id', r.acc, 'account_key', case when r.acc is null then v_default_rev end,
      case when v_sign > 0 then 'credit' else 'debit' end, r.amt,
      'description', inv.number, 'project_id', inv.project_id);
  end loop;
  v_lines := v_lines || jsonb_build_object('account_key','vat_output',
      case when v_sign > 0 then 'credit' else 'debit' end, inv.vat_amount,
      'description', inv.number);

  v_je := gl_post(v_org, inv.issue_date,
                  case inv.doc_type when 'invoice' then 'فاتورة مبيعات ' when 'credit_note' then 'إشعار دائن ' else 'إشعار مدين ' end || inv.number,
                  'invoice', inv.id, v_lines);
  update invoices set journal_entry_id = v_je where id = p_invoice;

  perform log_audit(v_org, 'invoice.issue', 'invoice', p_invoice::text,
                    jsonb_build_object('number', inv.number, 'total', inv.total));
  perform emit_event(v_org, 'invoice.issued', 'invoice', p_invoice,
                     jsonb_build_object('number', inv.number, 'doc_type', inv.doc_type, 'total', inv.total,
                                        'customer_id', inv.customer_id, 'project_id', inv.project_id));

  return jsonb_build_object('id', inv.id, 'number', inv.number, 'icv', inv.zatca_icv,
                            'pih', inv.zatca_pih, 'uuid', inv.zatca_uuid, 'journal_entry_id', v_je);
end $$;

-- store the ZATCA artefacts produced by the library and advance the hash chain
create or replace function zatca_attach(p_invoice uuid, p_hash text, p_qr text, p_xml text)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('sales.issue'); inv invoices%rowtype;
begin
  select * into inv from invoices where id = p_invoice and org_id = v_org for update;
  if not found or inv.status <> 'issued' then raise exception 'invoice not found or not issued'; end if;
  if inv.zatca_hash is not null then raise exception 'ZATCA hash already attached'; end if;
  if coalesce(p_hash,'') = '' or coalesce(p_qr,'') = '' then raise exception 'hash and QR are required'; end if;

  update invoices set zatca_hash = p_hash, zatca_qr = p_qr, zatca_xml = p_xml where id = p_invoice;
  update zatca_state set last_hash = p_hash, updated_at = now()
   where org_id = v_org and last_icv = inv.zatca_icv;
  if not found then raise exception 'ZATCA chain out of order'; end if;
end $$;

-- record the reporting/clearance result returned by the Fatoora API
create or replace function zatca_set_status(p_invoice uuid, p_status text, p_response jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('sales.issue');
begin
  update invoices set zatca_status = p_status, zatca_response = p_response
   where id = p_invoice and org_id = v_org and status = 'issued';
  if not found then raise exception 'invoice not found'; end if;
end $$;

-- ── progress billings (مستخلصات) ────────────────────────────────────────
create table progress_billings (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  billing_no        int not null,
  period_to         date not null default current_date,
  status            text not null default 'draft' check (status in ('draft','invoiced')),
  gross_to_date     numeric(18,2) not null default 0,
  previous_gross    numeric(18,2) not null default 0,
  current_gross     numeric(18,2) not null default 0,
  retention         numeric(18,2) not null default 0,
  advance_recovery  numeric(18,2) not null default 0,
  invoice_id        uuid references invoices(id),
  notes             text,
  created_at        timestamptz not null default now(),
  unique (project_id, billing_no)
);

create table progress_billing_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  billing_id     uuid not null references progress_billings(id) on delete cascade,
  boq_item_id    uuid not null references project_boq_items(id),
  previous_qty   numeric(18,3) not null default 0,
  cumulative_qty numeric(18,3) not null default 0,
  unit_price     numeric(18,2) not null default 0,
  current_amount numeric(18,2) generated always as (round((cumulative_qty - previous_qty) * unit_price, 2)) stored,
  unique (billing_id, boq_item_id)
);

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
  select coalesce(max(billing_no),0) + 1 into v_no from progress_billings where project_id = p_project;

  insert into progress_billings (org_id, project_id, billing_no, period_to)
  values (v_org, p_project, v_no, p_period_to) returning id into v_id;

  insert into progress_billing_lines (org_id, billing_id, boq_item_id, previous_qty, cumulative_qty, unit_price)
  select v_org, v_id, b.id, coalesce(pl.cumulative_qty, 0), coalesce(pl.cumulative_qty, 0), b.unit_price
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
  select p.advance_amount - coalesce(sum(advance_recovery),0) into v_adv_left
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

-- ── RLS ─────────────────────────────────────────────────────────────────
select apply_org_policies('tax_codes',              'sales.view',    'settings.manage');
select apply_org_policies('items',                  'sales.view',    'sales.manage');
select apply_org_policies('invoices',               'sales.view',    'sales.manage');
select apply_org_policies('invoice_lines',          'sales.view',    'sales.manage');
select apply_org_policies('progress_billings',      'projects.view', 'projects.manage');
select apply_org_policies('progress_billing_lines', 'projects.view', 'projects.manage');
alter table zatca_state enable row level security;
create policy zatca_state_read on zatca_state for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('sales.view'));
create policy zatca_state_upd on zatca_state for update to authenticated
  using (org_id = (select current_org_id()) and has_perm('settings.manage'));

create trigger items_zcode before insert on items for each row execute function assign_party_code('ITM');
create trigger invoices_upd before update on invoices for each row execute function set_updated_at();

-- column-level write access: status, numbers, totals, ZATCA fields and payment
-- tracking are only ever changed by the security-definer functions above
revoke update on invoices, progress_billings, progress_billing_lines, zatca_state from authenticated;
grant update (invoice_kind, doc_type, customer_id, project_id, ref_invoice_id, reason, issue_date,
              supply_date, due_date, currency, notes, retention_amount, advance_deduction)
  on invoices to authenticated;
grant update (period_to, notes) on progress_billings to authenticated;
grant update (cumulative_qty) on progress_billing_lines to authenticated;
grant update (environment) on zatca_state to authenticated;
