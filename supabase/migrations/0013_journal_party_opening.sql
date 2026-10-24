-- GDXora · 0013 — Manual journal entries keep the party (customer / vendor /
-- employee) of each line, and an entry can be marked as the opening balances
-- entry (imported from Excel when a company moves onto the system).

create or replace function _journal_lines_insert(p_org uuid, p_entry uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare l jsonb; i int := 0; v_type text; v_party uuid;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    v_type := nullif(l->>'party_type', ''); v_party := nullif(l->>'party_id', '')::uuid;
    if (v_type is null) <> (v_party is null) then raise exception 'line %: party type and party go together', i; end if;
    if v_party is not null and not (
         (v_type = 'customer' and exists (select 1 from customers where id = v_party and org_id = p_org)) or
         (v_type = 'vendor'   and exists (select 1 from vendors   where id = v_party and org_id = p_org)) or
         (v_type = 'employee' and exists (select 1 from employees where id = v_party and org_id = p_org))) then
      raise exception 'line %: party not found', i;
    end if;
    insert into journal_lines (entry_id, org_id, line_no, account_id, debit, credit, description, project_id, party_type, party_id)
    values (p_entry, p_org, i, (l->>'account_id')::uuid,
            round(coalesce((l->>'debit')::numeric,0),2), round(coalesce((l->>'credit')::numeric,0),2),
            l->>'description', nullif(l->>'project_id','')::uuid, v_type, v_party);
  end loop;
end $$;
revoke execute on function _journal_lines_insert(uuid, uuid, jsonb) from public, anon, authenticated;

drop function if exists create_journal(date, text, jsonb, boolean);
create or replace function create_journal(p_date date, p_memo text, p_lines jsonb, p_post boolean default false,
                                          p_source text default 'manual')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.manage'); v_id uuid;
begin
  if p_source not in ('manual', 'opening') then raise exception 'invalid journal source'; end if;
  if p_post and not has_perm('accounting.post') then raise exception 'permission denied: accounting.post' using errcode='42501'; end if;
  insert into journal_entries (org_id, entry_date, memo, source_type)
  values (v_org, p_date, p_memo, p_source) returning id into v_id;
  perform _journal_lines_insert(v_org, v_id, p_lines);
  if p_post then perform _post_entry(v_id); end if;
  perform log_audit(v_org, 'journal.create', 'journal_entry', v_id::text, jsonb_build_object('posted', p_post, 'source', p_source));
  return v_id;
end $$;

create or replace function update_journal_draft(p_entry uuid, p_date date, p_memo text, p_lines jsonb, p_post boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := require_perm('accounting.manage');
begin
  if not exists (select 1 from journal_entries where id = p_entry and org_id = v_org and status = 'draft') then
    raise exception 'draft journal entry not found';
  end if;
  if p_post and not has_perm('accounting.post') then raise exception 'permission denied: accounting.post' using errcode='42501'; end if;
  update journal_entries set entry_date = p_date, memo = p_memo where id = p_entry;
  delete from journal_lines where entry_id = p_entry;
  perform _journal_lines_insert(v_org, p_entry, p_lines);
  if p_post then perform _post_entry(p_entry); end if;
end $$;
