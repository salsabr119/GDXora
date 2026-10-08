import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { supabase, rpc, run } from "../supabase.js";
import { Resource } from "../crud.jsx";
import { useApp, useData, useAction, PageHead, Panel, Table, Money, DateText, StatusBadge, Field, Badge, Select, go, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { processInvoice } from "../lib/zatca/index.js";
import { today, num, isVatNumber } from "../lib/format.js";
import { InvoiceDocument, A4Viewer, docTitle } from "./InvoiceDocument.jsx";
import { nodeToPdf, downloadBlob, shareOrDownload } from "../lib/pdf.js";

/* ── customers ───────────────────────────────────────────────────────── */
export function Customers() {
  const { t } = useApp();
  return <Resource cfg={{
    table: "customers", title: t("العملاء", "Customers"), order: "name_ar.asc", managePerm: "sales.manage",
    search: ["code", "name_ar", "name_en", "vat_number", "phone"],
    defaults: { customer_type: "business", country: "SA", payment_terms_days: 30, active: true },
    columns: [
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code}</span> },
      { key: "name_ar", label: t("الاسم", "Name") },
      { key: "vat_number", label: t("الرقم الضريبي", "VAT no."), render: (r) => <span className="mono">{r.vat_number || "—"}</span> },
      { key: "city", label: t("المدينة", "City") },
      { key: "phone", label: t("الجوال", "Phone"), render: (r) => <span className="mono">{r.phone || "—"}</span> },
      { key: "active", label: "", render: (r) => !r.active && <Badge kind="bad">{t("موقوف", "Inactive")}</Badge> },
    ],
    fields: [
      { section: t("البيانات الأساسية", "Basics") },
      { key: "name_ar", label: t("الاسم (عربي)", "Name (Arabic)"), required: true },
      { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
      { key: "customer_type", label: t("النوع", "Type"), type: "select", options: [
        { id: "business", label: t("منشأة", "Business") }, { id: "government", label: t("جهة حكومية", "Government") },
        { id: "individual", label: t("فرد", "Individual") }] },
      { key: "vat_number", label: t("الرقم الضريبي", "VAT number"), ltr: true, hint: t("إلزامي للفواتير الضريبية للمنشآت", "Required on B2B tax invoices") },
      { key: "cr_number", label: t("السجل التجاري", "CR number"), ltr: true },
      { key: "phone", label: t("الجوال", "Phone"), type: "tel", ltr: true },
      { key: "email", label: t("البريد", "E-mail"), type: "email", ltr: true },
      { section: t("العنوان الوطني (إلزامي للفاتورة الضريبية)", "National address (required on tax invoices)") },
      { key: "street", label: t("الشارع", "Street") },
      { key: "building_no", label: t("رقم المبنى", "Building no."), ltr: true },
      { key: "district", label: t("الحي", "District") },
      { key: "city", label: t("المدينة", "City") },
      { key: "postal_code", label: t("الرمز البريدي", "Postal code"), ltr: true },
      { key: "country", label: t("الدولة", "Country"), ltr: true },
      { section: t("الائتمان", "Credit") },
      { key: "payment_terms_days", label: t("مدة السداد (يوم)", "Payment terms (days)"), type: "number" },
      { key: "credit_limit", label: t("حد الائتمان", "Credit limit"), type: "money" },
      { key: "active", label: t("نشط", "Active"), type: "checkbox" },
      { key: "notes", label: t("ملاحظات", "Notes"), type: "textarea", wide: true },
    ],
  }} />;
}

/* ── items / services ────────────────────────────────────────────────── */
export function Items() {
  const { t } = useApp();
  return <Resource cfg={{
    table: "items", title: t("الخدمات والأصناف", "Services & items"), order: "name_ar.asc", managePerm: "sales.manage",
    loadLookups: async () => ({ tax: await L.taxCodes(), rev: (await L.accounts()).filter((a) => a.type === "revenue") }),
    defaults: { kind: "service", unit: "وحدة", unit_price: 0, active: true },
    columns: [
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code}</span> },
      { key: "name_ar", label: t("الاسم", "Name") },
      { key: "unit", label: t("الوحدة", "Unit") },
      { key: "unit_price", label: t("السعر", "Price"), type: "money" },
    ],
    fields: [
      { key: "name_ar", label: t("الاسم (عربي)", "Name (Arabic)"), required: true },
      { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
      { key: "kind", label: t("النوع", "Kind"), type: "select", options: [{ id: "service", label: t("خدمة", "Service") }, { id: "goods", label: t("سلعة", "Goods") }] },
      { key: "unit", label: t("الوحدة", "Unit") },
      { key: "unit_price", label: t("سعر الوحدة", "Unit price"), type: "money" },
      { key: "tax_code_id", label: t("رمز الضريبة", "Tax code"), type: "select", options: (lk) => lk.tax || [] },
      { key: "revenue_account_id", label: t("حساب الإيراد", "Revenue account"), type: "select", options: (lk) => lk.rev || [] },
      { key: "active", label: t("نشط", "Active"), type: "checkbox" },
    ],
  }} />;
}

/* ── invoices list ───────────────────────────────────────────────────── */
export function payState(inv) {
  if (inv.status !== "issued" || inv.doc_type === "credit_note") return null;
  const bal = Number(inv.net_payable) - Number(inv.amount_paid);
  return bal <= 0.004 ? "paid" : Number(inv.amount_paid) > 0 ? "partial" : "unpaid";
}
const DOC = (t) => ({ invoice: t("فاتورة", "Invoice"), credit_note: t("إشعار دائن", "Credit note"), debit_note: t("إشعار مدين", "Debit note") });

export function Invoices() {
  const { t, can } = useApp();
  const [filter, setFilter] = useState("");
  const list = useData(() => {
    let q = supabase.from("invoices").select("id, number, doc_type, invoice_kind, status, issue_date, total, net_payable, amount_paid, zatca_status, zatca_hash, customers(name_ar), projects(name_ar)")
      .order("created_at", { ascending: false }).limit(500);
    if (filter === "draft") q = q.eq("status", "draft");
    if (filter === "issued") q = q.eq("status", "issued");
    return run(q);
  }, [filter]);
  const doc = DOC(t);
  return (
    <>
      <PageHead title={t("الفواتير الضريبية", "Tax invoices")} sub={t("متوافقة مع متطلبات هيئة الزكاة والضريبة والجمارك (فاتورة)", "ZATCA (Fatoora) compliant")}>
        <select style={{ width: 150 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">{t("الكل", "All")}</option><option value="draft">{t("مسودات", "Drafts")}</option><option value="issued">{t("مُصدرة", "Issued")}</option>
        </select>
        {can("sales.manage") && <button className="btn primary" onClick={() => go("/sales/invoices/new")}>{t("+ فاتورة", "+ Invoice")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => go(`/sales/invoices/${r.id}`)} columns={[
          { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
          { key: "doc_type", label: t("النوع", "Type"), render: (r) => <>{doc[r.doc_type]} <span className="muted">· {r.invoice_kind === "standard" ? "B2B" : "B2C"}</span></> },
          { key: "issue_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "c", label: t("العميل", "Customer"), render: (r) => r.customers?.name_ar || t("عميل نقدي", "Cash customer") },
          { key: "p", label: t("المشروع", "Project"), render: (r) => r.projects?.name_ar || "—" },
          { key: "total", label: t("الإجمالي", "Total"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <span className="row"><StatusBadge status={r.status} />{payState(r) && <StatusBadge status={payState(r)} />}
            {r.status === "issued" && !r.zatca_hash && <Badge kind="bad">{t("ZATCA معلّقة", "ZATCA pending")}</Badge>}</span> },
        ]} />
      </Panel>
    </>
  );
}

/* ── invoice editor / viewer ─────────────────────────────────────────── */
const blank = (tax) => ({ item_id: null, description: "", quantity: 1, unit_price: 0, discount: 0, tax_code_id: tax || null });

async function zatcaProcess(id) {
  const inv = await run(supabase.from("invoices").select("*").eq("id", id).single());
  const lines = await run(supabase.from("invoice_lines").select("*, tax_codes(exemption_code, exemption_reason)").eq("invoice_id", id).order("line_no"));
  const seller = await run(supabase.from("organizations").select("*").eq("id", inv.org_id).single());
  const buyer = inv.customer_id ? await run(supabase.from("customers").select("*").eq("id", inv.customer_id).single()) : null;
  const ref = inv.ref_invoice_id ? await run(supabase.from("invoices").select("number").eq("id", inv.ref_invoice_id).single()) : null;
  const r = await processInvoice({
    invoice: inv, seller, buyer, refNumber: ref?.number,
    lines: lines.map((l) => ({ ...l, exemption_code: l.tax_codes?.exemption_code, exemption_reason: l.tax_codes?.exemption_reason })),
  });
  await rpc("zatca_attach", { p_invoice: id, p_hash: r.hash, p_qr: r.qr, p_xml: r.xml });
}

export function InvoiceEditor({ params }) {
  const { t, can, org, lang } = useApp();
  const isNew = params.id === "new";
  const [act, busy] = useAction();
  const lk = useData(async () => ({
    customers: await L.customers(), projects: await L.projects(), items: await L.items(), tax: await L.taxCodes(),
    invoices: await run(supabase.from("invoices").select("id, number, customer_id").eq("status", "issued").eq("doc_type", "invoice").order("issue_date", { ascending: false }).limit(300)),
  }), []);
  const std = lk.data?.tax?.find((x) => x.category === "S")?.id;
  const q = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const [form, setForm] = useState(null);
  const inv = useData(async () => {
    if (isNew) return null;
    const i = await run(supabase.from("invoices").select("*, customers(*), projects(code, name_ar), ref:ref_invoice_id(number)").eq("id", params.id).single());
    const lines = await run(supabase.from("invoice_lines").select("*").eq("invoice_id", params.id).order("line_no"));
    const pays = await run(supabase.from("payments").select("id, number, payment_date, amount, status").eq("invoice_id", params.id));
    return { ...i, lines, pays };
  }, [params.id]);

  useEffect(() => {
    if (isNew && lk.data && !form) {
      setForm({ invoice_kind: "standard", doc_type: q.get("doc") || "invoice", customer_id: q.get("customer"), project_id: null,
                ref_invoice_id: q.get("ref"), reason: "", issue_date: today(), supply_date: today(), retention_amount: 0, notes: "",
                lines: [blank(std)] });
    }
    if (!isNew && inv.data?.status === "draft" && !form) {
      const i = inv.data;
      setForm({ ...i, lines: i.lines.length ? i.lines : [blank(std)] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk.data, inv.data]);

  const i = inv.data;
  const editable = isNew || i?.status === "draft";
  const taxById = Object.fromEntries((lk.data?.tax || []).map((x) => [x.id, x]));

  if ((!isNew && !i) || (editable && (!form || !lk.data))) return <Loading />;
  if (!editable) return <InvoiceView inv={i} reload={inv.reload} />;

  const lines = form.lines;
  const calc = lines.map((l) => {
    const net = Math.round((Number(l.quantity || 0) * Number(l.unit_price || 0) - Number(l.discount || 0)) * 100) / 100;
    const vat = Math.round(net * Number(taxById[l.tax_code_id]?.rate || 0)) / 100;
    return { net, vat };
  });
  const sub = calc.reduce((n, c) => n + c.net, 0);
  const vat = calc.reduce((n, c) => n + c.vat, 0);
  const setLine = (k, patch) => setForm({ ...form, lines: lines.map((l, j) => (j === k ? { ...l, ...patch } : l)) });
  const customer = lk.data.customers.find((c) => c.id === form.customer_id);
  const warnB2B = form.invoice_kind === "standard" && customer &&
    ((customer.customer_type === "business" && !isVatNumber(customer.vat_number)) || !customer.street || !customer.building_no || !customer.postal_code || !customer.district);

  async function save() {
    const header = {
      invoice_kind: form.invoice_kind, doc_type: form.doc_type, customer_id: form.customer_id || null,
      project_id: form.project_id || null, ref_invoice_id: form.doc_type === "invoice" ? null : form.ref_invoice_id || null,
      reason: form.reason || null, issue_date: form.issue_date || null, supply_date: form.supply_date || null,
      due_date: form.due_date || null, retention_amount: Number(form.retention_amount || 0), notes: form.notes || null,
    };
    let id = params.id;
    if (isNew) id = (await run(supabase.from("invoices").insert(header).select("id").single())).id;
    else await run(supabase.from("invoices").update(header).eq("id", id));
    await run(supabase.from("invoice_lines").delete().eq("invoice_id", id));
    const rows = lines.filter((l) => l.description && Number(l.quantity) > 0).map((l, k) => ({
      invoice_id: id, line_no: k + 1, item_id: l.item_id || null, description: l.description, unit: l.unit || null,
      quantity: Number(l.quantity), unit_price: Number(l.unit_price || 0), discount: Number(l.discount || 0),
      tax_code_id: l.tax_code_id || std,
    }));
    if (rows.length) await run(supabase.from("invoice_lines").insert(rows));
    return id;
  }
  async function onSave() {
    const id = await act(save, t("تم الحفظ", "Saved"));
    if (id && isNew) go(`/sales/invoices/${id}`); else if (id) { setForm(null); inv.reload(); }
  }
  async function onIssue() {
    if (!window.confirm(t("إصدار الفاتورة؟ بعد الإصدار لا يمكن تعديلها (التصحيح بإشعار دائن/مدين فقط).",
                          "Issue the invoice? It becomes immutable (corrections via credit/debit notes only)."))) return;
    const id = await act(async () => {
      const id = await save();
      await rpc("issue_invoice", { p_invoice: id });
      await zatcaProcess(id);
      return id;
    }, t("تم إصدار الفاتورة وتوليد رمز QR وتوقيع ZATCA", "Invoice issued, QR and ZATCA hash generated"));
    if (id) { if (isNew) go(`/sales/invoices/${id}`); else { setForm(null); inv.reload(); } }
  }
  async function onDelete() {
    if (!window.confirm(t("حذف المسودة؟", "Delete draft?"))) return;
    if (await act(async () => { await run(supabase.from("invoices").delete().eq("id", params.id)); return true; })) go("/sales/invoices");
  }

  const doc = DOC(t);
  return (
    <>
      <PageHead title={isNew ? `${doc[form.doc_type]} ${t("جديدة", "— new")}` : `${doc[form.doc_type]} — ${t("مسودة", "draft")}`}>
        <button className="btn" onClick={() => go("/sales/invoices")}>{t("رجوع", "Back")}</button>
        {!isNew && can("sales.manage") && <button className="btn danger" onClick={onDelete} disabled={busy}>{t("حذف", "Delete")}</button>}
        {can("sales.manage") && <button className="btn" onClick={onSave} disabled={busy}>{t("حفظ كمسودة", "Save draft")}</button>}
        {can("sales.issue") && <button className="btn primary" onClick={onIssue} disabled={busy || sub <= 0 || !org.vat_number}>{t("إصدار الفاتورة", "Issue invoice")}</button>}
      </PageHead>
      {!org.vat_number && <div className="alert warn">{t("لا يمكن الإصدار قبل إدخال الرقم الضريبي للشركة.", "Add the company VAT number before issuing.")} <a href="#/settings/company">{t("الإعدادات", "Settings")}</a></div>}
      {warnB2B && <div className="alert warn">{t("الفاتورة الضريبية (B2B) تتطلب الرقم الضريبي والعنوان الوطني الكامل للعميل — أكملها من شاشة العملاء أو اختر فاتورة مبسطة.",
        "A standard (B2B) invoice needs the customer's VAT number and full national address — complete the customer or use a simplified invoice.")}</div>}
      <Panel>
        <div className="form">
          <Field label={t("نوع المستند", "Document")}>
            <select value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>
              <option value="invoice">{doc.invoice}</option><option value="credit_note">{doc.credit_note}</option><option value="debit_note">{doc.debit_note}</option>
            </select></Field>
          <Field label={t("فئة الفاتورة", "Invoice kind")}>
            <select value={form.invoice_kind} onChange={(e) => setForm({ ...form, invoice_kind: e.target.value })}>
              <option value="standard">{t("ضريبية (منشآت B2B)", "Standard (B2B)")}</option><option value="simplified">{t("مبسطة (أفراد B2C)", "Simplified (B2C)")}</option>
            </select></Field>
          <Field label={t("العميل", "Customer")} required={form.invoice_kind === "standard"}>
            <Select value={form.customer_id} onChange={(v) => setForm({ ...form, customer_id: v })} options={lk.data.customers} /></Field>
          <Field label={t("المشروع", "Project")}>
            <Select value={form.project_id} onChange={(v) => setForm({ ...form, project_id: v })} options={lk.data.projects} /></Field>
          {form.doc_type !== "invoice" && <>
            <Field label={t("الفاتورة الأصلية", "Original invoice")} required>
              <Select value={form.ref_invoice_id} onChange={(v) => setForm({ ...form, ref_invoice_id: v })}
                      options={lk.data.invoices.filter((x) => !form.customer_id || x.customer_id === form.customer_id).map((x) => ({ id: x.id, label: x.number }))} /></Field>
            <Field label={t("سبب الإشعار", "Reason")} required><input value={form.reason || ""} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </>}
          <Field label={t("تاريخ الإصدار", "Issue date")}><input type="date" value={form.issue_date || ""} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></Field>
          <Field label={t("تاريخ التوريد", "Supply date")}><input type="date" value={form.supply_date || ""} onChange={(e) => setForm({ ...form, supply_date: e.target.value })} /></Field>
          <Field label={t("تاريخ الاستحقاق", "Due date")} hint={t("افتراضياً حسب مدة سداد العميل", "Defaults to customer terms")}>
            <input type="date" value={form.due_date || ""} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
          <Field label={t("محتجزات ضمان", "Retention")}><input className="num" type="number" step="0.01" min="0" value={form.retention_amount ?? 0}
            onChange={(e) => setForm({ ...form, retention_amount: e.target.value })} /></Field>
          <Field label={t("ملاحظات", "Notes")} wide><input value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
      </Panel>
      <Panel pad={false} title={t("البنود", "Lines")}>
        <div className="tbl-wrap">
          <table className="tbl edit">
            <thead><tr><th style={{ minWidth: 170 }}>{t("الخدمة", "Item")}</th><th style={{ minWidth: 220 }}>{t("الوصف", "Description")}</th>
              <th className="n">{t("الكمية", "Qty")}</th><th className="n">{t("السعر", "Price")}</th><th className="n">{t("خصم", "Discount")}</th>
              <th style={{ minWidth: 150 }}>{t("الضريبة", "Tax")}</th><th className="n">{t("الصافي", "Net")}</th><th className="n">{t("الضريبة", "VAT")}</th><th /></tr></thead>
            <tbody>{lines.map((l, k) => (
              <tr key={k}>
                <td><select value={l.item_id || ""} onChange={(e) => {
                  const it = lk.data.items.find((x) => x.id === e.target.value);
                  setLine(k, it ? { item_id: it.id, description: it.name_ar, unit: it.unit, unit_price: it.unit_price, tax_code_id: it.tax_code_id || std } : { item_id: null });
                }}><option value="">—</option>{lk.data.items.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></td>
                <td><input value={l.description} onChange={(e) => setLine(k, { description: e.target.value })} /></td>
                <td><input className="num" type="number" step="any" min="0" style={{ width: 90 }} value={l.quantity} onChange={(e) => setLine(k, { quantity: e.target.value })} /></td>
                <td><input className="num" type="number" step="0.01" min="0" style={{ width: 110 }} value={l.unit_price} onChange={(e) => setLine(k, { unit_price: e.target.value })} /></td>
                <td><input className="num" type="number" step="0.01" min="0" style={{ width: 90 }} value={l.discount} onChange={(e) => setLine(k, { discount: e.target.value })} /></td>
                <td><select value={l.tax_code_id || ""} onChange={(e) => setLine(k, { tax_code_id: e.target.value })}>
                  {lk.data.tax.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></td>
                <td className="n">{num(calc[k].net)}</td><td className="n">{num(calc[k].vat)}</td>
                <td><button className="btn ghost sm" disabled={lines.length <= 1} onClick={() => setForm({ ...form, lines: lines.filter((_, j) => j !== k) })}>✕</button></td>
              </tr>))}
            </tbody>
            <tfoot><tr><td colSpan={6}><button className="btn sm" onClick={() => setForm({ ...form, lines: [...lines, blank(std)] })}>{t("+ بند", "+ Line")}</button></td>
              <td className="n"><Money v={sub} currency={null} /></td><td className="n"><Money v={vat} currency={null} /></td><td /></tr></tfoot>
          </table>
        </div>
        <div className="panel-body" style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ minWidth: 280 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><span>{t("الإجمالي قبل الضريبة", "Total excl. VAT")}</span><Money v={sub} /></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span>{t("ضريبة القيمة المضافة", "VAT")}</span><Money v={vat} /></div>
            <div className="row" style={{ justifyContent: "space-between", fontWeight: 700, fontSize: 16 }}><span>{t("الإجمالي", "Total")}</span><Money v={sub + vat} /></div>
            {Number(form.retention_amount) > 0 && <div className="row" style={{ justifyContent: "space-between" }}><span>{t("صافي المستحق بعد المحتجزات", "Net after retention")}</span><Money v={sub + vat - Number(form.retention_amount)} /></div>}
          </div>
        </div>
      </Panel>
      <p className="muted" style={{ fontSize: 12 }}>{lang === "ar" ? "الأرقام النهائية تحسبها قاعدة البيانات عند الحفظ والإصدار." : "Final figures are computed by the database on save/issue."}</p>
    </>
  );
}

function InvoiceView({ inv, reload }) {
  const { t, can, org } = useApp();
  const [act, busy] = useAction();
  const [qrImg, setQrImg] = useState(null);
  const docRef = useRef(null);
  useEffect(() => {
    if (inv.zatca_qr) QRCode.toDataURL(inv.zatca_qr, { margin: 1, width: 300, errorCorrectionLevel: "M" }).then(setQrImg).catch(() => setQrImg(null));
  }, [inv.zatca_qr]);
  const pdfName = `${inv.number || "invoice"}.pdf`;
  async function makePdf() { return nodeToPdf(docRef.current); }
  async function onPdf() { await act(async () => { downloadBlob(await makePdf(), pdfName); return true; }); }
  async function onShare() {
    const title = `${docTitle(inv).ar} ${inv.number}`;
    await act(async () => shareOrDownload(await makePdf(), pdfName, {
      title, text: `${title} — ${org.legal_name || org.name_ar} — ${num(inv.total)} ${t("ر.س", "SAR")}` }));
  }
  const c = inv.customers;
  const titles = {
    invoice: inv.invoice_kind === "standard" ? t("فاتورة ضريبية", "Tax invoice") : t("فاتورة ضريبية مبسطة", "Simplified tax invoice"),
    credit_note: t("إشعار دائن", "Credit note"), debit_note: t("إشعار مدين", "Debit note"),
  };
  const balance = Number(inv.net_payable) - Number(inv.amount_paid);

  function downloadXml() {
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${inv.zatca_xml}`], { type: "application/xml" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${inv.number}.xml`; a.click();
  }

  return (
    <>
      <PageHead title={`${titles[inv.doc_type]} ${inv.number}`} sub={<span className="row"><StatusBadge status="issued" />{payState(inv) && <StatusBadge status={payState(inv)} />}</span>}>
        <button className="btn no-print" onClick={() => go("/sales/invoices")}>{t("رجوع", "Back")}</button>
        {!inv.zatca_hash && can("sales.issue") && <button className="btn accent no-print" disabled={busy}
          onClick={async () => { if (await act(async () => { await zatcaProcess(inv.id); return true; }, t("تمت معالجة ZATCA", "ZATCA processed"))) reload(); }}>{t("إعادة معالجة ZATCA", "Retry ZATCA")}</button>}
        {inv.zatca_xml && <button className="btn no-print" onClick={downloadXml}>{t("تنزيل XML", "Download XML")}</button>}
        {inv.doc_type === "invoice" && can("sales.manage") && <button className="btn no-print" onClick={() => go(`/sales/invoices/new?doc=credit_note&ref=${inv.id}&customer=${inv.customer_id || ""}`)}>{t("إشعار دائن", "Credit note")}</button>}
        {balance > 0 && inv.doc_type !== "credit_note" && can("finance.manage") && <button className="btn no-print" onClick={() => go(`/finance/payments?invoice=${inv.id}`)}>{t("تسجيل تحصيل", "Record receipt")}</button>}
        <button className="btn no-print" onClick={() => window.print()}>{t("طباعة", "Print")}</button>
        <button className="btn no-print" onClick={onShare} disabled={busy}>{t("مشاركة", "Share")}</button>
        <button className="btn primary no-print" onClick={onPdf} disabled={busy}>{busy ? t("جارِ التجهيز…", "Preparing…") : t("تنزيل PDF", "Download PDF")}</button>
      </PageHead>
      <A4Viewer><InvoiceDocument ref={docRef} inv={inv} org={org} qrImg={qrImg} /></A4Viewer>
      <div className="grid c2 no-print" style={{ marginTop: 16 }}>
        <Panel title="ZATCA">
          <div className="grid" style={{ gap: 6 }}>
            <div>{t("الحالة", "Status")}: <StatusBadge status={inv.zatca_status} /></div>
            <div>UUID: <span className="mono">{inv.zatca_uuid}</span></div>
            <div>ICV: <span className="mono">{inv.zatca_icv}</span></div>
            <div>{t("بصمة الفاتورة", "Invoice hash")}: <span className="mono" style={{ wordBreak: "break-all" }}>{inv.zatca_hash || "—"}</span></div>
            <div>PIH: <span className="mono" style={{ wordBreak: "break-all" }}>{inv.zatca_pih}</span></div>
            {inv.journal_entry_id && <a href={`#/accounting/journals/${inv.journal_entry_id}`}>{t("عرض القيد المحاسبي", "View journal entry")}</a>}
          </div>
        </Panel>
        {inv.doc_type !== "credit_note" && <Panel title={t("التحصيلات", "Receipts")} pad={false}>
          <Table rows={inv.pays} empty={t("لا توجد تحصيلات", "No receipts yet")} columns={[
            { key: "number", label: t("السند", "Voucher"), render: (r) => <span className="mono">{r.number || "—"}</span> },
            { key: "payment_date", label: t("التاريخ", "Date"), type: "date" },
            { key: "amount", label: t("المبلغ", "Amount"), type: "money" },
            { key: "status", label: "", render: (r) => <StatusBadge status={r.status} /> },
          ]} footer={<><td colSpan={2}>{t("المتبقي", "Balance")}</td><td className="n"><Money v={balance} currency={null} /></td><td /></>} />
        </Panel>}
      </div>
    </>
  );
}
