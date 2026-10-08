import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { Resource, RecordForm, validateRecord } from "../crud.jsx";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, StatusBadge, Modal, Tabs, go, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { num, today } from "../lib/format.js";

const projectFields = (t) => [
  { section: t("بيانات المشروع", "Project") },
  { key: "name_ar", label: t("اسم المشروع", "Project name"), required: true },
  { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
  { key: "customer_id", label: t("العميل (المالك)", "Customer (owner)"), type: "select", options: (lk) => lk.customers || [] },
  { key: "status", label: t("الحالة", "Status"), type: "select", options: [
    { id: "planned", label: t("مخطط", "Planned") }, { id: "active", label: t("نشط", "Active") }, { id: "on_hold", label: t("متوقف", "On hold") },
    { id: "completed", label: t("مكتمل", "Completed") }, { id: "closed", label: t("مغلق", "Closed") }] },
  { key: "manager_name", label: t("مدير المشروع", "Project manager") },
  { key: "location", label: t("الموقع", "Location") },
  { key: "start_date", label: t("تاريخ البدء", "Start"), type: "date" },
  { key: "end_date", label: t("تاريخ الانتهاء", "End"), type: "date", validate: (v, r) => (r.start_date && v < r.start_date ? t("تاريخ الانتهاء قبل تاريخ البدء", "End date is before the start date") : null) },
  { section: t("العقد", "Contract") },
  { key: "contract_no", label: t("رقم العقد", "Contract no."), ltr: true },
  { key: "contract_value", label: t("قيمة العقد (بدون ضريبة)", "Contract value (excl. VAT)"), type: "money", validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
  { key: "retention_pct", label: t("نسبة محتجزات الضمان %", "Retention %"), type: "number", validate: (v) => (Number(v) < 0 || Number(v) > 100 ? t("النسبة بين 0 و 100", "Percentage must be between 0 and 100") : null) },
  { key: "advance_amount", label: t("الدفعة المقدمة", "Advance payment"), type: "money", validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
  { key: "advance_recovery_pct", label: t("نسبة استرداد الدفعة من كل مستخلص %", "Advance recovery per billing %"), type: "number", validate: (v) => (Number(v) < 0 || Number(v) > 100 ? t("النسبة بين 0 و 100", "Percentage must be between 0 and 100") : null) },
  { key: "notes", label: t("ملاحظات", "Notes"), type: "textarea", wide: true },
];

export function Projects() {
  const { t } = useApp();
  return <Resource cfg={{
    table: "projects", title: t("المشاريع والعقود", "Projects & contracts"),
    sub: t("كل الإيرادات والتكاليف (فواتير، موردين، رواتب) تُحمّل على المشروع لتظهر ربحيته مباشرة", "Revenue and costs (invoices, bills, payroll) are tagged to projects for live profitability"),
    select: "*, customers(name_ar)", order: "created_at.desc", managePerm: "projects.manage",
    search: ["code", "name_ar", "contract_no"], onRow: (r) => go(`/projects/${r.id}`),
    loadLookups: async () => ({ customers: await L.customers() }),
    defaults: { status: "active", contract_value: 0, retention_pct: 10, advance_amount: 0, advance_recovery_pct: 0 },
    columns: [
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code}</span> },
      { key: "name_ar", label: t("المشروع", "Project") },
      { key: "c", label: t("العميل", "Customer"), render: (r) => r.customers?.name_ar || "—" },
      { key: "contract_value", label: t("قيمة العقد", "Contract value"), type: "money" },
      { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
    ],
    fields: projectFields(t),
  }} />;
}

export function ProjectDetail({ params }) {
  const { t, can } = useApp();
  const [tab, setTab] = useState("boq");
  const [edit, setEdit] = useState(null);
  const [boqEdit, setBoqEdit] = useState(null);
  const [act, busy] = useAction();
  const iss = useIssues();
  const d = useData(async () => {
    const [p, sum, boq, budget, billings, invoices, bills] = await Promise.all([
      run(supabase.from("projects").select("*, customers(name_ar)").eq("id", params.id).single()),
      rpc("project_summary", { p_project: params.id }),
      run(supabase.from("project_boq_items").select("*").eq("project_id", params.id).order("sort").order("item_no")),
      run(supabase.from("project_budget_lines").select("*").eq("project_id", params.id)),
      run(supabase.from("progress_billings").select("*, invoices(number, status)").eq("project_id", params.id).order("billing_no")),
      run(supabase.from("invoices").select("id, number, doc_type, status, issue_date, total, net_payable, amount_paid").eq("project_id", params.id).order("created_at", { ascending: false })),
      run(supabase.from("bills").select("id, number, vendor_ref, status, bill_date, total, vendors(name_ar)").eq("project_id", params.id).order("bill_date", { ascending: false })),
    ]);
    return { p, s: sum?.[0], boq, budget, billings, invoices, bills };
  }, [params.id]);
  const lk = useData(async () => ({ customers: await L.customers() }), []);

  if (!d.data) return <Loading />;
  const { p, s, boq, budget, billings, invoices, bills } = d.data;
  const boqTotal = boq.reduce((n, b) => n + Number(b.amount), 0);
  const billed = billings.filter((b) => b.status === "invoiced").reduce((n, b) => n + Number(b.current_gross), 0);
  const manage = can("projects.manage");

  async function saveProject(e) {
    e.preventDefault();
    if (!iss.check(validateRecord(projectFields(t), edit, t))) return;
    const rec = {}; for (const f of projectFields(t)) if (f.key) rec[f.key] = edit[f.key] ?? null;
    if (await act(async () => { await run(supabase.from("projects").update(rec).eq("id", p.id)); return true; }, t("تم الحفظ", "Saved"))) { setEdit(null); d.reload(); }
  }
  const boqFields = [
          { key: "item_no", label: t("رقم البند", "Item no.") }, { key: "description", label: t("الوصف", "Description"), required: true, wide: true },
          { key: "unit", label: t("الوحدة", "Unit") }, { key: "quantity", label: t("الكمية التعاقدية", "Contract qty"), type: "number", required: true },
          { key: "unit_price", label: t("سعر الوحدة", "Rate"), type: "money", required: true }, { key: "sort", label: t("الترتيب", "Order"), type: "number" }];
  async function saveBoq(e) {
    e.preventDefault();
    const out = validateRecord(boqFields, boqEdit, t);
    if (boqEdit.quantity !== null && boqEdit.quantity !== undefined && !(Number(boqEdit.quantity) > 0)) out.push({ key: "quantity", msg: t("الكمية التعاقدية يجب أن تكون أكبر من صفر", "Contract quantity must be above zero") });
    if (Number(boqEdit.unit_price) < 0) out.push({ key: "unit_price", msg: t("السعر لا يكون سالباً", "Rate cannot be negative") });
    if (!iss.check(out)) return;
    const rec = { project_id: p.id, item_no: boqEdit.item_no || null, description: boqEdit.description, unit: boqEdit.unit || null,
                  quantity: Number(boqEdit.quantity || 0), unit_price: Number(boqEdit.unit_price || 0), sort: Number(boqEdit.sort || 0) };
    const ok = await act(async () => {
      if (boqEdit.id) await run(supabase.from("project_boq_items").update(rec).eq("id", boqEdit.id));
      else await run(supabase.from("project_boq_items").insert(rec));
      return true;
    });
    if (ok) { setBoqEdit(null); d.reload(); }
  }
  async function newBilling() {
    const id = await act(() => rpc("prepare_progress_billing", { p_project: p.id, p_period_to: today() }));
    if (id) go(`/projects/${p.id}/billing/${id}`);
  }
  async function saveBudget(category, amount) {
    await act(async () => {
      const existing = budget.find((b) => b.category === category && !b.description);
      if (existing) await run(supabase.from("project_budget_lines").update({ amount: Number(amount || 0) }).eq("id", existing.id));
      else await run(supabase.from("project_budget_lines").insert({ project_id: p.id, category, amount: Number(amount || 0) }));
    });
    d.reload();
  }
  const cats = [["materials", t("مواد", "Materials")], ["labour", t("عمالة", "Labour")], ["subcontract", t("مقاولو باطن", "Subcontract")],
                ["equipment", t("معدات", "Equipment")], ["overhead", t("مصاريف غير مباشرة", "Overhead")], ["other", t("أخرى", "Other")]];

  return (
    <>
      <PageHead title={`${p.code} — ${p.name_ar}`} sub={<span className="row"><StatusBadge status={p.status} />{p.customers?.name_ar}</span>}>
        <button className="btn" onClick={() => go("/projects")}>{t("رجوع", "Back")}</button>
        {manage && <button className="btn" onClick={() => setEdit({ ...p })}>{t("تعديل", "Edit")}</button>}
        {manage && boq.length > 0 && <button className="btn primary" onClick={newBilling} disabled={busy}>{t("+ مستخلص جديد", "+ New progress billing")}</button>}
      </PageHead>
      <div className="grid k4" style={{ marginBottom: 16 }}>
        <div className="panel kpi"><div className="l">{t("قيمة العقد", "Contract value")}</div><div className="v"><Money v={p.contract_value} /></div>
          <div className="s">{t("المفوتر", "Billed")}: <Money v={billed} /> ({p.contract_value > 0 ? Math.round(billed / p.contract_value * 100) : 0}%)</div></div>
        <div className="panel kpi"><div className="l">{t("الإيرادات", "Revenue")}</div><div className="v"><Money v={s?.revenue} /></div></div>
        <div className="panel kpi"><div className="l">{t("التكاليف", "Costs")}</div><div className="v"><Money v={s?.cost} /></div>
          <div className="s">{t("الميزانية", "Budget")}: <Money v={s?.budget} /></div></div>
        <div className="panel kpi"><div className="l">{t("الربح", "Profit")}</div><div className="v"><Money v={s?.profit} /></div>
          <div className="s">{t("الهامش", "Margin")}: {s?.margin_pct ?? "—"}%</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[["boq", t("جدول الكميات", "BOQ")], ["billings", t("المستخلصات", "Progress billings")],
        ["budget", t("الميزانية", "Budget")], ["invoices", t("الفواتير", "Invoices")], ["bills", t("فواتير الموردين", "Vendor bills")]]} />

      {tab === "boq" && <Panel pad={false} title={t("جدول الكميات (BOQ)", "Bill of quantities")}
        actions={manage && <button className="btn sm" onClick={() => setBoqEdit({ quantity: 0, unit_price: 0 })}>{t("+ بند", "+ Item")}</button>}>
        <Table rows={boq} onRow={manage ? (r) => setBoqEdit({ ...r }) : undefined}
               empty={t("أضف بنود العقد لتتمكن من إعداد المستخلصات", "Add contract items to prepare progress billings")} columns={[
          { key: "item_no", label: t("البند", "Item") }, { key: "description", label: t("الوصف", "Description") }, { key: "unit", label: t("الوحدة", "Unit") },
          { key: "quantity", label: t("الكمية", "Qty"), type: "num" }, { key: "unit_price", label: t("سعر الوحدة", "Rate"), type: "money" },
          { key: "amount", label: t("القيمة", "Amount"), type: "money" }]}
          footer={<><td colSpan={5}>{t("الإجمالي", "Total")}</td><td className="n"><Money v={boqTotal} currency={null} /></td></>} />
      </Panel>}

      {tab === "billings" && <Panel pad={false}>
        <Table rows={billings} onRow={(r) => go(`/projects/${p.id}/billing/${r.id}`)} columns={[
          { key: "billing_no", label: t("رقم المستخلص", "No.") }, { key: "period_to", label: t("حتى تاريخ", "Period to"), type: "date" },
          { key: "current_gross", label: t("أعمال الفترة", "This period"), type: "money" },
          { key: "retention", label: t("المحتجزات", "Retention"), type: "money" },
          { key: "advance_recovery", label: t("استرداد الدفعة", "Advance recovery"), type: "money" },
          { key: "gross_to_date", label: t("الأعمال التراكمية", "To date"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <span className="row"><StatusBadge status={r.status} />{r.invoices?.number && <span className="mono">{r.invoices.number}</span>}</span> }]} />
      </Panel>}

      {tab === "budget" && <Panel pad={false} title={t("الميزانية التقديرية للتكاليف", "Cost budget")}>
        <table className="tbl edit"><thead><tr><th>{t("البند", "Category")}</th><th className="n">{t("المبلغ", "Amount")}</th></tr></thead>
          <tbody>{cats.map(([k, label]) => {
            const v = budget.filter((b) => b.category === k).reduce((n, b) => n + Number(b.amount), 0);
            return <tr key={k}><td>{label}</td><td className="n">{manage
              ? <input className="num" type="number" step="0.01" defaultValue={v || ""} style={{ maxWidth: 200 }} onBlur={(e) => Number(e.target.value || 0) !== v && saveBudget(k, e.target.value)} />
              : <Money v={v} currency={null} />}</td></tr>;
          })}</tbody>
          <tfoot><tr><td>{t("الإجمالي", "Total")}</td><td className="n"><Money v={s?.budget} currency={null} /></td></tr></tfoot></table>
      </Panel>}

      {tab === "invoices" && <Panel pad={false}><Table rows={invoices} onRow={(r) => go(`/sales/invoices/${r.id}`)} columns={[
        { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
        { key: "issue_date", label: t("التاريخ", "Date"), type: "date" }, { key: "total", label: t("الإجمالي", "Total"), type: "money" },
        { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> }]} /></Panel>}

      {tab === "bills" && <Panel pad={false}><Table rows={bills} onRow={(r) => go(`/finance/bills/${r.id}`)} columns={[
        { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
        { key: "v", label: t("المورد", "Vendor"), render: (r) => r.vendors?.name_ar }, { key: "bill_date", label: t("التاريخ", "Date"), type: "date" },
        { key: "total", label: t("الإجمالي", "Total"), type: "money" }, { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> }]} /></Panel>}

      {edit && <Modal wide title={t("تعديل المشروع", "Edit project")} onClose={() => { setEdit(null); iss.clear(); }}
        footer={<><button className="btn" onClick={() => setEdit(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="prj" disabled={busy}>{t("حفظ", "Save")}</button></>}>
        <form id="prj" onSubmit={saveProject} noValidate><Issues issues={iss.issues} /><RecordForm fields={projectFields(t)} value={edit} onChange={setEdit} lookups={lk.data} invalid={iss.has} /></form>
      </Modal>}
      {boqEdit && <Modal title={t("بند جدول الكميات", "BOQ item")} onClose={() => { setBoqEdit(null); iss.clear(); }}
        footer={<>
          {boqEdit.id && <button className="btn danger" disabled={busy} onClick={async () => {
            if (await act(async () => { await run(supabase.from("project_boq_items").delete().eq("id", boqEdit.id)); return true; })) { setBoqEdit(null); d.reload(); }
          }}>{t("حذف", "Delete")}</button>}<span style={{ flex: 1 }} />
          <button className="btn" onClick={() => setBoqEdit(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="boq" disabled={busy}>{t("حفظ", "Save")}</button></>}>
        <form id="boq" onSubmit={saveBoq} noValidate><Issues issues={iss.issues} /><RecordForm value={boqEdit} onChange={setBoqEdit} invalid={iss.has} fields={boqFields} /></form>
      </Modal>}
    </>
  );
}

export function ProgressBilling({ params }) {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const [qty, setQty] = useState({});
  const d = useData(async () => {
    const pb = await run(supabase.from("progress_billings").select("*, projects(code, name_ar, retention_pct, advance_recovery_pct)").eq("id", params.billingId).single());
    const lines = await run(supabase.from("progress_billing_lines").select("*, project_boq_items(item_no, description, unit, quantity, sort)").eq("billing_id", params.billingId));
    lines.sort((a, b) => (a.project_boq_items.sort - b.project_boq_items.sort) || String(a.project_boq_items.item_no).localeCompare(String(b.project_boq_items.item_no), undefined, { numeric: true }));
    return { pb, lines };
  }, [params.billingId]);
  if (!d.data) return <Loading />;
  const { pb, lines } = d.data;
  const draft = pb.status === "draft" && can("projects.manage");
  const cum = (l) => Number(qty[l.id] ?? l.cumulative_qty);
  const current = lines.reduce((n, l) => n + Math.round((cum(l) - Number(l.previous_qty)) * Number(l.unit_price) * 100) / 100, 0);
  const ret = Math.round(current * Number(pb.projects.retention_pct)) / 100;

  async function saveQty() {
    const changed = lines.filter((l) => qty[l.id] !== undefined && Number(qty[l.id]) !== Number(l.cumulative_qty));
    for (const l of changed) await run(supabase.from("progress_billing_lines").update({ cumulative_qty: Number(qty[l.id]) }).eq("id", l.id));
  }
  function problems(invoicing) {
    const out = [];
    for (const l of lines) {
      const b = l.project_boq_items, c = cum(l), name = `${b.item_no || ""} ${b.description}`.trim();
      if (Number.isNaN(c)) out.push({ key: l.id, msg: t(`«${name}»: أدخل رقماً صحيحاً`, `"${name}": enter a valid number`) });
      else if (c < Number(l.previous_qty)) out.push({ key: l.id, msg: t(`«${name}»: الكمية التراكمية (${c}) أقل من السابقة (${Number(l.previous_qty)})`, `"${name}": cumulative below previous`) });
      else if (c > Number(b.quantity)) out.push({ key: l.id, msg: t(`«${name}»: الكمية التراكمية (${c}) أكبر من كمية العقد (${Number(b.quantity)})`, `"${name}": cumulative exceeds contract quantity`) });
    }
    if (invoicing && !out.length && current <= 0) out.push(t("لا توجد أعمال جديدة في هذا المستخلص — ارفع الكمية التراكمية لبند واحد على الأقل", "No new work in this billing — raise the cumulative quantity of at least one item"));
    return out;
  }
  async function onSave() { if (!iss.check(problems(false))) return; if (await act(async () => { await saveQty(); return true; }, t("تم الحفظ", "Saved"))) { setQty({}); d.reload(); } }
  async function onInvoice() {
    if (!iss.check(problems(true))) return;
    if (!window.confirm(t("إنشاء فاتورة المستخلص؟ ستُحسب المحتجزات واسترداد الدفعة المقدمة تلقائياً.", "Create the billing invoice? Retention and advance recovery are applied automatically."))) return;
    const inv = await act(async () => { await saveQty(); return rpc("invoice_progress_billing", { p_billing: pb.id }); }, t("تم إنشاء مسودة الفاتورة", "Draft invoice created"));
    if (inv) go(`/sales/invoices/${inv}`);
  }
  async function onDelete() {
    if (!window.confirm(t("حذف المستخلص؟", "Delete billing?"))) return;
    if (await act(async () => { await run(supabase.from("progress_billings").delete().eq("id", pb.id)); return true; })) go(`/projects/${params.id}`);
  }

  return (
    <>
      <PageHead title={`${t("مستخلص رقم", "Progress billing #")} ${pb.billing_no} — ${pb.projects.name_ar}`} sub={<StatusBadge status={pb.status} />}>
        <button className="btn" onClick={() => go(`/projects/${params.id}`)}>{t("رجوع", "Back")}</button>
        {draft && <button className="btn danger" onClick={onDelete} disabled={busy}>{t("حذف", "Delete")}</button>}
        {draft && <button className="btn" onClick={onSave} disabled={busy}>{t("حفظ الكميات", "Save quantities")}</button>}
        {draft && <button className="btn primary" onClick={onInvoice} disabled={busy}>{t("إنشاء الفاتورة", "Create invoice")}</button>}
        {pb.invoice_id && <a className="btn primary" href={`#/sales/invoices/${pb.invoice_id}`}>{t("عرض الفاتورة", "View invoice")}</a>}
      </PageHead>
      <Issues issues={iss.issues} />
      <Panel pad={false}>
        <div className="tbl-wrap"><table className="tbl edit">
          <thead><tr><th>{t("البند", "Item")}</th><th>{t("الوصف", "Description")}</th><th>{t("الوحدة", "Unit")}</th><th className="n">{t("كمية العقد", "Contract")}</th>
            <th className="n">{t("السابق", "Previous")}</th><th className="n">{t("التراكمي", "Cumulative")}</th><th className="n">{t("الحالي", "Current")}</th>
            <th className="n">{t("السعر", "Rate")}</th><th className="n">{t("قيمة الفترة", "Amount")}</th></tr></thead>
          <tbody>{lines.map((l) => {
            const b = l.project_boq_items; const c = cum(l); const cur = c - Number(l.previous_qty);
            const over = c > Number(b.quantity); const under = c < Number(l.previous_qty);
            return <tr key={l.id} className={iss.has(l.id) ? "invalid" : ""}>
              <td>{b.item_no}</td><td>{b.description}</td><td>{b.unit}</td><td className="n">{Number(b.quantity)}</td><td className="n">{Number(l.previous_qty)}</td>
              <td className="n">{draft ? <input className="num" type="number" step="any" style={{ width: 110, borderColor: over || under ? "var(--bad)" : undefined }}
                value={qty[l.id] ?? l.cumulative_qty} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /> : Number(l.cumulative_qty)}</td>
              <td className="n">{Number(cur.toFixed(3))}</td><td className="n">{num(l.unit_price)}</td>
              <td className="n"><Money v={Math.round(cur * Number(l.unit_price) * 100) / 100} currency={null} /></td></tr>;
          })}</tbody>
          <tfoot><tr><td colSpan={8}>{t("أعمال الفترة", "Work this period")}</td><td className="n"><Money v={current} currency={null} /></td></tr></tfoot>
        </table></div>
        <div className="panel-body muted">
          {t("المحتجزات المتوقعة", "Expected retention")} ({pb.projects.retention_pct}%): <Money v={ret} /> ·
          {" "}{t("نسبة استرداد الدفعة المقدمة", "Advance recovery")}: {pb.projects.advance_recovery_pct}%
        </div>
      </Panel>
    </>
  );
}
