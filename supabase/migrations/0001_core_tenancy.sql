-- ════════════════════════════════════════════════════════════════════════
-- GDXora · 0001 — Core: multi-tenancy, roles & permissions, audit, events
-- ════════════════════════════════════════════════════════════════════════
-- Every business row carries org_id. Isolation is enforced by RLS in the
-- database, never by the UI: a bug in the front-end cannot leak one
-- company's data to another.
--
-- The active company for a request comes from the `x-org-id` HTTP header
-- (supabase-js global header, set by the org switcher). current_org_id()
-- only returns it when the caller is an active member of that org, so a
-- forged header yields NULL → every policy denies.
-- ════════════════════════════════════════════════════════════════════════

-- Supabase keeps extensions in their own schema; always call them qualified
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── organizations ───────────────────────────────────────────────────────
create table organizations (
  id            uuid primary key default gen_random_uuid(),
  name_ar       text not null,
  name_en       text,
  legal_name    text,
  vat_number    text,                         -- 15 digits, starts & ends with 3
  cr_number     text,                         -- commercial registration
  country       text not null default 'SA',
  currency      text not null default 'SAR',
  -- national address (required on ZATCA standard invoices)
  street        text,
  building_no   text,
  district      text,
  city          text,
  postal_code   text,
  plan          text not null default 'trial',
  status        text not null default 'active' check (status in ('active','suspended','closed')),
  settings      jsonb not null default '{}'::jsonb,   -- branding, locale, fiscal year start…
  created_at    timestamptz not null default now(),
  constraint org_vat_format check (vat_number is null or vat_number ~ '^3[0-9]{13}3$')
);

create table org_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role_key   text not null default 'viewer',
  is_owner   boolean not null default false,
  active     boolean not null default true,
  full_name  text,
  email      text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on org_members(user_id);

-- modules enabled per org (driven by the subscription plan)
create table org_modules (
  org_id     uuid not null references organizations(id) on delete cascade,
  module_key text not null check (module_key in ('accounting','sales','finance','projects','hr','payroll','integrations')),
  enabled    boolean not null default true,
  primary key (org_id, module_key)
);

-- ── permissions (global catalog) + per-org roles ───────────────────────
create table permissions (
  key      text primary key,
  module   text not null,
  name_ar  text not null,
  name_en  text not null
);

create table roles (
  org_id  uuid not null references organizations(id) on delete cascade,
  key     text not null,
  name_ar text not null,
  name_en text not null,
  primary key (org_id, key)
);

create table role_permissions (
  org_id   uuid not null,
  role_key text not null,
  perm_key text not null references permissions(key) on delete cascade,
  primary key (org_id, role_key, perm_key),
  foreign key (org_id, role_key) references roles(org_id, key) on delete cascade
);

insert into permissions (key, module, name_ar, name_en) values
  ('settings.manage',    'core',       'إدارة إعدادات الشركة',        'Manage company settings'),
  ('users.manage',       'core',       'إدارة المستخدمين والأدوار',   'Manage users & roles'),
  ('audit.view',         'core',       'عرض سجل التدقيق',             'View audit log'),
  ('accounting.view',    'accounting', 'عرض الحسابات والقيود',        'View accounts & journals'),
  ('accounting.manage',  'accounting', 'إنشاء القيود وتعديل الدليل',  'Create journals & edit CoA'),
  ('accounting.post',    'accounting', 'ترحيل وعكس القيود',           'Post & reverse journals'),
  ('accounting.close',   'accounting', 'إقفال الفترات المالية',       'Close fiscal periods'),
  ('sales.view',         'sales',      'عرض العملاء والفواتير',       'View customers & invoices'),
  ('sales.manage',       'sales',      'إنشاء العملاء والفواتير',     'Create customers & invoices'),
  ('sales.issue',        'sales',      'إصدار الفواتير الضريبية',     'Issue tax invoices'),
  ('finance.view',       'finance',    'عرض الموردين والمدفوعات',     'View vendors & payments'),
  ('finance.manage',     'finance',    'إنشاء فواتير الموردين والسندات','Create bills & vouchers'),
  ('finance.approve',    'finance',    'اعتماد وترحيل السندات',       'Approve & post vouchers'),
  ('projects.view',      'projects',   'عرض المشاريع',                'View projects'),
  ('projects.manage',    'projects',   'إدارة المشاريع والمستخلصات',  'Manage projects & progress billings'),
  ('hr.view',            'hr',         'عرض الموظفين',                'View employees'),
  ('hr.manage',          'hr',         'إدارة الموظفين والإجازات',    'Manage employees & leave'),
  ('payroll.view',       'payroll',    'عرض مسيّرات الرواتب',         'View payroll'),
  ('payroll.manage',     'payroll',    'إعداد مسيّرات الرواتب',       'Prepare payroll'),
  ('payroll.approve',    'payroll',    'اعتماد وترحيل الرواتب',       'Approve & post payroll'),
  ('integrations.manage','integrations','إدارة مفاتيح API والويبهوك', 'Manage API keys & webhooks');

-- ── request context helpers ─────────────────────────────────────────────
create or replace function request_org_header()
returns uuid language plpgsql stable as $$
declare v text;
begin
  v := nullif(current_setting('request.headers', true), '')::json ->> 'x-org-id';
  return v::uuid;
exception when others then
  return null;
end $$;

-- the org of the current request — NULL unless the caller is an active member
create or replace function current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select m.org_id
    from org_members m
   where m.org_id = request_org_header()
     and m.user_id = auth.uid()
     and m.active
$$;

create or replace function is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members
                  where org_id = p_org and user_id = auth.uid() and active)
$$;

create or replace function has_perm(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members m
     where m.org_id = current_org_id() and m.user_id = auth.uid() and m.active
       and (m.is_owner or exists (
             select 1 from role_permissions rp
              where rp.org_id = m.org_id and rp.role_key = m.role_key and rp.perm_key = p_perm)))
$$;

-- raise unless the caller holds the permission in the current org; returns the org id
create or replace function require_perm(p_perm text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_org uuid := current_org_id();
begin
  if v_org is null then
    raise exception 'no active organization' using errcode = '42501';
  end if;
  if not has_perm(p_perm) then
    raise exception 'permission denied: %', p_perm using errcode = '42501';
  end if;
  return v_org;
end $$;

-- ── document numbering (per org, per document type, gap-free) ──────────
create table doc_sequences (
  org_id     uuid not null references organizations(id) on delete cascade,
  doc_type   text not null,
  prefix     text not null,
  next_value bigint not null default 1,
  pad        int not null default 5,
  primary key (org_id, doc_type)
);

create or replace function next_doc_number(p_org uuid, p_type text)
returns text language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_n bigint; v_pad int;
begin
  insert into doc_sequences (org_id, doc_type, prefix)
  values (p_org, p_type, upper(p_type) || '-')
  on conflict do nothing;

  update doc_sequences set next_value = next_value + 1
   where org_id = p_org and doc_type = p_type
  returning prefix, next_value - 1, pad into v_prefix, v_n, v_pad;

  return v_prefix || lpad(v_n::text, v_pad, '0');
end $$;

-- ── audit log ───────────────────────────────────────────────────────────
create table audit_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  actor_id   uuid,
  actor_name text,
  at         timestamptz not null default now(),
  action     text not null,
  entity     text,
  entity_id  text,
  details    jsonb
);
create index on audit_log(org_id, at desc);

create or replace function log_audit(p_org uuid, p_action text, p_entity text, p_entity_id text, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (org_id, actor_id, actor_name, action, entity, entity_id, details)
  values (p_org, auth.uid(),
          (select full_name from org_members where org_id = p_org and user_id = auth.uid()),
          p_action, p_entity, p_entity_id, p_details)
$$;

-- ── domain events (transactional outbox) ────────────────────────────────
-- Every significant business action writes an event here in the same
-- transaction. Webhooks, connectors and future modules consume it, so
-- modules never call each other directly.
create table outbox (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  event_type  text not null,              -- e.g. invoice.issued, payroll.posted
  entity      text,
  entity_id   uuid,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index on outbox(org_id, created_at desc);

create or replace function emit_event(p_org uuid, p_type text, p_entity text, p_entity_id uuid, p_payload jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into outbox (org_id, event_type, entity, entity_id, payload)
  values (p_org, p_type, p_entity, p_entity_id, coalesce(p_payload, '{}'::jsonb))
$$;

-- ── generic triggers ────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- fill org_id from the request context on insert, and forbid moving a row
-- to another org on update
create or replace function enforce_org_id()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.org_id is null then new.org_id := current_org_id(); end if;
  elsif new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable';
  end if;
  return new;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table organizations    enable row level security;
alter table org_members      enable row level security;
alter table org_modules      enable row level security;
alter table permissions      enable row level security;
alter table roles            enable row level security;
alter table role_permissions enable row level security;
alter table doc_sequences    enable row level security;
alter table audit_log        enable row level security;
alter table outbox           enable row level security;

-- a user sees every org they belong to (needed for the org switcher)
create policy org_read on organizations for select to authenticated
  using (is_org_member(id));
create policy org_update on organizations for update to authenticated
  using (id = (select current_org_id()) and has_perm('settings.manage'));

create policy members_read on org_members for select to authenticated
  using (user_id = auth.uid() or org_id = (select current_org_id()));
create policy members_write on org_members for all to authenticated
  using (org_id = (select current_org_id()) and has_perm('users.manage'))
  with check (org_id = (select current_org_id()) and has_perm('users.manage'));

create policy modules_read on org_modules for select to authenticated
  using (org_id = (select current_org_id()));

create policy perms_read on permissions for select to authenticated using (true);

create policy roles_read on roles for select to authenticated
  using (org_id = (select current_org_id()));
create policy roles_write on roles for all to authenticated
  using (org_id = (select current_org_id()) and has_perm('users.manage'))
  with check (org_id = (select current_org_id()) and has_perm('users.manage'));

create policy role_perms_read on role_permissions for select to authenticated
  using (org_id = (select current_org_id()));
create policy role_perms_write on role_permissions for all to authenticated
  using (org_id = (select current_org_id()) and has_perm('users.manage'))
  with check (org_id = (select current_org_id()) and has_perm('users.manage'));

create policy seq_read on doc_sequences for select to authenticated
  using (org_id = (select current_org_id()));
create policy seq_write on doc_sequences for update to authenticated
  using (org_id = (select current_org_id()) and has_perm('settings.manage'));

create policy audit_read on audit_log for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('audit.view'));

create policy outbox_read on outbox for select to authenticated
  using (org_id = (select current_org_id()) and has_perm('integrations.manage'));

-- ── helper used by every module migration: standard org-scoped policies ─
-- read requires p_view, write requires p_manage.
create or replace function apply_org_policies(p_table text, p_view text, p_manage text)
returns void language plpgsql as $$
begin
  execute format('alter table %I enable row level security', p_table);
  execute format($p$create policy %1$s_read on %1$I for select to authenticated
                    using (org_id = (select current_org_id()) and has_perm(%2$L))$p$, p_table, p_view);
  execute format($p$create policy %1$s_ins on %1$I for insert to authenticated
                    with check (org_id = (select current_org_id()) and has_perm(%2$L))$p$, p_table, p_manage);
  execute format($p$create policy %1$s_upd on %1$I for update to authenticated
                    using (org_id = (select current_org_id()) and has_perm(%2$L))
                    with check (org_id = (select current_org_id()) and has_perm(%2$L))$p$, p_table, p_manage);
  execute format($p$create policy %1$s_del on %1$I for delete to authenticated
                    using (org_id = (select current_org_id()) and has_perm(%2$L))$p$, p_table, p_manage);
  execute format('create trigger %1$s_org before insert or update on %1$I
                  for each row execute function enforce_org_id()', p_table);
end $$;
