-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0010 — Documents that reached the ledger can never be deleted
-- ════════════════════════════════════════════════════════════════════════
create or replace function guard_delete_non_draft()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception '% cannot be deleted once %', tg_table_name, old.status;
  end if;
  return old;
end $$;

create trigger bills_no_delete             before delete on bills             for each row execute function guard_delete_non_draft();
create trigger payments_no_delete          before delete on payments          for each row execute function guard_delete_non_draft();
create trigger payroll_runs_no_delete      before delete on payroll_runs      for each row execute function guard_delete_non_draft();
create trigger progress_billings_no_delete before delete on progress_billings for each row execute function guard_delete_non_draft();

-- the owner cannot be removed or demoted by other admins
create or replace function guard_owner()
returns trigger language plpgsql as $$
begin
  if old.is_owner and (tg_op = 'DELETE' or not new.is_owner or not new.active) then
    raise exception 'the company owner cannot be removed or deactivated';
  end if;
  return coalesce(new, old);
end $$;
create trigger org_members_owner before update or delete on org_members for each row execute function guard_owner();
revoke update on org_members from authenticated;
grant update (role_key, active, full_name) on org_members to authenticated;
