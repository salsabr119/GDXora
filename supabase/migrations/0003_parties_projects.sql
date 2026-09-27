-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0003 — Parties (customers, vendors) and projects
-- ════════════════════════════════════════════════════════════════════════
-- Projects are the main cost/revenue dimension for a services & contracting
-- company: every journal line, invoice, bill and payroll line can carry a
-- project_id, so project profitability comes straight from the ledger.
-- ════════════════════════════════════════════════════════════════════════

create table customers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  code         text,
  name_ar      text not null,
  name_en      text,
  customer_type text not null default 'business' check (customer_type in ('business','individual','government')),
  vat_number   text,
  cr_number    text,
  -- national address (buyer address is mandatory on ZATCA standard invoices)
  street       text,
  building_no  text,
  district     text,
  city         text,
  postal_code  text,
  country      text not null default 'SA',
  phone        text,
  email        text,
  payment_terms_days int not null default 30,
  credit_limit numeric(18,2),
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, code),
  constraint customer_vat_format check (vat_number is null or vat_number ~ '^3[0-9]{13}3$')
);

create table vendors (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  code         text,
  name_ar      text not null,
  name_en      text,
  vendor_type  text not null default 'supplier' check (vendor_type in ('supplier','subcontractor','service','government')),
  vat_number   text,
  cr_number    text,
  city         text,
  address      text,
  phone        text,
  email        text,
  iban         text,
  payment_terms_days int not null default 30,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, code),
  constraint vendor_vat_format check (vat_number is null or vat_number ~ '^3[0-9]{13}3$')
);

create table projects (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  code            text,
  name_ar         text not null,
  name_en         text,
  customer_id     uuid references customers(id),
  contract_no     text,
  contract_value  numeric(18,2) not null default 0,   -- excl. VAT
  retention_pct   numeric(5,2)  not null default 0 check (retention_pct between 0 and 100),
  advance_amount  numeric(18,2) not null default 0,   -- advance payment received
  advance_recovery_pct numeric(5,2) not null default 0 check (advance_recovery_pct between 0 and 100),
  start_date      date,
  end_date        date,
  status          text not null default 'active' check (status in ('planned','active','on_hold','completed','closed')),
  manager_name    text,
  location        text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, code)
);

-- budget per cost category (materials, labour, subcontract, equipment, other)
create table project_budget_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  category    text not null check (category in ('materials','labour','subcontract','equipment','overhead','other')),
  description text,
  amount      numeric(18,2) not null default 0,
  unique (project_id, category, description)
);

-- contract items (BOQ) — basis for progress billings (مستخلصات)
create table project_boq_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  item_no     text,
  description text not null,
  unit        text,
  quantity    numeric(18,3) not null default 0,
  unit_price  numeric(18,2) not null default 0,
  amount      numeric(18,2) generated always as (round(quantity * unit_price, 2)) stored,
  sort        int not null default 0
);

alter table journal_lines
  add constraint journal_lines_project_fk foreign key (project_id) references projects(id);
create index on journal_lines(project_id) where project_id is not null;

-- auto codes
create or replace function assign_party_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code is null or new.code = '' then
    new.code := next_doc_number(new.org_id, tg_argv[0]);
  end if;
  return new;
end $$;

-- enforce_org_id must run first (fills org_id) — triggers fire alphabetically
select apply_org_policies('customers',            'sales.view',    'sales.manage');
select apply_org_policies('vendors',              'finance.view',  'finance.manage');
select apply_org_policies('projects',             'projects.view', 'projects.manage');
select apply_org_policies('project_budget_lines', 'projects.view', 'projects.manage');
select apply_org_policies('project_boq_items',    'projects.view', 'projects.manage');

create trigger customers_zcode before insert on customers for each row execute function assign_party_code('CUS');
create trigger vendors_zcode   before insert on vendors   for each row execute function assign_party_code('VEN');
create trigger projects_zcode  before insert on projects  for each row execute function assign_party_code('PRJ');
create trigger customers_upd before update on customers for each row execute function set_updated_at();
create trigger vendors_upd   before update on vendors   for each row execute function set_updated_at();
create trigger projects_upd  before update on projects  for each row execute function set_updated_at();

-- ── project profitability straight from the ledger ─────────────────────
create or replace function project_summary(p_project uuid default null)
returns table (project_id uuid, code text, name_ar text, contract_value numeric,
               budget numeric, revenue numeric, cost numeric, profit numeric, margin_pct numeric)
language sql stable security invoker set search_path = public as $$
  with gl as (
    select l.project_id,
           sum(case when a.type = 'revenue' then l.credit - l.debit else 0 end) as revenue,
           sum(case when a.type = 'expense' then l.debit - l.credit else 0 end) as cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where e.org_id = current_org_id() and e.status in ('posted','reversed') and l.project_id is not null
     group by l.project_id),
  bud as (select project_id, sum(amount) as budget from project_budget_lines group by project_id)
  select p.id, p.code, p.name_ar, p.contract_value, coalesce(b.budget,0),
         coalesce(g.revenue,0), coalesce(g.cost,0), coalesce(g.revenue,0) - coalesce(g.cost,0),
         case when coalesce(g.revenue,0) = 0 then null
              else round((coalesce(g.revenue,0) - coalesce(g.cost,0)) / g.revenue * 100, 1) end
    from projects p
    left join gl g on g.project_id = p.id
    left join bud b on b.project_id = p.id
   where p.org_id = current_org_id() and (p_project is null or p.id = p_project)
   order by p.code
$$;
