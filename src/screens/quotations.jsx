// Quotations (عروض الأسعار): prepared as drafts, sent, revised, accepted or
// rejected; printed on the company letterhead; an accepted quotation becomes
// a project with its BOQ in one step. Rules live in 0024_quotations.sql.
import { forwardRef, useEffect, useRef, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, StatusBadge, Field, Select, Modal, go, goBack, Loading, confirmDialog } from "../ui.jsx";
import * as L from "../lookups.js";
import { today } from "../lib/format.js";
import { amountInArabicWords } from "../lib/tafqeet.js";
import { A4Viewer } from "./InvoiceDocument.jsx";
import { useLetterhead, letterheadStyle } from "../lib/letterhead.js";

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/** a sent quotation past its validity date shows as expired */
export const quoteState = (q) => (q.status === "sent" && q.valid_until < today() ? "expired" : q.status);
const party = (q) => q.customers?.name_ar || q.prospect_name || "—";
const blank = () => ({ item_no: "", description: "", unit: "", quantity: 1, unit_price: 0, vat_rate: 15 });
const lineNet = (l) => Math.round(Number(l.quantity || 0) * Number(l.unit_price || 0) * 100) / 100;
const lineVat = (l) => Math.round(lineNet(l) * Number(l.vat_rate ?? 15)) / 100;

export function Quotations() {
  const { t, can } = useApp();
  const list = useData(() => run(supabase.from("quotations").select("*, customers(name_ar)").order("created_at", { ascending: false }).limit(1000)), []);
  return (
    <>
      <PageHead title={t("عروض الأسعار", "Quotations")} sub={t("تُطبع على الورق الرسمي للشركة، والعرض المقبول يتحول إلى مشروع بجدول كمياته", "Printed on the company letterhead; an accepted quotation becomes a project with its BOQ")}>
        {can("sales.manage") && <button className="btn primary" onClick={() => go("/sales/quotations/new")}>{t("+ عرض سعر جديد", "+ New quotation")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(q) => go(`/sales/quotations/${q.id}`)} columns={[
          { key: "number", label: t("الرقم", "No."), render: (q) => <span className="mono">{q.number}{q.revision ? `/R${q.revision}` : ""}</span> },
          { key: "party", label: t("العميل", "Customer"), render: party },
          { key: "title", label: t("الموضوع", "Subject") },
          { key: "issue_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "valid_until", label: t("صالح حتى", "Valid until"), type: "date" },
          { key: "total", label: t("الإجمالي شامل الضريبة", "Total incl. VAT"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (q) => <StatusBadge status={quoteState(q)} /> },
        ]} empty={t("لا توجد عروض أسعار بعد — اضغط «+ عرض سعر جديد»", "No quotations yet — press “+ New quotation”")} />
      </Panel>
    </>
  );
}

export function QuotationEditor({ params }) {
  const { t, can, org, notify } = useApp();
  const isNew = params.id === "new";
  const [act, busy] = useAction();
  const v = useIssues();
  const [form, setForm] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const docRef = useRef(null);
  const letterhead = useLetterhead();
  const lk = useData(async () => ({ customers: await L.customers() }), []);
  const d = useData(async () => {
    if (isNew) return null;
    const q = await run(supabase.from("quotations").select("*, customers(*), projects(code, name_ar)").eq("id", params.id).single());
    return { ...q, lines: await run(supabase.from("quotation_lines").select("*").eq("quotation_id", params.id).order("line_no")) };
  }, [params.id]);
  const q = d.data;
  const editable = can("sales.manage") && (isNew || q?.status === "draft");

  useEffect(() => {
    if (form) return;
    if (isNew) setForm({ customer_id: null, prospect: false, title: "", issue_date: today(), valid_until: addDays(today(), 30), terms: "", notes: "", lines: [blank()] });
    else if (q) setForm({ ...q, prospect: !q.customer_id, lines: q.lines.length ? q.lines : [blank()] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, isNew]);
  if (!form || (!isNew && !q) || !lk.data) return <Loading />;

  const lines = form.lines;
  const sub = lines.reduce((n, l) => n + lineNet(l), 0), vat = lines.reduce((n, l) => n + lineVat(l), 0);
  const setLine = (k, patch) => setForm({ ...form, lines: lines.map((l, j) => (j === k ? { ...l, ...patch } : l)) });
  const used = lines.filter((l) => String(l.description || "").trim() || Number(l.unit_price));

  function problems() {
    const out = [];
    if (!String(form.title || "").trim()) out.push({ key: "title", msg: t("اكتب موضوع العرض (مثال: توريد وتركيب…)", "Enter the subject of the quotation") });
    if (form.prospect ? !String(form.prospect_name || "").trim() : !form.customer_id) out.push({ key: "party", msg: form.prospect ? t("اكتب اسم الجهة الموجّه لها العرض", "Enter the prospect's name") : t("اختر العميل، أو اختر «جهة غير مسجلة»", "Choose the customer, or “Not in the customers list”") });
    if (form.valid_until < form.issue_date) out.push({ key: "valid_until", msg: t("تاريخ الصلاحية قبل تاريخ العرض", "Valid-until is before the quotation date") });
    used.forEach((l, k) => {
      if (!String(l.description || "").trim()) out.push({ key: `line${k}`, msg: t(`البند ${k + 1}: اكتب الوصف`, `Line ${k + 1}: enter a description`) });
      if (!(Number(l.quantity) > 0)) out.push({ key: `line${k}`, msg: t(`البند ${k + 1}: الكمية أكبر من صفر`, `Line ${k + 1}: quantity must be above zero`) });
      if (Number(l.unit_price) < 0) out.push({ key: `line${k}`, msg: t(`البند ${k + 1}: السعر لا يكون سالباً`, `Line ${k + 1}: price cannot be negative`) });
    });
    if (!used.length) out.push(t("أضف بنداً واحداً على الأقل (وصف + كمية + سعر)", "Add at least one line"));
    return out;
  }
  async function save() {
    return rpc("save_quotation", { p: {
      id: isNew ? null : q.id, customer_id: form.prospect ? null : form.customer_id,
      prospect_name: form.prospect_name, prospect_vat: form.prospect_vat, prospect_phone: form.prospect_phone, prospect_email: form.prospect_email,
      title: form.title, issue_date: form.issue_date, valid_until: form.valid_until, terms: form.terms, notes: form.notes,
      lines: used.map((l) => ({ item_no: l.item_no, description: l.description, unit: l.unit, quantity: Number(l.quantity), unit_price: Number(l.unit_price || 0), vat_rate: Number(l.vat_rate ?? 15) })),
    } });
  }
  const reopen = (id) => { setForm(null); if (isNew) go(`/sales/quotations/${id}`); else d.reload(); };
  async function onSave() {
    if (!v.check(problems())) return;
    const id = await act(save, t("تم حفظ المسودة", "Draft saved"));
    if (id) reopen(id);
  }
  async function onSend() {
    if (!v.check(problems())) return;
    if (!await confirmDialog(t("اعتماد العرض كمُرسل للعميل؟\nبعدها لا يُعدّل إلا بإعادته لمسودة (مراجعة جديدة).", "Mark the quotation as sent? Further edits need a new revision."))) return;
    const id = await act(async () => { const id = await save(); await rpc("set_quotation_status", { p_id: id, p_status: "sent" }); return id; },
      t("العرض مُرسل\nنزّل ملف PDF وأرسله للعميل، ثم سجّل قبوله أو رفضه هنا.", "Quotation sent"));
    if (id) reopen(id);
  }
  async function setStatus(status, reason) {
    const ok = await act(async () => { await rpc("set_quotation_status", { p_id: q.id, p_status: status, p_reason: reason || null }); return true; },
      { draft: t("رجع العرض مسودة — عدّله ثم أرسله كمراجعة جديدة", "Back to draft — edit and send the new revision"),
        accepted: t("تم تسجيل قبول العرض\nالخطوة التالية: «تحويل إلى مشروع».", "Quotation accepted"), rejected: t("تم تسجيل رفض العرض", "Quotation rejected") }[status]);
    if (ok) { setRejecting(null); reopen(q.id); }
  }
  async function onReject(e) {
    e.preventDefault();
    if (!v.check([!String(rejecting.reason || "").trim() && { key: "reason", msg: t("اكتب سبب الرفض", "Enter the reason") }])) return;
    await setStatus("rejected", rejecting.reason);
  }
  async function onProject() {
    if (!await confirmDialog(t(`إنشاء مشروع «${q.title}» من هذا العرض؟\nقيمة العقد ${sub.toLocaleString("en-US")} قبل الضريبة، وبنود العرض تصير جدول الكميات${q.customer_id ? "" : "، ويُضاف العميل لقائمة العملاء"}.`, "Create a project from this quotation?"))) return;
    const id = await act(() => rpc("quotation_to_project", { p_id: q.id }), t("تم إنشاء المشروع\nراجع بياناته (نسبة المحتجزات والدفعة المقدمة) ثم ابدأ المستخلصات.", "Project created"));
    if (id) go(`/projects/${id}`);
  }
  async function onDelete() {
    if (!await confirmDialog(t("حذف المسودة نهائياً؟", "Delete this draft?"))) return;
    if (await act(async () => { await run(supabase.from("quotations").delete().eq("id", q.id)); return true; }, t("تم الحذف", "Deleted"))) go("/sales/quotations");
  }
  async function onPdf() {
    await act(async () => {
      const { nodeToPdf, downloadBlob } = await import("../lib/pdf.js");
      downloadBlob(await nodeToPdf(docRef.current), `${q?.number || "quotation"}${q?.revision ? `-R${q.revision}` : ""}.pdf`);
      return true;
    });
  }

  const state = q ? quoteState(q) : "draft";
  const docData = { ...(q || {}), ...form, number: q?.number, revision: q?.revision || 0, customers: form.prospect ? null : lk.data.customers.find((c) => c.id === form.customer_id),
                    lines: used, subtotal: sub, vat_amount: vat, total: sub + vat };
  return (
    <>
      <PageHead title={isNew ? t("عرض سعر جديد", "New quotation") : `${t("عرض سعر", "Quotation")} ${q.number}${q.revision ? ` / R${q.revision}` : ""}`}
                sub={!isNew && <span className="row"><StatusBadge status={state} />{q.projects && <a href={`#/projects/${q.project_id}`}>{t("المشروع:", "Project:")} {q.projects.name_ar}</a>}</span>}>
        <button className="btn" onClick={() => goBack("/sales/quotations")}>{t("رجوع", "Back")}</button>
        {editable && !isNew && <button className="btn danger" onClick={onDelete} disabled={busy}>{t("حذف", "Delete")}</button>}
        {editable && <button className="btn" onClick={onSave} disabled={busy}>{t("حفظ كمسودة", "Save draft")}</button>}
        {editable && <button className="btn primary" onClick={onSend} disabled={busy}>{t("اعتماد كمُرسل", "Mark as sent")}</button>}
        {!isNew && can("sales.manage") && q.status === "sent" && <>
          <button className="btn" onClick={() => setStatus("draft")} disabled={busy}>{t("مراجعة (رجوع لمسودة)", "Revise")}</button>
          <button className="btn danger" onClick={() => { v.clear(); setRejecting({}); }} disabled={busy}>{t("رفض", "Rejected")}</button>
          <button className="btn primary" onClick={() => setStatus("accepted")} disabled={busy}>{t("قبول", "Accepted")}</button></>}
        {!isNew && q.status === "accepted" && !q.project_id && can("projects.manage") && <button className="btn primary" onClick={onProject} disabled={busy}>{t("تحويل إلى مشروع", "Create project")}</button>}
        {!isNew && <button className="btn" onClick={onPdf} disabled={busy}>⬇ PDF</button>}
      </PageHead>
      {!rejecting && <Issues issues={v.issues} />}
      {q?.status === "rejected" && <div className="alert bad">{t("سبب الرفض:", "Reason:")} {q.reject_reason}</div>}
      {state === "expired" && <div className="alert">{t("انتهت صلاحية العرض — أعده لمسودة وحدّث التاريخ إذا ما زال العميل مهتماً.", "This quotation has expired — revise it with new dates if the customer is still interested.")}</div>}
      {editable && <>
        <Panel>
          <div className="form">
            <Field label={t("الموجّه إليه", "To")} required invalid={v.has("party")}>
              <Select value={form.prospect ? "__p" : form.customer_id} onChange={(x) => setForm({ ...form, prospect: x === "__p", customer_id: x === "__p" ? null : x })}
                      options={[{ id: "__p", label: t("— جهة غير مسجلة في العملاء —", "— Not in the customers list —") }, ...lk.data.customers]} /></Field>
            {form.prospect && <>
              <Field label={t("اسم الجهة", "Name")} required invalid={v.has("party")}><input value={form.prospect_name || ""} onChange={(e) => setForm({ ...form, prospect_name: e.target.value })} /></Field>
              <Field label={t("الرقم الضريبي", "VAT no.")}><input dir="ltr" value={form.prospect_vat || ""} onChange={(e) => setForm({ ...form, prospect_vat: e.target.value })} /></Field>
              <Field label={t("الجوال", "Phone")}><input dir="ltr" value={form.prospect_phone || ""} onChange={(e) => setForm({ ...form, prospect_phone: e.target.value })} /></Field>
              <Field label={t("البريد", "E-mail")}><input dir="ltr" value={form.prospect_email || ""} onChange={(e) => setForm({ ...form, prospect_email: e.target.value })} /></Field>
            </>}
            <Field label={t("الموضوع", "Subject")} required wide invalid={v.has("title")}><input value={form.title || ""} placeholder={t("مثال: توريد وتركيب أنظمة التكييف — مبنى الإدارة", "e.g. Supply & installation of HVAC")} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label={t("تاريخ العرض", "Date")}><input type="date" value={form.issue_date} onChange={(e) => e.target.value && setForm({ ...form, issue_date: e.target.value })} /></Field>
            <Field label={t("صالح حتى", "Valid until")} invalid={v.has("valid_until")}><input type="date" value={form.valid_until} onChange={(e) => e.target.value && setForm({ ...form, valid_until: e.target.value })} /></Field>
          </div>
        </Panel>
        <Panel pad={false} title={t("البنود", "Lines")}>
          <div className="tbl-wrap"><table className="tbl edit">
            <thead><tr><th style={{ width: 70 }}>{t("رقم البند", "Item")}</th><th>{t("الوصف", "Description")}</th><th style={{ width: 80 }}>{t("الوحدة", "Unit")}</th>
              <th className="n" style={{ width: 100 }}>{t("الكمية", "Qty")}</th><th className="n" style={{ width: 120 }}>{t("سعر الوحدة", "Unit price")}</th>
              <th className="n" style={{ width: 80 }}>{t("الضريبة %", "VAT %")}</th><th className="n">{t("المبلغ", "Amount")}</th><th /></tr></thead>
            <tbody>{lines.map((l, k) => (
              <tr key={k} className={v.has(`line${used.indexOf(l)}`) ? "invalid" : ""}>
                <td><input value={l.item_no || ""} onChange={(e) => setLine(k, { item_no: e.target.value })} /></td>
                <td><input value={l.description || ""} onChange={(e) => setLine(k, { description: e.target.value })} /></td>
                <td><input value={l.unit || ""} onChange={(e) => setLine(k, { unit: e.target.value })} /></td>
                <td><input className="num" type="number" step="any" value={l.quantity} onChange={(e) => setLine(k, { quantity: e.target.value })} /></td>
                <td><input className="num" type="number" step="0.01" value={l.unit_price} onChange={(e) => setLine(k, { unit_price: e.target.value })} /></td>
                <td><select value={Number(l.vat_rate ?? 15)} onChange={(e) => setLine(k, { vat_rate: Number(e.target.value) })}><option value={15}>15%</option><option value={0}>0%</option></select></td>
                <td className="n"><Money v={lineNet(l)} currency={null} /></td>
                <td><button className="btn ghost sm" title={t("حذف البند", "Remove line")} onClick={() => setForm({ ...form, lines: lines.length > 1 ? lines.filter((_, j) => j !== k) : [blank()] })}>✕</button></td>
              </tr>))}</tbody>
            <tfoot>
              <tr><td colSpan={6}>{t("الإجمالي قبل الضريبة", "Subtotal")}</td><td className="n"><Money v={sub} currency={null} /></td><td /></tr>
              <tr><td colSpan={6}>{t("ضريبة القيمة المضافة", "VAT")}</td><td className="n"><Money v={vat} currency={null} /></td><td /></tr>
              <tr><td colSpan={6}><b>{t("الإجمالي شامل الضريبة", "Total incl. VAT")}</b></td><td className="n"><b><Money v={sub + vat} currency={null} /></b></td><td /></tr>
            </tfoot>
          </table></div>
          <div style={{ padding: 10 }}><button className="btn sm" onClick={() => setForm({ ...form, lines: [...lines, blank()] })}>{t("+ بند", "+ Line")}</button></div>
        </Panel>
        <Panel>
          <div className="form">
            <Field label={t("الشروط (الدفع، مدة التنفيذ، الاستثناءات)", "Terms (payment, duration, exclusions)")} wide>
              <textarea rows={4} value={form.terms || ""} onChange={(e) => setForm({ ...form, terms: e.target.value })} placeholder={t("مثال: 30% دفعة مقدمة، والباقي حسب المستخلصات. مدة التنفيذ 90 يوماً. الأسعار لا تشمل الأعمال الكهربائية.", "e.g. 30% advance, balance against progress billings…")} /></Field>
            <Field label={t("ملاحظات", "Notes")} wide><textarea rows={2} value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          </div>
        </Panel>
      </>}
      <div className="section-title">{t("معاينة العرض كما يُطبع", "Preview as printed")}</div>
      <A4Viewer><QuotationDocument ref={docRef} q={docData} org={org} letterhead={letterhead} /></A4Viewer>
      {rejecting && <Modal title={t("رفض عرض السعر", "Quotation rejected")} onClose={() => { setRejecting(null); v.clear(); }}
        footer={<><button className="btn" onClick={() => setRejecting(null)}>{t("إلغاء", "Cancel")}</button><button className="btn danger" form="rej" disabled={busy}>{t("تسجيل الرفض", "Record rejection")}</button></>}>
        <form id="rej" onSubmit={onReject} noValidate>
          <Issues issues={v.issues} />
          <Field label={t("سبب الرفض", "Reason")} required invalid={v.has("reason")} wide>
            <textarea rows={3} value={rejecting.reason || ""} placeholder={t("مثال: السعر أعلى من الميزانية، تمت الترسية على منافس…", "e.g. Over budget, awarded to a competitor…")}
                      onChange={(e) => setRejecting({ reason: e.target.value })} /></Field>
        </form>
      </Modal>}
    </>
  );
}

/* ── the printed quotation (A4, on the company letterhead when there is one) ── */
const num = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const Bi = ({ ar, en }) => <span className="bi"><span>{ar}</span><small dir="ltr">{en}</small></span>;

export const QuotationDocument = forwardRef(function QuotationDocument({ q, org, letterhead }, ref) {
  const c = q.customers;
  const to = c ? { name: c.name_ar, vat: c.vat_number, phone: c.phone, email: c.email } : { name: q.prospect_name, vat: q.prospect_vat, phone: q.prospect_phone, email: q.prospect_email };
  return (
    <div className={`a4 ${letterhead ? "lh" : ""}`} ref={ref} dir="rtl" style={letterheadStyle(letterhead)}>
      <header className="a4-head">
        <div className="a4-org">
          {!letterhead && org.logo_data && <img className="a4-logo" src={org.logo_data} alt="" />}
          <div>
            <div className="a4-org-name">{org.legal_name || org.name_ar}</div>
            <div className="a4-meta">
              {org.vat_number && <span>الرقم الضريبي VAT: <b className="ltr">{org.vat_number}</b></span>}
              {org.cr_number && <span>س.ت CR: <b className="ltr">{org.cr_number}</b></span>}
            </div>
          </div>
        </div>
        <div className="a4-title-box">
          <div className="a4-title">عرض سعر</div>
          <div className="a4-title-en">Quotation</div>
        </div>
      </header>
      <section className="a4-grid">
        <div className="a4-box">
          <div className="a4-box-h"><Bi ar="بيانات العرض" en="Quotation details" /></div>
          <table className="a4-kv"><tbody>
            <tr><th><Bi ar="رقم العرض" en="No." /></th><td className="ltr"><b>{q.number || "—"}{q.revision ? ` / R${q.revision}` : ""}</b></td></tr>
            <tr><th><Bi ar="التاريخ" en="Date" /></th><td className="ltr">{q.issue_date}</td></tr>
            <tr><th><Bi ar="صالح حتى" en="Valid until" /></th><td className="ltr">{q.valid_until}</td></tr>
          </tbody></table>
        </div>
        <div className="a4-box">
          <div className="a4-box-h"><Bi ar="السادة" en="To" /></div>
          <table className="a4-kv"><tbody>
            <tr><th><Bi ar="الاسم" en="Name" /></th><td><b>{to.name || "—"}</b></td></tr>
            {to.vat && <tr><th><Bi ar="الرقم الضريبي" en="VAT no." /></th><td className="ltr">{to.vat}</td></tr>}
            {(to.phone || to.email) && <tr><th><Bi ar="التواصل" en="Contact" /></th><td className="ltr">{[to.phone, to.email].filter(Boolean).join(" · ")}</td></tr>}
          </tbody></table>
        </div>
      </section>
      <p style={{ margin: "0 0 10px" }}><b>الموضوع:</b> {q.title || "—"}</p>
      <table className="a4-lines">
        <thead><tr>
          <th style={{ width: 40 }}>#</th><th className="desc"><Bi ar="الوصف" en="Description" /></th><th><Bi ar="الوحدة" en="Unit" /></th>
          <th><Bi ar="الكمية" en="Qty" /></th><th><Bi ar="سعر الوحدة" en="Unit price" /></th><th><Bi ar="المبلغ" en="Amount" /></th>
        </tr></thead>
        <tbody>{(q.lines || []).map((l, k) => (
          <tr key={k}><td>{l.item_no || k + 1}</td><td className="desc">{l.description}</td><td>{l.unit || ""}</td>
            <td className="n">{Number(l.quantity)}</td><td className="n">{num(l.unit_price)}</td><td className="n"><b>{num(lineNet(l))}</b></td></tr>))}
        </tbody>
      </table>
      <section className="a4-bottom">
        <div className="a4-words">
          <div className="a4-box-h"><Bi ar="المبلغ كتابةً" en="Amount in words" /></div>
          <p>{amountInArabicWords(q.total)}</p>
          {q.terms && <><div className="a4-box-h"><Bi ar="الشروط" en="Terms" /></div><p style={{ whiteSpace: "pre-line" }}>{q.terms}</p></>}
          {q.notes && <><div className="a4-box-h"><Bi ar="ملاحظات" en="Notes" /></div><p style={{ whiteSpace: "pre-line" }}>{q.notes}</p></>}
        </div>
        <table className="a4-totals"><tbody>
          <tr><th><Bi ar="الإجمالي قبل الضريبة" en="Subtotal" /></th><td>{num(q.subtotal)} ر.س</td></tr>
          <tr><th><Bi ar="ضريبة القيمة المضافة" en="VAT" /></th><td>{num(q.vat_amount)} ر.س</td></tr>
          <tr className="grand"><th><Bi ar="الإجمالي شامل الضريبة" en="Total incl. VAT" /></th><td>{num(q.total)} ر.س</td></tr>
        </tbody></table>
      </section>
      <div className="qd-sign" style={{ marginTop: 24 }}><div>الاعتماد: ............................</div><div>التوقيع والختم: ............................</div></div>
      {!letterhead && <footer className="a4-foot">
        <div className="a4-contact">{[org.phone, org.email, org.website].filter(Boolean).map((x) => <span key={x} className="ltr">{x}</span>)}</div>
        <div className="a4-gen">GDXora · Global Drive IT Solutions</div>
      </footer>}
    </div>
  );
});
