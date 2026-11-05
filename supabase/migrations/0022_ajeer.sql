-- GDXora · 0022 — Temporary workers through Ajeer (أجير، منصة قوى)
-- A worker lent by another establishment for a project. The lending
-- establishment stays the legal employer (Ministerial Resolution 60339, in
-- force 26 Jan 2026), so the worker is not on payroll or GOSI here; the cost
-- reaches the project through the lender's vendor bills.
--  • one row per Ajeer contract / permit: worker, lender, permit, dates, project
--  • the permit lasts at most three years; a worker cannot hold two
--    overlapping contracts in the same company
--  • the contract ends on its end date: the screen and alerts derive the
--    status from the dates, so nothing has to be closed by hand
--  • fees and durations below three years change with the platform's rules,
--    so they are entered per contract, never assumed

create table temp_workers (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  worker_name         text not null,
  iqama_no            text not null constraint temp_workers_iqama check (iqama_no ~ '^[12][0-9]{9}$'),
  nationality         text,
  profession          text not null,
  provider_name       text not null,                 -- lending establishment
  provider_unified_no text,                          -- الرقم الموحد للمنشأة (7…)
  provider_cr         text,
  vendor_id           uuid references vendors(id),   -- the lender as a vendor, for its bills
  permit_no           text,                          -- Ajeer contract / permit number
  start_date          date not null,
  end_date            date not null,
  project_id          uuid references projects(id),
  monthly_cost        numeric(18,2) not null default 0 check (monthly_cost >= 0),
  end_reason          text,                          -- when ended before the planned date
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, permit_no),
  constraint temp_workers_dates check (end_date >= start_date),
  constraint temp_workers_max_3y check (end_date < (start_date + interval '3 years')::date)
);
create index on temp_workers(org_id, end_date);
create index on temp_workers(org_id, iqama_no);

select apply_org_policies('temp_workers', 'hr.view', 'hr.manage');
create trigger temp_workers_upd_at before update on temp_workers for each row execute function set_updated_at();

-- same-company references, and no overlapping contracts for one worker
create or replace function temp_workers_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.worker_name := trim(new.worker_name);
  new.iqama_no := trim(new.iqama_no);
  if new.project_id is not null and not exists (select 1 from projects where id = new.project_id and org_id = new.org_id) then
    raise exception 'project not found';
  end if;
  if new.vendor_id is not null and not exists (select 1 from vendors where id = new.vendor_id and org_id = new.org_id) then
    raise exception 'vendor not found';
  end if;
  if exists (select 1 from temp_workers w
              where w.org_id = new.org_id and w.iqama_no = new.iqama_no and w.id <> new.id
                and daterange(w.start_date, w.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')) then
    raise exception 'worker % already has an Ajeer contract in this period', new.iqama_no;
  end if;
  return new;
end $$;
-- "zguard" sorts after the org_id trigger, so org_id is filled first
create trigger temp_workers_zguard before insert or update on temp_workers
  for each row execute function temp_workers_guard();

-- create / update contracts in one transaction (the form and the Excel import)
--   p_rows: [{ id?, ...temp_workers columns }]
create or replace function save_temp_workers(p_rows jsonb)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := require_perm('hr.manage'); r jsonb; v_id uuid; v_ids uuid[] := '{}'; v_set text;
  cols text[] := array['worker_name','iqama_no','nationality','profession','provider_name','provider_unified_no','provider_cr',
                       'vendor_id','permit_no','start_date','end_date','project_id','monthly_cost','end_reason','notes'];
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    -- an empty permit number means "none", not a duplicate of another empty one
    if r ? 'permit_no' and trim(coalesce(r ->> 'permit_no', '')) = '' then r := jsonb_set(r, '{permit_no}', 'null'); end if;
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is null then
      execute format('insert into temp_workers (org_id, %1$s) select $1, %1$s from jsonb_populate_record(null::temp_workers, $2) returning id',
                     (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(r) k where k = any(cols)))
        into v_id using v_org, r;
    else
      if not exists (select 1 from temp_workers where id = v_id and org_id = v_org) then raise exception 'contract not found'; end if;
      select string_agg(format('%1$I = x.%1$I', k), ', ') into v_set from jsonb_object_keys(r) k where k = any(cols);
      if v_set is not null then
        execute format('update temp_workers w set %s from jsonb_populate_record(null::temp_workers, $1) x where w.id = $2', v_set) using r, v_id;
      end if;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  perform log_audit(v_org, 'ajeer.save', 'temp_workers', null, jsonb_build_object('rows', jsonb_array_length(p_rows)));
  return v_ids;
end $$;

-- contracts ending soon (and those that ended in the last week), for alerts
create or replace function ajeer_expiring(p_days int default 30)
returns table (id uuid, worker_name text, iqama_no text, provider_name text, project text, end_date date, days_left int)
language sql stable security definer set search_path = public as $$
  -- definer: HR sees the project's name without opening the projects module
  select w.id, w.worker_name, w.iqama_no, w.provider_name, p.name_ar, w.end_date, (w.end_date - current_date)::int
    from temp_workers w left join projects p on p.id = w.project_id
   where w.org_id = current_org_id() and has_perm('hr.view') and w.start_date <= current_date + p_days
     and w.end_date between current_date - 7 and current_date + p_days
   order by w.end_date, w.worker_name
$$;
