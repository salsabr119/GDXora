import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { RecordForm } from "../crud.jsx";
import { useApp, useData, useAction, PageHead, Panel, Table, Badge, Modal, Tabs, Field, DateText, Loading } from "../ui.jsx";
import { isVatNumber, isSaIban } from "../lib/format.js";
import { imageFileToDataUrl } from "../lib/pdf.js";

/* ── company ─────────────────────────────────────────────────────────── */
export function Company() {
  const { t, org, refreshOrg } = useApp();
  const [act, busy] = useAction();
  const [f, setF] = useState({ ...org });
  const zs = useData(() => run(supabase.from("zatca_state").select("*").maybeSingle()), []);
  const fields = [
    { section: t("الهوية", "Identity") },
    { key: "name_ar", label: t("الاسم التجاري (عربي)", "Trade name (Arabic)"), required: true },
    { key: "name_en", label: t("الاسم التجاري (إنجليزي)", "Trade name (English)"), ltr: true },
    { key: "legal_name", label: t("الاسم القانوني (يظهر على الفاتورة)", "Legal name (printed on invoices)"), wide: true },
    { key: "vat_number", label: t("الرقم الضريبي", "VAT number"), ltr: true, hint: f.vat_number && !isVatNumber(f.vat_number) ? t("15 رقماً يبدأ وينتهي بـ 3", "15 digits, starts & ends with 3") : null },
    { key: "cr_number", label: t("السجل التجاري", "Commercial registration"), ltr: true },
    { section: t("العنوان الوطني (إلزامي للفوترة الإلكترونية)", "National address (required for e-invoicing)") },
    { key: "street", label: t("الشارع", "Street") }, { key: "building_no", label: t("رقم المبنى", "Building no."), ltr: true },
    { key: "district", label: t("الحي", "District") }, { key: "city", label: t("المدينة", "City") },
    { key: "postal_code", label: t("الرمز البريدي", "Postal code"), ltr: true },
    { section: t("التواصل والبنك (تظهر على الفواتير)", "Contact & bank (printed on invoices)") },
    { key: "phone", label: t("الهاتف", "Phone"), ltr: true }, { key: "email", label: t("البريد الإلكتروني", "E-mail"), type: "email", ltr: true },
    { key: "website", label: t("الموقع الإلكتروني", "Website"), ltr: true },
    { key: "bank_name", label: t("البنك", "Bank") },
    { key: "iban", label: t("الآيبان", "IBAN"), ltr: true, transform: (v) => (v || "").replace(/\s/g, "").toUpperCase() || null,
      hint: f.iban && !isSaIban(f.iban) ? t("SA متبوعاً بـ 22 رقماً", "SA followed by 22 digits") : null },
    { key: "invoice_footer", label: t("عبارة أسفل الفاتورة", "Invoice footer note"), wide: true, placeholder: t("مثال: شكراً لتعاملكم معنا", "e.g. Thank you for your business") },
  ];
  async function onLogo(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const data = await act(() => imageFileToDataUrl(file, 512));
    if (data) setF((x) => ({ ...x, logo_data: data }));
  }
  async function save(e) {
    e.preventDefault();
    const rec = { logo_data: f.logo_data ?? null }; for (const x of fields) if (x.key) rec[x.key] = f[x.key] ?? null;
    if (await act(async () => { await run(supabase.from("organizations").update(rec).eq("id", org.id)); return true; }, t("تم الحفظ", "Saved"))) refreshOrg();
  }
  return (
    <>
      <PageHead title={t("بيانات الشركة", "Company")}><button className="btn primary" form="org" disabled={busy}>{t("حفظ", "Save")}</button></PageHead>
      <Panel title={t("شعار الشركة", "Company logo")}>
        <div className="row" style={{ gap: 16 }}>
          <div style={{ width: 96, height: 96, border: "1px dashed var(--line)", borderRadius: 10, display: "grid", placeItems: "center", background: "#fff" }}>
            {f.logo_data ? <img src={f.logo_data} alt="" style={{ maxWidth: 88, maxHeight: 88, objectFit: "contain" }} /> : <span className="muted" style={{ fontSize: 12 }}>{t("بدون شعار", "No logo")}</span>}
          </div>
          <div className="grid" style={{ gap: 8 }}>
            <label className="btn">{t("اختيار صورة…", "Choose image…")}<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onLogo} /></label>
            {f.logo_data && <button type="button" className="btn ghost sm" onClick={() => setF({ ...f, logo_data: null })}>{t("إزالة الشعار", "Remove logo")}</button>}
            <span className="muted" style={{ fontSize: 12 }}>{t("يظهر على الفواتير وملفات PDF. يُفضّل PNG بخلفية شفافة. اضغط «حفظ» بعد الاختيار.", "Shown on invoices and PDFs. A transparent PNG works best. Press Save afterwards.")}</span>
          </div>
        </div>
      </Panel>
      <Panel><form id="org" onSubmit={save}><RecordForm fields={fields} value={f} onChange={setF} /></form></Panel>
      <Panel title={t("الفوترة الإلكترونية (ZATCA)", "E-invoicing (ZATCA)")}>
        <div className="grid" style={{ gap: 6 }}>
          <div>{t("البيئة", "Environment")}: <Badge kind="info">{zs.data?.environment || "sandbox"}</Badge></div>
          <div>{t("آخر عداد فواتير (ICV)", "Last invoice counter (ICV)")}: <span className="mono">{zs.data?.last_icv ?? 0}</span></div>
          <div>{t("المرحلة الأولى (الإصدار): مفعّلة — XML + بصمة + QR لكل فاتورة.", "Phase 1 (generation): active — XML + hash + QR per invoice.")}</div>
          <div className="muted">{t("المرحلة الثانية (الربط والتكامل): تتطلب تسجيل الجهاز لدى بوابة فاتورة والحصول على شهادة CSID — راجع docs/ZATCA.md.",
            "Phase 2 (integration): requires onboarding with the Fatoora portal to obtain a CSID — see docs/ZATCA.md.")}</div>
        </div>
      </Panel>
    </>
  );
}

/* ── users & roles ───────────────────────────────────────────────────── */
export function Users() {
  const { t, lang } = useApp();
  const [tab, setTab] = useState("members");
  const [act, busy] = useAction();
  const [add, setAdd] = useState(null);
  const [role, setRole] = useState("accountant");
  const d = useData(async () => ({
    members: await run(supabase.from("org_members").select("*").order("created_at")),
    roles: await run(supabase.from("roles").select("*").order("key")),
    perms: await run(supabase.from("permissions").select("*").order("module").order("key")),
    rp: await run(supabase.from("role_permissions").select("role_key, perm_key")),
  }), []);
  if (!d.data) return <Loading />;
  const { members, roles, perms, rp } = d.data;
  const roleOpts = roles.map((r) => ({ id: r.key, label: lang === "en" ? r.name_en : r.name_ar }));
  const has = new Set(rp.filter((x) => x.role_key === role).map((x) => x.perm_key));

  async function toggle(perm) {
    await act(async () => {
      if (has.has(perm)) await run(supabase.from("role_permissions").delete().eq("role_key", role).eq("perm_key", perm));
      else await run(supabase.from("role_permissions").insert({ role_key: role, perm_key: perm, org_id: members[0].org_id }));
    });
    d.reload();
  }
  async function updateMember(m, patch) {
    if (await act(async () => { await run(supabase.from("org_members").update(patch).eq("user_id", m.user_id)); return true; }, t("تم التحديث", "Updated"))) d.reload();
  }
  async function addMember(e) {
    e.preventDefault();
    if (await act(() => rpc("add_member", { p_email: add.email, p_role: add.role_key, p_full_name: add.full_name || null }), t("تمت إضافة المستخدم", "User added"))) { setAdd(null); d.reload(); }
  }

  return (
    <>
      <PageHead title={t("المستخدمون والصلاحيات", "Users & roles")}>
        {tab === "members" && <button className="btn primary" onClick={() => setAdd({ role_key: "accountant" })}>{t("+ إضافة مستخدم", "+ Add user")}</button>}
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[["members", t("المستخدمون", "Users")], ["roles", t("صلاحيات الأدوار", "Role permissions")]]} />
      {tab === "members" && <Panel pad={false}>
        <Table rows={members} columns={[
          { key: "full_name", label: t("الاسم", "Name"), render: (m) => <>{m.full_name || "—"} {m.is_owner && <Badge kind="info">{t("المالك", "Owner")}</Badge>}</> },
          { key: "email", label: t("البريد", "E-mail"), render: (m) => <span className="mono">{m.email || "—"}</span> },
          { key: "role_key", label: t("الدور", "Role"), render: (m) => m.is_owner ? t("كل الصلاحيات", "All permissions")
              : <select value={m.role_key} style={{ width: 180 }} disabled={busy} onChange={(e) => updateMember(m, { role_key: e.target.value })}>
                  {roleOpts.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select> },
          { key: "active", label: t("الحالة", "Status"), render: (m) => m.is_owner ? <Badge kind="ok">{t("نشط", "Active")}</Badge>
              : <button className={`btn sm ${m.active ? "" : "danger"}`} disabled={busy} onClick={() => updateMember(m, { active: !m.active })}>{m.active ? t("نشط — إيقاف", "Active — disable") : t("موقوف — تفعيل", "Disabled — enable")}</button> },
        ]} />
      </Panel>}
      {tab === "roles" && <Panel title={<select value={role} style={{ width: 220 }} onChange={(e) => setRole(e.target.value)}>{roleOpts.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>} pad={false}>
        <table className="tbl"><tbody>{perms.map((p) => (
          <tr key={p.key}><td style={{ width: 40 }}><input type="checkbox" checked={has.has(p.key)} disabled={busy} onChange={() => toggle(p.key)} /></td>
            <td>{lang === "en" ? p.name_en : p.name_ar}</td><td className="muted mono">{p.key}</td></tr>))}</tbody></table>
      </Panel>}
      {add && <Modal title={t("إضافة مستخدم", "Add user")} onClose={() => setAdd(null)}
        footer={<><button className="btn" onClick={() => setAdd(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="mem" disabled={busy}>{t("إضافة", "Add")}</button></>}>
        <form id="mem" onSubmit={addMember}>
          <div className="alert">{t("يجب أن يكون لدى المستخدم حساب في GDXora (يسجّل من صفحة الدخول) ثم تضيفه هنا ببريده.", "The user signs up on the login page first, then you add them here by e-mail.")}</div>
          <RecordForm value={add} onChange={setAdd} fields={[
            { key: "email", label: t("البريد الإلكتروني", "E-mail"), type: "email", required: true, ltr: true },
            { key: "full_name", label: t("الاسم", "Name") },
            { key: "role_key", label: t("الدور", "Role"), type: "select", required: true, options: roleOpts }]} />
        </form>
      </Modal>}
    </>
  );
}

/* ── integrations: API keys + webhooks ───────────────────────────────── */
const SCOPES = ["customers:read", "customers:write", "invoices:read", "invoices:write", "accounts:read", "reports:read",
                "projects:read", "vendors:read", "employees:read"];
const EVENTS = ["*", "invoice.*", "invoice.issued", "bill.posted", "payment.*", "payment.received", "payment.made", "payroll.posted", "organization.created"];

export function Integrations() {
  const { t } = useApp();
  const [tab, setTab] = useState("keys");
  const [act, busy] = useAction();
  const [newKey, setNewKey] = useState(null);
  const [plain, setPlain] = useState(null);
  const [hook, setHook] = useState(null);
  const keys = useData(() => run(supabase.from("api_keys").select("id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at").order("created_at", { ascending: false })), []);
  const hooks = useData(() => run(supabase.from("webhooks").select("*").order("created_at", { ascending: false })), []);
  const deliveries = useData(() => run(supabase.from("webhook_deliveries").select("*, outbox(event_type, entity)").order("id", { ascending: false }).limit(100)), []);

  async function createKey(e) {
    e.preventDefault();
    const k = await act(() => rpc("create_api_key", { p_name: newKey.name, p_scopes: newKey.scopes, p_expires_at: newKey.expires_at || null }));
    if (k) { setNewKey(null); setPlain(k); keys.reload(); }
  }
  async function saveHook(e) {
    e.preventDefault();
    const rec = { url: hook.url, events: hook.events, description: hook.description || null, active: hook.active ?? true };
    const ok = await act(async () => {
      if (hook.id) await run(supabase.from("webhooks").update(rec).eq("id", hook.id)); else await run(supabase.from("webhooks").insert(rec));
      return true;
    }, t("تم الحفظ", "Saved"));
    if (ok) { setHook(null); hooks.reload(); }
  }
  const Check = ({ list, value, onChange }) => (
    <div className="row" style={{ gap: 12 }}>{list.map((s) => (
      <label key={s} className="row mono" style={{ gap: 4 }}><input type="checkbox" checked={value.includes(s)}
        onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))} />{s}</label>))}</div>
  );
  const base = `${window.location.origin}/api/v1`;

  return (
    <>
      <PageHead title={t("الربط والتكامل", "Integrations")} sub={t("اربط GDXora بأنظمتك: واجهة REST بمفاتيح API، وإشعارات فورية (Webhooks) عند كل حدث", "Connect GDXora to other systems: REST API with keys, and real-time webhooks on every event")}>
        {tab === "keys" && <button className="btn primary" onClick={() => setNewKey({ name: "", scopes: ["invoices:read"] })}>{t("+ مفتاح API", "+ API key")}</button>}
        {tab === "hooks" && <button className="btn primary" onClick={() => setHook({ url: "https://", events: ["invoice.*"], active: true })}>{t("+ Webhook", "+ Webhook")}</button>}
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[["keys", t("مفاتيح API", "API keys")], ["hooks", "Webhooks"], ["log", t("سجل الإرسال", "Delivery log")], ["docs", t("دليل المطوّر", "Developer guide")]]} />
      {tab === "keys" && <Panel pad={false}><Table rows={keys.data} loading={keys.loading} columns={[
        { key: "name", label: t("الاسم", "Name") }, { key: "prefix", label: t("المعرّف", "Prefix"), render: (k) => <span className="mono">gdx_{k.prefix}_…</span> },
        { key: "scopes", label: t("الصلاحيات", "Scopes"), render: (k) => <span className="mono" style={{ fontSize: 11 }}>{k.scopes.join(", ")}</span> },
        { key: "last_used_at", label: t("آخر استخدام", "Last used"), render: (k) => k.last_used_at ? <DateText v={k.last_used_at} /> : "—" },
        { key: "s", label: "", render: (k) => k.revoked_at ? <Badge kind="bad">{t("ملغى", "Revoked")}</Badge>
            : <button className="btn sm danger" disabled={busy} onClick={async () => { if (window.confirm(t("إلغاء المفتاح نهائياً؟", "Revoke this key?")) && await act(() => rpc("revoke_api_key", { p_id: k.id }))) keys.reload(); else keys.reload(); }}>{t("إلغاء", "Revoke")}</button> }]} /></Panel>}
      {tab === "hooks" && <Panel pad={false}><Table rows={hooks.data} loading={hooks.loading} onRow={(h) => setHook({ ...h })} columns={[
        { key: "url", label: "URL", render: (h) => <span className="mono">{h.url}</span> },
        { key: "events", label: t("الأحداث", "Events"), render: (h) => <span className="mono" style={{ fontSize: 11 }}>{h.events.join(", ")}</span> },
        { key: "active", label: "", render: (h) => h.active ? <Badge kind="ok">{t("مفعّل", "Active")}</Badge> : <Badge>{t("موقوف", "Paused")}</Badge> }]} /></Panel>}
      {tab === "log" && <Panel pad={false}><Table rows={deliveries.data} loading={deliveries.loading} columns={[
        { key: "id", label: "#" }, { key: "e", label: t("الحدث", "Event"), render: (x) => <span className="mono">{x.outbox?.event_type}</span> },
        { key: "status", label: t("الحالة", "Status"), render: (x) => <Badge kind={x.status === "success" ? "ok" : x.status === "failed" ? "bad" : "warn"}>{x.status}</Badge> },
        { key: "attempts", label: t("المحاولات", "Attempts"), type: "num" }, { key: "response_status", label: "HTTP" },
        { key: "last_error", label: t("الخطأ", "Error"), render: (x) => <span className="muted" style={{ fontSize: 12 }}>{x.last_error || ""}</span> }]} /></Panel>}
      {tab === "docs" && <Panel>
        <div className="grid" style={{ gap: 10, lineHeight: 1.8 }}>
          <div>{t("العنوان الأساسي", "Base URL")}: <span className="mono">{base}</span></div>
          <div>{t("المصادقة", "Auth")}: <span className="mono">Authorization: Bearer gdx_xxxxxxxxxxxx_…</span></div>
          <pre className="mono" style={{ background: "var(--soft)", padding: 12, borderRadius: 8, overflowX: "auto", direction: "ltr", textAlign: "left" }}>{`GET  ${base}/invoices?from=2026-01-01&status=issued
GET  ${base}/invoices/{id}
POST ${base}/invoices            {"invoice_kind":"simplified","lines":[{"description":"...","quantity":1,"unit_price":100}]}
POST ${base}/invoices/{id}/issue
GET  ${base}/customers           POST ${base}/customers
GET  ${base}/accounts            GET  ${base}/reports/trial-balance?from=&to=
GET  ${base}/projects            GET  ${base}/vendors      GET ${base}/employees

Webhook headers:
  X-GDXora-Event: invoice.issued
  X-GDXora-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`}</pre>
          <div className="muted">{t("المواصفات الكاملة (OpenAPI):", "Full spec (OpenAPI):")} <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="mono">/api/v1/openapi.json</a></div>
        </div>
      </Panel>}

      {newKey && <Modal title={t("مفتاح API جديد", "New API key")} onClose={() => setNewKey(null)}
        footer={<><button className="btn" onClick={() => setNewKey(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="key" disabled={busy || !newKey.scopes.length}>{t("إنشاء", "Create")}</button></>}>
        <form id="key" onSubmit={createKey} className="grid" style={{ gap: 12 }}>
          <Field label={t("الاسم (مثال: Power BI)", "Name (e.g. Power BI)")} required><input required value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} /></Field>
          <Field label={t("الصلاحيات", "Scopes")}><Check list={SCOPES} value={newKey.scopes} onChange={(v) => setNewKey({ ...newKey, scopes: v })} /></Field>
          <Field label={t("تاريخ الانتهاء (اختياري)", "Expires (optional)")}><input type="date" value={newKey.expires_at || ""} onChange={(e) => setNewKey({ ...newKey, expires_at: e.target.value })} /></Field>
        </form>
      </Modal>}
      {plain && <Modal title={t("انسخ المفتاح الآن", "Copy your key now")} onClose={() => setPlain(null)}
        footer={<button className="btn primary" onClick={() => { navigator.clipboard?.writeText(plain); setPlain(null); }}>{t("نسخ وإغلاق", "Copy & close")}</button>}>
        <div className="alert warn">{t("لن يظهر هذا المفتاح مرة أخرى. احفظه في مكان آمن.", "This key will not be shown again. Store it securely.")}</div>
        <div className="mono" style={{ wordBreak: "break-all", background: "var(--soft)", padding: 12, borderRadius: 8 }}>{plain}</div>
      </Modal>}
      {hook && <Modal title="Webhook" onClose={() => setHook(null)}
        footer={<>
          {hook.id && <button className="btn danger" disabled={busy} onClick={async () => { if (await act(async () => { await run(supabase.from("webhooks").delete().eq("id", hook.id)); return true; })) { setHook(null); hooks.reload(); } }}>{t("حذف", "Delete")}</button>}
          <span style={{ flex: 1 }} /><button className="btn" onClick={() => setHook(null)}>{t("إلغاء", "Cancel")}</button>
          <button className="btn primary" form="hook" disabled={busy || !hook.events.length}>{t("حفظ", "Save")}</button></>}>
        <form id="hook" onSubmit={saveHook} className="grid" style={{ gap: 12 }}>
          <Field label="URL (https)" required><input dir="ltr" required pattern="https://.+" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} /></Field>
          <Field label={t("الأحداث", "Events")}><Check list={EVENTS} value={hook.events} onChange={(v) => setHook({ ...hook, events: v })} /></Field>
          <Field label={t("وصف", "Description")}><input value={hook.description || ""} onChange={(e) => setHook({ ...hook, description: e.target.value })} /></Field>
          <label className="row"><input type="checkbox" checked={hook.active ?? true} onChange={(e) => setHook({ ...hook, active: e.target.checked })} />{t("مفعّل", "Active")}</label>
          {hook.secret && <Field label={t("مفتاح التوقيع (للتحقق من X-GDXora-Signature)", "Signing secret (verify X-GDXora-Signature)")}><div className="mono" style={{ wordBreak: "break-all" }}>{hook.secret}</div></Field>}
        </form>
      </Modal>}
    </>
  );
}

/* ── audit log ───────────────────────────────────────────────────────── */
export function Audit() {
  const { t } = useApp();
  const list = useData(() => run(supabase.from("audit_log").select("*").order("at", { ascending: false }).limit(500)), []);
  return (
    <>
      <PageHead title={t("سجل التدقيق", "Audit log")} sub={t("كل عملية حساسة تُسجّل: من، متى، ماذا", "Every sensitive action is logged: who, when, what")} />
      <Panel pad={false}><Table rows={list.data} loading={list.loading} columns={[
        { key: "at", label: t("الوقت", "Time"), render: (r) => <span className="mono">{new Date(r.at).toLocaleString("en-GB")}</span> },
        { key: "actor_name", label: t("المستخدم", "User"), render: (r) => r.actor_name || t("النظام / API", "System / API") },
        { key: "action", label: t("العملية", "Action"), render: (r) => <span className="mono">{r.action}</span> },
        { key: "entity", label: t("الكيان", "Entity") },
        { key: "details", label: t("التفاصيل", "Details"), render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.details ? JSON.stringify(r.details) : ""}</span> },
      ]} /></Panel>
    </>
  );
}
