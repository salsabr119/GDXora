-- GDXora · 0025 — Contract claims beyond the monthly progress billing
--  • variation orders (أوامر التغيير): additional work approved by the owner
--    is added to the BOQ as items carrying the order's number, date and
--    reference, so the next progress billing bills it like any other item;
--    the revised contract value = contract value + variation items
--  • retention release (الإفراج عن المحتجزات): a numbered claim for retention
--    held on the project's issued invoices — never more than is still held.
--    VAT was charged on the full invoices, so the claim carries none; the
--    money is received with a receipt voucher against «محتجزات لدى العملاء»

-- ── variation orders ────────────────────────────────────────────────────
alter table project_boq_items
  add column variation_no   text,
  add column variation_date date,
  add column variation_ref  text;      -- the owner's approval letter / reference

--   p: { variation_no, variation_date?, variation_ref?, items: [{ item_no?, description, unit?, quantity, unit_price }] }
create or replace function add_variation_order(p_project uuid, p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('projects.manage'); v_no text := nullif(trim(p ->> 'variation_no'), ''); v_sort int; n int;
begin
  if not exists (select 1 from projects where id = p_project and org_id = v_org) then raise exception 'project not found'; end if;
  if v_no is null then raise exception 'the variation order needs a number'; end if;
  if exists (select 1 from project_boq_items where project_id = p_project and variation_no = v_no) then
    raise exception 'variation order % already exists on this project', v_no;
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception 'the variation order needs at least one item'; end if;
  if exists (select 1 from jsonb_array_elements(p -> 'items') i
              where coalesce(trim(i ->> 'description'), '') = '' or coalesce((i ->> 'quantity')::numeric, 0) <= 0
                 or coalesce((i ->> 'unit_price')::numeric, -1) < 0) then
    raise exception 'every item needs a description, a quantity above zero and a price';
  end if;
  select coalesce(max(sort), 0) into v_sort from project_boq_items where project_id = p_project;
  insert into project_boq_items (org_id, project_id, item_no, description, unit, quantity, unit_price, sort, variation_no, variation_date, variation_ref)
  select v_org, p_project, coalesce(nullif(trim(i ->> 'item_no'), ''), v_no || '-' || ord), trim(i ->> 'description'), nullif(trim(i ->> 'unit'), ''),
         (i ->> 'quantity')::numeric, (i ->> 'unit_price')::numeric, v_sort + ord::int,
         v_no, coalesce(nullif(p ->> 'variation_date', '')::date, current_date), nullif(trim(p ->> 'variation_ref'), '')
    from jsonb_array_elements(p -> 'items') with ordinality as x(i, ord);
  get diagnostics n = row_count;
  perform log_audit(v_org, 'project.variation', 'project', p_project::text, jsonb_build_object('variation_no', v_no, 'items', n));
  return n;
end $$;

-- ── retention release ───────────────────────────────────────────────────
create table retention_releases (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  number        text,
  project_id    uuid not null references projects(id),
  customer_id   uuid references customers(id),
  release_date  date not null default current_date,
  kind          text not null default 'completion' check (kind in ('completion','warranty','partial')),
  amount        numeric(18,2) not null check (amount > 0),
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  unique (org_id, number)
);
select apply_org_policies('retention_releases', 'projects.view', 'projects.manage');
revoke insert, update, delete on retention_releases from authenticated;   -- issued claims are final

-- retention on a project: held on issued invoices (credit notes reverse it),
-- claimed by releases, received (credits to the retention account), outstanding
create or replace function project_retention(p_project uuid)
returns table (held numeric, claimed numeric, received numeric, available numeric, outstanding numeric)
language sql stable security definer set search_path = public as $$
  with h as (
    select coalesce(sum(case when doc_type = 'credit_note' then -retention_amount else retention_amount end), 0) as v
      from invoices where project_id = p_project and org_id = current_org_id() and status = 'issued'),
  c as (select coalesce(sum(amount), 0) as v from retention_releases where project_id = p_project and org_id = current_org_id()),
  r as (
    select coalesce(sum(l.credit), 0) as v
      from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
     where e.org_id = current_org_id() and e.status in ('posted','reversed') and a.system_key = 'retention_receivable'
       and l.project_id = p_project and e.source_type = 'payment')
  select h.v, c.v, r.v, h.v - c.v, h.v - r.v from h, c, r
   where has_perm('projects.view') or has_perm('sales.view') or has_perm('finance.view')
$$;

create or replace function create_retention_release(p_project uuid, p_amount numeric, p_date date default current_date,
                                                    p_kind text default 'completion', p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('projects.manage'); p projects%rowtype; v_avail numeric; v_id uuid;
begin
  select * into p from projects where id = p_project and org_id = v_org for update;   -- one claim at a time per project
  if not found then raise exception 'project not found'; end if;
  select available into v_avail from project_retention(p_project);
  if coalesce(p_amount, 0) <= 0 then raise exception 'the amount must be above zero'; end if;
  if p_amount > v_avail then raise exception 'amount exceeds the retention still held (%)', v_avail; end if;
  insert into retention_releases (org_id, number, project_id, customer_id, release_date, kind, amount, notes)
  values (v_org, next_doc_number(v_org, 'RET'), p_project, p.customer_id, coalesce(p_date, current_date), p_kind, p_amount, nullif(trim(p_notes), ''))
  returning id into v_id;
  perform log_audit(v_org, 'retention.release', 'retention_release', v_id::text, jsonb_build_object('project_id', p_project, 'amount', p_amount));
  perform emit_event(v_org, 'retention.release_claimed', 'retention_release', v_id, jsonb_build_object('project_id', p_project, 'amount', p_amount));
  return v_id;
end $$;
