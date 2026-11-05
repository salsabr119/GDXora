-- GDXora · 0023 — Company letterhead (الورق الرسمي) for every printed document
-- Each company uploads its blank A4 letterhead (PDF or image; the browser turns
-- it into one A4 JPEG). Documents draw it behind every page and keep their
-- content inside the margins, so invoices, statements and quotations come out
-- under the company's own name and design.
-- Kept apart from organizations: the image is large and only documents need it.

create table org_letterhead (
  org_id     uuid primary key references organizations(id) on delete cascade,
  image_data text not null constraint org_letterhead_image check (image_data ~ '^data:image/(png|jpeg);base64,' and length(image_data) <= 3000000),
  top_mm     numeric(5,1) not null default 40 check (top_mm between 0 and 120),     -- space taken by the header
  bottom_mm  numeric(5,1) not null default 25 check (bottom_mm between 0 and 120),  -- space taken by the footer
  side_mm    numeric(5,1) not null default 15 check (side_mm between 5 and 50),
  updated_at timestamptz not null default now()
);

alter table org_letterhead enable row level security;
-- every member prints documents; only company settings change the letterhead
create policy org_letterhead_read on org_letterhead for select to authenticated
  using (org_id = (select current_org_id()));
create policy org_letterhead_write on org_letterhead for all to authenticated
  using (org_id = (select current_org_id()) and has_perm('settings.manage'))
  with check (org_id = (select current_org_id()) and has_perm('settings.manage'));
create trigger org_letterhead_org before insert or update on org_letterhead for each row execute function enforce_org_id();
create trigger org_letterhead_upd_at before update on org_letterhead for each row execute function set_updated_at();
