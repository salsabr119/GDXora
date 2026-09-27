-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0005 — Finance: vendor bills, receipt & payment vouchers
-- ════════════════════════════════════════════════════════════════════════

create table bills (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  number           text,                         -- our internal number (BIL-…)
  vendor_id        uuid not null references vendors(id),
  vendor_ref       text,                         -- the vendor's own invoice number
  project_id       uuid references projects(id),
  bill_date        date not null default current_date,
  due_date         date,
  status           text not null default 'draft' check (status in ('draft','posted','cancelled')),
  notes            text,
  subtotal         numeric(18,2) not null default 0,
  vat_amount       numeric(18,2) not null default 0,
  total            numeric(18,2) not null default 0,
  retention_amount numeric(18,2) not null default 0 check (retention_amount >= 0),  -- withheld from subcontractors
  net_payable      numeric(18,2) not null default 0,
  amount_paid      numeric(18,2) not null default 0,
  journal_entry_id uuid references journal_entries(id),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, number)
);
create index on bills(org_id, bill_date desc);

create table bill_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  bill_id     uuid not null references bills(id) on delete cascade,
  line_no     int not null default 1,
  description text not null,
  account_id  uuid not null references accounts(id),   -- expense / cost / asset account
  project_id  uuid references projects(id),
  quantity    numeric(18,3) not null default 1 check (quantity > 0),
  unit_price  numeric(18,2) not null default 0 check (unit_price >= 0),
  tax_code_id uuid references tax_codes(id),
  tax_rate    numeric(5,2) not null default 0,
  line_net    numeric(18,2) not null default 0,
  line_vat    numeric(18,2) not null default 0
);
create index on bill_lines(bill_id);

create or replace function compute_bill_line()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from bills where id = new.bill_id and status <> 'draft') then
    raise exception 'lines of a posted bill cannot change';
  end if;
  new.tax_rate := coalesce((select rate from tax_codes where id = new.tax_code_id), 0);
  new.line_net := round(new.quantity * new.unit_price, 2);
  new.line_vat := round(new.line_net * new.tax_rate / 100, 2);
  return new;
end $$;
create trigger bill_lines_compute before insert or update on bill_lines
  for each row execute function compute_bill_line();

create or replace function bill_lines_touch()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_bill uuid := coalesce(new.bill_id, old.bill_id);
begin
  if tg_op = 'DELETE' and exists (select 1 from bills where id = v_bill and status <> 'draft') then
    raise exception 'lines of a posted bill cannot change';
  end if;
  update bills b set subtotal = s.net, vat_amount = s.vat, total = s.net + s.vat,
                     net_payable = s.net + s.vat - b.retention_amount
    from (select coalesce(sum(line_net),0) net, coalesce(sum(line_vat),0) vat
            from bill_lines where bill_id = v_bill) s
   where b.id = v_bill and b.status = 'draft';
  return null;
end $$;
create trigger bill_lines_recalc after insert or update or delete on bill_lines
  for each row execute function bill_lines_touch();

create or replace function normalize_bill()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.number := null; new.amount_paid := 0; new.journal_entry_id := null;
  elsif old.status <> 'draft' and (to_jsonb(new) - array['amount_paid','status','updated_at','journal_entry_id'])
                     is distinct from (to_jsonb(old) - array['amount_paid','status','updated_at','journal_entry_id']) then
    raise exception 'posted bills are immutable';
  end if;
  if tg_op = 'UPDATE' and new.status = 'draft' then
    new.net_payable := new.total - new.retention_amount;
  end if;
  return new;
end $$;
create trigger bills_normalize before insert or update on bills
  for each row execute function normalize_bill();

create or replace function post_bill(p_bill uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('finance.approve'); b bills%rowtype; v_lines jsonb := '[]'::jsonb; r record; v_je uuid;
begin
  select * into b from bills where id = p_bill and org_id = v_org for update;
  if not found or b.status <> 'draft' then raise exception 'draft bill not found'; end if;
  if b.total <= 0 then raise exception 'bill total must be positive'; end if;
  if b.retention_amount > b.total then raise exception 'retention exceeds bill total'; end if;

  update bills set number = next_doc_number(v_org, 'BIL'), status = 'posted',
         due_date = coalesce(due_date, bill_date + (select payment_terms_days from vendors where id = b.vendor_id))
   where id = p_bill returning * into b;

  for r in select account_id, coalesce(project_id, b.project_id) as project_id, sum(line_net) amt, string_agg(description, ' / ') d
             from bill_lines where bill_id = p_bill group by 1, 2 loop
    v_lines := v_lines || jsonb_build_object('account_id', r.account_id, 'debit', r.amt,
                                             'description', left(r.d, 200), 'project_id', r.project_id);
  end loop;
  v_lines := v_lines
    || jsonb_build_object('account_key','vat_input','debit', b.vat_amount, 'description', b.number)
    || jsonb_build_object('account_key','ap','credit', b.net_payable, 'description', b.number,
                          'party_type','vendor','party_id', b.vendor_id, 'project_id', b.project_id)
    || jsonb_build_object('account_key','retention_payable','credit', b.retention_amount, 'description', b.number,
                          'party_type','vendor','party_id', b.vendor_id, 'project_id', b.project_id);

  v_je := gl_post(v_org, b.bill_date, 'فاتورة مورد ' || b.number || coalesce(' (' || b.vendor_ref || ')', ''), 'bill', b.id, v_lines);
  update bills set journal_entry_id = v_je where id = p_bill;
  perform log_audit(v_org, 'bill.post', 'bill', p_bill::text, jsonb_build_object('number', b.number, 'total', b.total));
  perform emit_event(v_org, 'bill.posted', 'bill', p_bill, jsonb_build_object('number', b.number, 'total', b.total, 'vendor_id', b.vendor_id));
  return b.number;
end $$;

-- ── vouchers ────────────────────────────────────────────────────────────
create table payments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  number             text,
  direction          text not null check (direction in ('receipt','payment')),
  -- what the money is for
  purpose            text not null check (purpose in ('invoice','bill','customer_on_account','vendor_on_account',
                                                       'customer_advance','salaries','gosi','other')),
  payment_date       date not null default current_date,
  account_id         uuid not null references accounts(id),     -- cash / bank
  amount             numeric(18,2) not null check (amount > 0),
  method             text not null default 'bank_transfer' check (method in ('cash','bank_transfer','cheque','card','sadad')),
  reference          text,
  invoice_id         uuid references invoices(id),
  bill_id            uuid references bills(id),
  customer_id        uuid references customers(id),
  vendor_id          uuid references vendors(id),
  counter_account_id uuid references accounts(id),              -- for purpose = other
  project_id         uuid references projects(id),
  memo               text,
  status             text not null default 'draft' check (status in ('draft','posted')),
  journal_entry_id   uuid references journal_entries(id),
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  unique (org_id, number)
);
create index on payments(org_id, payment_date desc);

create or replace function normalize_payment()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.number := null; new.journal_entry_id := null;
  elsif old.status = 'posted' and not (old.journal_entry_id is null and
        (to_jsonb(new) - 'journal_entry_id') = (to_jsonb(old) - 'journal_entry_id')) then
    raise exception 'posted vouchers are immutable';
  end if;
  return new;
end $$;
create trigger payments_normalize before insert or update on payments
  for each row execute function normalize_payment();

create or replace function post_payment(p_payment uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('finance.approve');
  p payments%rowtype; inv invoices%rowtype; b bills%rowtype;
  v_counter jsonb; v_cash jsonb; v_je uuid; v_memo text;
begin
  select * into p from payments where id = p_payment and org_id = v_org for update;
  if not found or p.status <> 'draft' then raise exception 'draft voucher not found'; end if;
  if not exists (select 1 from accounts where id = p.account_id and org_id = v_org and is_cash) then
    raise exception 'voucher account must be a cash/bank account';
  end if;

  -- counter line (the non-cash side)
  case p.purpose
    when 'invoice' then
      select * into inv from invoices where id = p.invoice_id and org_id = v_org for update;
      if not found or inv.status <> 'issued' or inv.doc_type = 'credit_note' then raise exception 'issued invoice required'; end if;
      if p.direction <> 'receipt' then raise exception 'invoice settlement must be a receipt'; end if;
      if p.amount > inv.net_payable - inv.amount_paid then raise exception 'amount exceeds invoice balance (%)', inv.net_payable - inv.amount_paid; end if;
      update invoices set amount_paid = amount_paid + p.amount where id = inv.id;
      v_counter := jsonb_build_object('account_key','ar','party_type','customer','party_id', inv.customer_id,
                                      'project_id', coalesce(p.project_id, inv.project_id));
      v_memo := 'تحصيل فاتورة ' || inv.number;
    when 'bill' then
      select * into b from bills where id = p.bill_id and org_id = v_org for update;
      if not found or b.status <> 'posted' then raise exception 'posted bill required'; end if;
      if p.direction <> 'payment' then raise exception 'bill settlement must be a payment'; end if;
      if p.amount > b.net_payable - b.amount_paid then raise exception 'amount exceeds bill balance (%)', b.net_payable - b.amount_paid; end if;
      update bills set amount_paid = amount_paid + p.amount where id = b.id;
      v_counter := jsonb_build_object('account_key','ap','party_type','vendor','party_id', b.vendor_id,
                                      'project_id', coalesce(p.project_id, b.project_id));
      v_memo := 'سداد فاتورة مورد ' || b.number;
    when 'customer_on_account' then
      if p.customer_id is null then raise exception 'customer required'; end if;
      v_counter := jsonb_build_object('account_key','ar','party_type','customer','party_id', p.customer_id, 'project_id', p.project_id);
      v_memo := 'دفعة على الحساب';
    when 'customer_advance' then
      if p.customer_id is null then raise exception 'customer required'; end if;
      v_counter := jsonb_build_object('account_key','customer_advances','party_type','customer','party_id', p.customer_id, 'project_id', p.project_id);
      v_memo := 'دفعة مقدمة من عميل';
    when 'vendor_on_account' then
      if p.vendor_id is null then raise exception 'vendor required'; end if;
      v_counter := jsonb_build_object('account_key','ap','party_type','vendor','party_id', p.vendor_id, 'project_id', p.project_id);
      v_memo := 'دفعة لمورد على الحساب';
    when 'salaries' then
      v_counter := jsonb_build_object('account_key','salaries_payable');
      v_memo := 'صرف رواتب';
    when 'gosi' then
      v_counter := jsonb_build_object('account_key','gosi_payable');
      v_memo := 'سداد التأمينات الاجتماعية';
    else
      if p.counter_account_id is null then raise exception 'counter account required'; end if;
      v_counter := jsonb_build_object('account_id', p.counter_account_id, 'project_id', p.project_id);
      v_memo := coalesce(p.memo, 'سند');
  end case;

  v_cash := jsonb_build_object('account_id', p.account_id);
  if p.direction = 'receipt' then
    v_cash := v_cash || jsonb_build_object('debit', p.amount);
    v_counter := v_counter || jsonb_build_object('credit', p.amount);
  else
    v_cash := v_cash || jsonb_build_object('credit', p.amount);
    v_counter := v_counter || jsonb_build_object('debit', p.amount);
  end if;

  update payments set number = next_doc_number(v_org, case when p.direction = 'receipt' then 'RV' else 'PV' end),
                      status = 'posted'
   where id = p_payment returning * into p;
  v_memo := v_memo || ' — ' || p.number || coalesce(' — ' || p.memo, '');
  v_je := gl_post(v_org, p.payment_date, v_memo, 'payment', p.id,
                  jsonb_build_array(v_cash || jsonb_build_object('description', v_memo),
                                    v_counter || jsonb_build_object('description', v_memo)));
  update payments set journal_entry_id = v_je where id = p_payment;

  perform log_audit(v_org, 'payment.post', 'payment', p_payment::text, jsonb_build_object('number', p.number, 'amount', p.amount));
  perform emit_event(v_org, case when p.direction = 'receipt' then 'payment.received' else 'payment.made' end,
                     'payment', p_payment, jsonb_build_object('number', p.number, 'amount', p.amount, 'purpose', p.purpose,
                                                              'invoice_id', p.invoice_id, 'bill_id', p.bill_id));
  return p.number;
end $$;

-- receivables / payables aging
create or replace function ar_aging(p_as_of date default current_date)
returns table (customer_id uuid, customer text, current_amt numeric, d30 numeric, d60 numeric, d90 numeric, over90 numeric, total numeric)
language sql stable security invoker set search_path = public as $$
  select c.id, c.name_ar,
         sum(case when p_as_of - coalesce(i.due_date, i.issue_date) <= 0 then bal else 0 end),
         sum(case when p_as_of - coalesce(i.due_date, i.issue_date) between 1 and 30 then bal else 0 end),
         sum(case when p_as_of - coalesce(i.due_date, i.issue_date) between 31 and 60 then bal else 0 end),
         sum(case when p_as_of - coalesce(i.due_date, i.issue_date) between 61 and 90 then bal else 0 end),
         sum(case when p_as_of - coalesce(i.due_date, i.issue_date) > 90 then bal else 0 end),
         sum(bal)
    from (select *, net_payable - amount_paid as bal from invoices
           where org_id = current_org_id() and status = 'issued' and doc_type <> 'credit_note'
             and issue_date <= p_as_of) i
    join customers c on c.id = i.customer_id
   where i.bal > 0
   group by c.id, c.name_ar
   order by 8 desc
$$;

create or replace function ap_aging(p_as_of date default current_date)
returns table (vendor_id uuid, vendor text, current_amt numeric, d30 numeric, d60 numeric, d90 numeric, over90 numeric, total numeric)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name_ar,
         sum(case when p_as_of - coalesce(b.due_date, b.bill_date) <= 0 then bal else 0 end),
         sum(case when p_as_of - coalesce(b.due_date, b.bill_date) between 1 and 30 then bal else 0 end),
         sum(case when p_as_of - coalesce(b.due_date, b.bill_date) between 31 and 60 then bal else 0 end),
         sum(case when p_as_of - coalesce(b.due_date, b.bill_date) between 61 and 90 then bal else 0 end),
         sum(case when p_as_of - coalesce(b.due_date, b.bill_date) > 90 then bal else 0 end),
         sum(bal)
    from (select *, net_payable - amount_paid as bal from bills
           where org_id = current_org_id() and status = 'posted' and bill_date <= p_as_of) b
    join vendors v on v.id = b.vendor_id
   where b.bal > 0
   group by v.id, v.name_ar
   order by 8 desc
$$;

-- VAT return (ZATCA form) for a period: output VAT on sales, input VAT on purchases
create or replace function vat_return(p_from date, p_to date)
returns table (line text, taxable numeric, vat numeric)
language sql stable security invoker set search_path = public as $$
  select 'sales_standard', coalesce(sum(case when doc_type='credit_note' then -l.line_net else l.line_net end),0),
                           coalesce(sum(case when doc_type='credit_note' then -l.line_vat else l.line_vat end),0)
    from invoices i join invoice_lines l on l.invoice_id = i.id
   where i.org_id = current_org_id() and i.status = 'issued' and l.tax_category = 'S'
     and i.issue_date between p_from and p_to
  union all
  select 'sales_advance_recovery',
         -coalesce(sum(case when i.doc_type='credit_note' then -i.advance_deduction else i.advance_deduction end),0),
         -coalesce(sum(case when i.doc_type='credit_note' then -(lv.vat - i.vat_amount) else lv.vat - i.vat_amount end),0)
    from invoices i
    cross join lateral (select coalesce(sum(line_vat),0) vat from invoice_lines where invoice_id = i.id) lv
   where i.org_id = current_org_id() and i.status = 'issued' and i.advance_deduction > 0
     and i.issue_date between p_from and p_to
  union all
  select 'sales_zero_rated', coalesce(sum(case when doc_type='credit_note' then -l.line_net else l.line_net end),0), 0
    from invoices i join invoice_lines l on l.invoice_id = i.id
   where i.org_id = current_org_id() and i.status = 'issued' and l.tax_category = 'Z'
     and i.issue_date between p_from and p_to
  union all
  select 'sales_exempt', coalesce(sum(case when doc_type='credit_note' then -l.line_net else l.line_net end),0), 0
    from invoices i join invoice_lines l on l.invoice_id = i.id
   where i.org_id = current_org_id() and i.status = 'issued' and l.tax_category in ('E','O')
     and i.issue_date between p_from and p_to
  union all
  select 'purchases_standard', coalesce(sum(l.line_net),0), coalesce(sum(l.line_vat),0)
    from bills b join bill_lines l on l.bill_id = b.id
   where b.org_id = current_org_id() and b.status = 'posted' and l.tax_rate > 0
     and b.bill_date between p_from and p_to
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────
select apply_org_policies('bills',      'finance.view', 'finance.manage');
select apply_org_policies('bill_lines', 'finance.view', 'finance.manage');
select apply_org_policies('payments',   'finance.view', 'finance.manage');

revoke update on bills, payments from authenticated;
grant update (vendor_id, vendor_ref, project_id, bill_date, due_date, notes, retention_amount) on bills to authenticated;
grant update (direction, purpose, payment_date, account_id, amount, method, reference, invoice_id, bill_id,
              customer_id, vendor_id, counter_account_id, project_id, memo) on payments to authenticated;
