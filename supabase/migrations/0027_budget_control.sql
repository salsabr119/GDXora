-- GDXora · 0027 — Project cost budget: lines added freely, changed only with approval
--  • the budget is a list of lines (category, description, amount) the project
--    team adds; the total is their sum
--  • a saved line is locked: changing or deleting it goes through a change
--    request that someone holding budget.approve (the owner, the
--    system administrator) approves or rejects with a note; an approver's own
--    request applies at once and is recorded the same way
--  • every request — applied or not — stays as the budget's change history

insert into permissions (key, module, name_ar, name_en) values
  ('budget.approve', 'projects', 'اعتماد تعديلات ميزانية المشروع', 'Approve project budget changes')
on conflict do nothing;
-- the administrator role holds it in every company (new companies get it from the admin '%' pattern;
-- the key sits outside 'projects.%' so project managers do not get it by default)
insert into role_permissions (org_id, role_key, perm_key)
select r.org_id, r.key, 'budget.approve' from roles r where r.key = 'admin'
on conflict do nothing;

alter table project_budget_lines
  add column created_by uuid default auth.uid(),
  add column created_at timestamptz not null default now();

-- new lines: a positive amount; saved lines: changed only by decide_budget_change()
create or replace function project_budget_lines_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.amount <= 0 then raise exception 'the budget amount must be above zero'; end if;
    new.description := nullif(trim(new.description), '');
    return new;
  end if;
  -- removed with its project / company: nothing to guard
  if tg_op = 'DELETE' and not exists (select 1 from projects where id = old.project_id) then return old; end if;
  if current_setting('gdx.budget_change', true) is distinct from 'on' then
    raise exception 'budget lines are locked — request a change for the administrator to approve';
  end if;
  return coalesce(new, old);
end $$;
create trigger project_budget_lines_lock before insert or update or delete on project_budget_lines
  for each row execute function project_budget_lines_guard();

create table budget_change_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  line_id         uuid references project_budget_lines(id) on delete set null,
  action          text not null check (action in ('update','delete')),
  old_category    text, old_description text, old_amount numeric(18,2),
  new_category    text, new_description text, new_amount numeric(18,2),
  reason          text not null,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by    uuid default auth.uid(),
  requested_name  text,
  requested_at    timestamptz not null default now(),
  decided_by      uuid,
  decided_name    text,
  decided_at      timestamptz,
  decision_note   text
);
create index on budget_change_requests(project_id, requested_at desc);
select apply_org_policies('budget_change_requests', 'projects.view', 'projects.manage');
revoke insert, update, delete on budget_change_requests from authenticated;   -- through the functions below

create or replace function _apply_budget_change(r budget_change_requests)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('gdx.budget_change', 'on', true);
  if r.action = 'delete' then
    delete from project_budget_lines where id = r.line_id;
  else
    if r.new_amount is null or r.new_amount <= 0 then raise exception 'the budget amount must be above zero'; end if;
    update project_budget_lines set category = r.new_category, description = nullif(trim(r.new_description), ''), amount = r.new_amount
     where id = r.line_id;
  end if;
  perform set_config('gdx.budget_change', 'off', true);
end $$;
revoke execute on function _apply_budget_change(budget_change_requests) from public, anon, authenticated;

-- ask to change or delete a saved line; an approver's request applies at once
create or replace function request_budget_change(p_line uuid, p_action text, p_reason text,
                                                 p_category text default null, p_description text default null, p_amount numeric default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('projects.manage'); l project_budget_lines%rowtype; r budget_change_requests%rowtype;
        v_name text := (select full_name from org_members where org_id = current_org_id() and user_id = auth.uid());
begin
  select * into l from project_budget_lines where id = p_line and org_id = v_org;
  if not found then raise exception 'budget line not found'; end if;
  if p_action not in ('update','delete') then raise exception 'invalid budget change'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason for the change is required'; end if;
  if exists (select 1 from budget_change_requests where line_id = p_line and status = 'pending') then
    raise exception 'this line already has a change waiting for approval';
  end if;
  if p_action = 'update' then
    if p_category is null or p_category not in ('materials','labour','subcontract','equipment','overhead','other') then raise exception 'invalid budget category'; end if;
    if coalesce(p_amount, 0) <= 0 then raise exception 'the budget amount must be above zero'; end if;
    if (p_category, nullif(trim(p_description), ''), p_amount) is not distinct from (l.category, l.description, l.amount) then
      raise exception 'nothing changed in this line';
    end if;
  end if;
  insert into budget_change_requests (org_id, project_id, line_id, action, old_category, old_description, old_amount,
                                      new_category, new_description, new_amount, reason, requested_name)
  values (v_org, l.project_id, l.id, p_action, l.category, l.description, l.amount,
          case when p_action = 'update' then p_category end, case when p_action = 'update' then nullif(trim(p_description), '') end,
          case when p_action = 'update' then p_amount end, trim(p_reason), v_name)
  returning * into r;
  if has_perm('budget.approve') then
    perform _apply_budget_change(r);
    update budget_change_requests set status = 'approved', decided_by = auth.uid(), decided_name = v_name, decided_at = now(),
                                      decision_note = 'اعتُمد مباشرة من صاحب الصلاحية'
     where id = r.id;
  else
    perform emit_event(v_org, 'budget.change_requested', 'project', l.project_id, jsonb_build_object('request_id', r.id, 'action', p_action));
  end if;
  perform log_audit(v_org, 'budget.change_request', 'project', l.project_id::text, jsonb_build_object('request_id', r.id, 'action', p_action));
  return r.id;
end $$;

create or replace function decide_budget_change(p_request uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('budget.approve'); r budget_change_requests%rowtype;
begin
  select * into r from budget_change_requests where id = p_request and org_id = v_org for update;
  if not found or r.status <> 'pending' then raise exception 'pending budget change not found'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'a reason for the rejection is required'; end if;
  if p_approve then
    if r.line_id is null then raise exception 'the budget line no longer exists'; end if;
    perform _apply_budget_change(r);
  end if;
  update budget_change_requests set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), ''),
         decided_name = (select full_name from org_members where org_id = v_org and user_id = auth.uid())
   where id = p_request;
  perform log_audit(v_org, 'budget.change_decide', 'project', r.project_id::text, jsonb_build_object('request_id', p_request, 'approved', p_approve));
end $$;
