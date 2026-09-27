-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0002 — Accounting core: chart of accounts, periods, journals
-- ════════════════════════════════════════════════════════════════════════
-- Double-entry general ledger. Rules enforced here, not in the UI:
--   • a posted entry must balance (Σ debit = Σ credit) and has ≥ 2 lines
--   • posted entries are immutable — corrections are reversing entries
--   • no posting into a closed period, nor to a group (parent) account
-- Every module (sales, finance, payroll) posts through gl_post().
-- ════════════════════════════════════════════════════════════════════════

create table accounts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  code        text not null,
  name_ar     text not null,
  name_en     text,
  type        text not null check (type in ('asset','liability','equity','revenue','expense')),
  parent_id   uuid references accounts(id),
  is_group    boolean not null default false,
  -- stable key the modules post to (ar, vat_output, salaries_expense …)
  system_key  text,
  -- cash/bank accounts can be picked on payment vouchers
  is_cash     boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, system_key)
);
create index on accounts(org_id, parent_id);

create table fiscal_periods (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  status     text not null default 'open' check (status in ('open','closed')),
  closed_at  timestamptz,
  closed_by  uuid,
  check (end_date >= start_date),
  unique (org_id, start_date)
);

create table journal_entries (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  number      text,                                   -- assigned on post
  entry_date  date not null default current_date,
  memo        text,
  source_type text not null default 'manual',          -- manual | invoice | bill | payment | payroll | reversal
  source_id   uuid,
  status      text not null default 'draft' check (status in ('draft','posted','reversed')),
  reversal_of uuid references journal_entries(id),
  reversed_by uuid references journal_entries(id),
  total       numeric(18,2) not null default 0,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  posted_at   timestamptz,
  posted_by   uuid,
  unique (org_id, number)
);
create index on journal_entries(org_id, entry_date desc);
create index on journal_entries(org_id, source_type, source_id);

create table journal_lines (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references journal_entries(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  line_no     int not null default 1,
  account_id  uuid not null references accounts(id),
  debit       numeric(18,2) not null default 0 check (debit  >= 0),
  credit      numeric(18,2) not null default 0 check (credit >= 0),
  description text,
  project_id  uuid,          -- FK added in 0003 (projects = cost dimension)
  party_type  text check (party_type in ('customer','vendor','employee')),
  party_id    uuid,
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index on journal_lines(entry_id);
create index on journal_lines(org_id, account_id);

-- ── immutability of posted entries ──────────────────────────────────────
create or replace function guard_posted_entry()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'posted journal entries cannot be deleted — reverse instead'; end if;
    return old;
  end if;
  -- the only allowed change to a posted entry: being marked reversed
  if old.status = 'posted' and not (new.status = 'reversed' and new.reversed_by is not null
       and (new.entry_date, new.memo, new.total, new.number) is not distinct from (old.entry_date, old.memo, old.total, old.number)) then
    raise exception 'posted journal entries are immutable — reverse instead';
  end if;
  if old.status = 'reversed' then raise exception 'reversed journal entries are immutable'; end if;
  return new;
end $$;
create trigger je_guard before update or delete on journal_entries
  for each row execute function guard_posted_entry();

create or replace function guard_posted_lines()
returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from journal_entries where id = coalesce(new.entry_id, old.entry_id);
  if v_status is distinct from 'draft' and v_status is not null then
    raise exception 'lines of a posted journal entry cannot change';
  end if;
  return coalesce(new, old);
end $$;
create trigger jl_guard before insert or update or delete on journal_lines
  for each row execute function guard_posted_lines();

-- ── posting ─────────────────────────────────────────────────────────────
-- internal: validate + post a draft entry (no permission check — callers do it)
create or replace function _post_entry(p_entry uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e journal_entries%rowtype;
  v_dr numeric; v_cr numeric; v_n int; v_bad int;
begin
  select * into e from journal_entries where id = p_entry for update;
  if not found then raise exception 'journal entry not found'; end if;
  if e.status <> 'draft' then raise exception 'journal entry already posted'; end if;

  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*)
    into v_dr, v_cr, v_n from journal_lines where entry_id = p_entry;
  if v_n < 2 then raise exception 'journal entry needs at least two lines'; end if;
  if v_dr <> v_cr then raise exception 'journal entry is not balanced (debit % ≠ credit %)', v_dr, v_cr; end if;
  if v_dr = 0 then raise exception 'journal entry total is zero'; end if;

  select count(*) into v_bad from journal_lines l join accounts a on a.id = l.account_id
   where l.entry_id = p_entry and (a.is_group or not a.active or a.org_id <> e.org_id);
  if v_bad > 0 then raise exception 'cannot post to group, inactive or foreign accounts'; end if;

  if exists (select 1 from fiscal_periods
              where org_id = e.org_id and status = 'closed'
                and e.entry_date between start_date and end_date) then
    raise exception 'period is closed for %', e.entry_date;
  end if;

  update journal_entries
     set status = 'posted', total = v_dr, posted_at = now(), posted_by = auth.uid(),
         number = coalesce(number, next_doc_number(e.org_id, 'JV'))
   where id = p_entry;

  return (select number from journal_entries where id = p_entry);
end $$;

-- internal: create + post a balanced entry from a module. p_lines is a JSON
-- array of {account_id|account_key, debit, credit, description, project_id,
-- party_type, party_id}. Zero lines are skipped; lines on the same account/
-- project/party are kept separate (readable ledger).
create or replace function gl_post(p_org uuid, p_date date, p_memo text,
                                   p_source_type text, p_source_id uuid, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; l jsonb; v_acc uuid; i int := 0;
begin
  insert into journal_entries (org_id, entry_date, memo, source_type, source_id)
  values (p_org, p_date, p_memo, p_source_type, p_source_id) returning id into v_id;

  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((l->>'debit')::numeric, 0) = 0 and coalesce((l->>'credit')::numeric, 0) = 0 then
      continue;
    end if;
    v_acc := nullif(l->>'account_id', '')::uuid;
    if v_acc is null then
      select id into v_acc from accounts where org_id = p_org and system_key = l->>'account_key';
      if v_acc is null then raise exception 'system account "%" is not configured', l->>'account_key'; end if;
    end if;
    i := i + 1;
    insert into journal_lines (entry_id, org_id, line_no, account_id, debit, credit, description, project_id, party_type, party_id)
    values (v_id, p_org, i, v_acc,
            round(coalesce((l->>'debit')::numeric, 0), 2), round(coalesce((l->>'credit')::numeric, 0), 2),
            l->>'description', nullif(l->>'project_id','')::uuid, l->>'party_type', nullif(l->>'party_id','')::uuid);
  end loop;

  perform _post_entry(v_id);
  return v_id;
end $$;

-- public RPC: create a manual journal entry (draft or posted)
create or replace function create_journal(p_date date, p_memo text, p_lines jsonb, p_post boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.manage'); v_id uuid; l jsonb; i int := 0;
begin
  if p_post and not has_perm('accounting.post') then raise exception 'permission denied: accounting.post' using errcode='42501'; end if;
  insert into journal_entries (org_id, entry_date, memo, source_type)
  values (v_org, p_date, p_memo, 'manual') returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    insert into journal_lines (entry_id, org_id, line_no, account_id, debit, credit, description, project_id)
    values (v_id, v_org, i, (l->>'account_id')::uuid,
            round(coalesce((l->>'debit')::numeric,0),2), round(coalesce((l->>'credit')::numeric,0),2),
            l->>'description', nullif(l->>'project_id','')::uuid);
  end loop;
  if p_post then perform _post_entry(v_id); end if;
  perform log_audit(v_org, 'journal.create', 'journal_entry', v_id::text, jsonb_build_object('posted', p_post));
  return v_id;
end $$;

create or replace function post_journal(p_entry uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.post'); v_no text;
begin
  if not exists (select 1 from journal_entries where id = p_entry and org_id = v_org) then
    raise exception 'journal entry not found';
  end if;
  v_no := _post_entry(p_entry);
  perform log_audit(v_org, 'journal.post', 'journal_entry', p_entry::text, jsonb_build_object('number', v_no));
  return v_no;
end $$;

-- internal reversal (used by modules when cancelling a document)
create or replace function _reverse_entry(p_entry uuid, p_date date, p_memo text)
returns uuid language plpgsql security definer set search_path = public as $$
declare e journal_entries%rowtype; v_id uuid;
begin
  select * into e from journal_entries where id = p_entry for update;
  if e.status <> 'posted' then raise exception 'only posted entries can be reversed'; end if;

  insert into journal_entries (org_id, entry_date, memo, source_type, source_id, reversal_of)
  values (e.org_id, coalesce(p_date, e.entry_date),
          coalesce(p_memo, 'عكس القيد ' || e.number), 'reversal', e.id, e.id)
  returning id into v_id;

  insert into journal_lines (entry_id, org_id, line_no, account_id, debit, credit, description, project_id, party_type, party_id)
  select v_id, org_id, line_no, account_id, credit, debit, description, project_id, party_type, party_id
    from journal_lines where entry_id = p_entry;

  perform _post_entry(v_id);
  update journal_entries set status = 'reversed', reversed_by = v_id where id = p_entry;
  return v_id;
end $$;

create or replace function reverse_journal(p_entry uuid, p_date date default null, p_memo text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.post'); v_id uuid;
begin
  if not exists (select 1 from journal_entries where id = p_entry and org_id = v_org and source_type = 'manual') then
    raise exception 'only manual entries of this org can be reversed here — cancel the source document instead';
  end if;
  v_id := _reverse_entry(p_entry, p_date, p_memo);
  perform log_audit(v_org, 'journal.reverse', 'journal_entry', p_entry::text, jsonb_build_object('reversal', v_id));
  return v_id;
end $$;

create or replace function close_period(p_period uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.close');
begin
  update fiscal_periods set status = 'closed', closed_at = now(), closed_by = auth.uid()
   where id = p_period and org_id = v_org and status = 'open';
  if not found then raise exception 'period not found or already closed'; end if;
  if exists (select 1 from journal_entries je join fiscal_periods p on p.id = p_period
              where je.org_id = v_org and je.status = 'draft' and je.entry_date between p.start_date and p.end_date) then
    raise exception 'period still has draft journal entries';
  end if;
  perform log_audit(v_org, 'period.close', 'fiscal_period', p_period::text);
end $$;

-- ── reports ─────────────────────────────────────────────────────────────
-- trial balance for a date range (posted + reversed entries both count:
-- a reversal is its own posted entry that cancels the original)
create or replace function trial_balance(p_from date default null, p_to date default null)
returns table (account_id uuid, code text, name_ar text, name_en text, type text,
               opening numeric, debit numeric, credit numeric, closing numeric)
language sql stable security invoker set search_path = public as $$
  with mv as (
    select l.account_id,
           sum(case when e.entry_date <  coalesce(p_from, '0001-01-01') then l.debit - l.credit else 0 end) as opening,
           sum(case when e.entry_date >= coalesce(p_from, '0001-01-01') then l.debit  else 0 end) as debit,
           sum(case when e.entry_date >= coalesce(p_from, '0001-01-01') then l.credit else 0 end) as credit
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.org_id = current_org_id() and e.status in ('posted','reversed')
       and e.entry_date <= coalesce(p_to, '9999-12-31')
     group by l.account_id)
  select a.id, a.code, a.name_ar, a.name_en, a.type,
         coalesce(mv.opening,0), coalesce(mv.debit,0), coalesce(mv.credit,0),
         coalesce(mv.opening,0) + coalesce(mv.debit,0) - coalesce(mv.credit,0)
    from accounts a join mv on mv.account_id = a.id
   where a.org_id = current_org_id()
   order by a.code
$$;

-- account ledger with running balance
create or replace function account_ledger(p_account uuid, p_from date default null, p_to date default null)
returns table (entry_id uuid, number text, entry_date date, memo text, description text,
               debit numeric, credit numeric, balance numeric)
language sql stable security invoker set search_path = public as $$
  select e.id, e.number, e.entry_date, e.memo, l.description, l.debit, l.credit,
         sum(l.debit - l.credit) over (order by e.entry_date, e.posted_at, l.line_no
                                       rows between unbounded preceding and current row)
    from journal_lines l join journal_entries e on e.id = l.entry_id
   where l.account_id = p_account and e.org_id = current_org_id()
     and e.status in ('posted','reversed')
     and e.entry_date between coalesce(p_from,'0001-01-01') and coalesce(p_to,'9999-12-31')
   order by e.entry_date, e.posted_at, l.line_no
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────
select apply_org_policies('accounts',        'accounting.view', 'accounting.manage');
select apply_org_policies('fiscal_periods',  'accounting.view', 'accounting.manage');
-- journals: read via policy, writes only through the RPCs above
alter table journal_entries enable row level security;
alter table journal_lines   enable row level security;
create policy je_read on journal_entries for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('accounting.view'));
create policy jl_read on journal_lines for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('accounting.view'));
-- drafts may be edited/deleted directly by accountants (posted ones are guarded by triggers)
create policy je_draft_write on journal_entries for update to authenticated
  using (org_id = (select current_org_id()) and has_perm('accounting.manage') and status = 'draft');
create policy je_draft_del on journal_entries for delete to authenticated
  using (org_id = (select current_org_id()) and has_perm('accounting.manage') and status = 'draft');

-- users may only touch the header text of a draft; status/number/totals change
-- exclusively through the posting functions
revoke update on journal_entries from authenticated;
grant update (entry_date, memo) on journal_entries to authenticated;
revoke insert, update, delete on journal_lines from authenticated;

-- replace the lines of a draft entry (and optionally post it)
create or replace function update_journal_draft(p_entry uuid, p_date date, p_memo text, p_lines jsonb, p_post boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.manage'); l jsonb; i int := 0;
begin
  if not exists (select 1 from journal_entries where id = p_entry and org_id = v_org and status = 'draft') then
    raise exception 'draft journal entry not found';
  end if;
  if p_post and not has_perm('accounting.post') then raise exception 'permission denied: accounting.post' using errcode='42501'; end if;
  update journal_entries set entry_date = p_date, memo = p_memo where id = p_entry;
  delete from journal_lines where entry_id = p_entry;
  for l in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    insert into journal_lines (entry_id, org_id, line_no, account_id, debit, credit, description, project_id)
    values (p_entry, v_org, i, (l->>'account_id')::uuid,
            round(coalesce((l->>'debit')::numeric,0),2), round(coalesce((l->>'credit')::numeric,0),2),
            l->>'description', nullif(l->>'project_id','')::uuid);
  end loop;
  if p_post then perform _post_entry(p_entry); end if;
end $$;

-- ── Saudi default chart of accounts (services / contracting) ───────────
create or replace function seed_default_coa(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_parent uuid;
begin
  for r in select * from (values
    -- code,  parent, name_ar,                              name_en,                       type,        group, system_key,            cash
    ('1',    null,  'الأصول',                                'Assets',                      'asset',     true,  null,                  false),
    ('11',   '1',   'الأصول المتداولة',                      'Current assets',              'asset',     true,  null,                  false),
    ('1101', '11',  'الصندوق',                               'Cash on hand',                'asset',     false, 'cash',                true),
    ('1102', '11',  'البنك',                                 'Bank',                        'asset',     false, 'bank',                true),
    ('1103', '11',  'العملاء (ذمم مدينة)',                   'Accounts receivable',         'asset',     false, 'ar',                  false),
    ('1104', '11',  'محتجزات لدى العملاء',                   'Retention receivable',        'asset',     false, 'retention_receivable',false),
    ('1105', '11',  'ضريبة القيمة المضافة - مدخلات',         'VAT input',                   'asset',     false, 'vat_input',           false),
    ('1106', '11',  'سلف وعهد الموظفين',                     'Employee advances',           'asset',     false, 'employee_advances',   false),
    ('1107', '11',  'مصروفات مدفوعة مقدماً',                 'Prepaid expenses',            'asset',     false, 'prepaid',             false),
    ('1108', '11',  'أعمال منفذة غير مفوترة',                'Unbilled work (WIP)',         'asset',     false, 'unbilled',            false),
    ('12',   '1',   'الأصول غير المتداولة',                  'Non-current assets',          'asset',     true,  null,                  false),
    ('1201', '12',  'المعدات والآليات',                      'Equipment & machinery',       'asset',     false, 'equipment',           false),
    ('1202', '12',  'السيارات',                              'Vehicles',                    'asset',     false, 'vehicles',            false),
    ('1203', '12',  'الأثاث والأجهزة',                       'Furniture & IT',              'asset',     false, 'furniture',           false),
    ('1209', '12',  'مجمع الإهلاك',                          'Accumulated depreciation',    'asset',     false, 'accum_depreciation',  false),
    ('2',    null,  'الالتزامات',                            'Liabilities',                 'liability', true,  null,                  false),
    ('21',   '2',   'الالتزامات المتداولة',                  'Current liabilities',         'liability', true,  null,                  false),
    ('2101', '21',  'الموردون (ذمم دائنة)',                  'Accounts payable',            'liability', false, 'ap',                  false),
    ('2102', '21',  'ضريبة القيمة المضافة - مخرجات',         'VAT output',                  'liability', false, 'vat_output',          false),
    ('2103', '21',  'رواتب مستحقة',                          'Salaries payable',            'liability', false, 'salaries_payable',    false),
    ('2104', '21',  'التأمينات الاجتماعية مستحقة',           'GOSI payable',                'liability', false, 'gosi_payable',        false),
    ('2105', '21',  'دفعات مقدمة من العملاء',                'Customer advances',           'liability', false, 'customer_advances',   false),
    ('2106', '21',  'محتجزات للمقاولين من الباطن',           'Retention payable',           'liability', false, 'retention_payable',   false),
    ('2107', '21',  'مصروفات مستحقة',                        'Accrued expenses',            'liability', false, 'accrued',             false),
    ('22',   '2',   'الالتزامات غير المتداولة',              'Non-current liabilities',     'liability', true,  null,                  false),
    ('2201', '22',  'مخصص مكافأة نهاية الخدمة',              'End-of-service provision',    'liability', false, 'eosb_provision',      false),
    ('3',    null,  'حقوق الملكية',                          'Equity',                      'equity',    true,  null,                  false),
    ('3101', '3',   'رأس المال',                             'Capital',                     'equity',    false, 'capital',             false),
    ('3102', '3',   'جاري الشركاء',                          'Partners current',            'equity',    false, 'partners_current',    false),
    ('3103', '3',   'الأرباح المبقاة',                       'Retained earnings',           'equity',    false, 'retained_earnings',   false),
    ('4',    null,  'الإيرادات',                             'Revenue',                     'revenue',   true,  null,                  false),
    ('4101', '4',   'إيرادات العقود والمشاريع',              'Contract revenue',            'revenue',   false, 'revenue_contracts',   false),
    ('4102', '4',   'إيرادات الخدمات',                       'Service revenue',             'revenue',   false, 'revenue_services',    false),
    ('4109', '4',   'إيرادات أخرى',                          'Other income',                'revenue',   false, 'revenue_other',       false),
    ('5',    null,  'تكاليف المشاريع',                       'Project costs',               'expense',   true,  null,                  false),
    ('5101', '5',   'مواد مباشرة',                           'Direct materials',            'expense',   false, 'cost_materials',      false),
    ('5102', '5',   'عمالة مباشرة',                          'Direct labour',               'expense',   false, 'cost_labour',         false),
    ('5103', '5',   'مقاولو الباطن',                         'Subcontractors',              'expense',   false, 'cost_subcontract',    false),
    ('5104', '5',   'إيجار معدات',                           'Equipment rental',            'expense',   false, 'cost_equipment',      false),
    ('6',    null,  'المصروفات العمومية والإدارية',          'G&A expenses',                'expense',   true,  null,                  false),
    ('6101', '6',   'الرواتب والأجور',                       'Salaries & wages',            'expense',   false, 'salaries_expense',    false),
    ('6102', '6',   'التأمينات الاجتماعية - حصة المنشأة',    'GOSI – employer share',       'expense',   false, 'gosi_expense',        false),
    ('6103', '6',   'مكافأة نهاية الخدمة',                   'End-of-service expense',      'expense',   false, 'eosb_expense',        false),
    ('6104', '6',   'الإيجارات',                             'Rent',                        'expense',   false, 'rent',                false),
    ('6105', '6',   'رسوم حكومية وإقامات',                   'Government fees',             'expense',   false, 'gov_fees',            false),
    ('6106', '6',   'الكهرباء والمياه والاتصالات',           'Utilities & telecom',         'expense',   false, 'utilities',           false),
    ('6107', '6',   'مصروفات بنكية',                         'Bank charges',                'expense',   false, 'bank_charges',        false),
    ('6108', '6',   'الإهلاك',                               'Depreciation',                'expense',   false, 'depreciation',        false),
    ('6199', '6',   'مصروفات أخرى',                          'Other expenses',              'expense',   false, 'expense_other',       false)
  ) as t(code, parent, name_ar, name_en, type, is_group, system_key, is_cash)
  loop
    v_parent := null;
    if r.parent is not null then
      select id into v_parent from accounts where org_id = p_org and code = r.parent;
    end if;
    insert into accounts (org_id, code, name_ar, name_en, type, parent_id, is_group, system_key, is_cash)
    values (p_org, r.code, r.name_ar, r.name_en, r.type, v_parent, r.is_group, r.system_key, r.is_cash)
    on conflict (org_id, code) do nothing;
  end loop;
end $$;
