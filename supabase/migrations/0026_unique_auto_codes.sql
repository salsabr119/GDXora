-- GDXora · 0026 — Automatic codes never collide with codes typed by hand
-- Customers, vendors, projects, items and employees get the next number from
-- their sequence when no code is given. A code entered by hand or imported
-- from Excel (e.g. PRJ-00003) could later be handed out again by the sequence,
-- and the insert then failed with a duplicate-key error the user could not
-- trace to any field. The generator now skips numbers that are already taken.

create or replace function assign_party_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_taken boolean; i int := 0;
begin
  if new.code is null or new.code = '' then
    loop
      new.code := next_doc_number(new.org_id, tg_argv[0]);
      execute format('select exists (select 1 from %I where org_id = $1 and code = $2)', tg_table_name)
        into v_taken using new.org_id, new.code;
      exit when not v_taken;
      i := i + 1;
      if i > 10000 then raise exception 'could not find a free % code', tg_argv[0]; end if;
    end loop;
  end if;
  return new;
end $$;
