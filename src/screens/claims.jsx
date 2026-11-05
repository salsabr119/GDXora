// Contract claims on a project: the progress-billing document for the
// consultant / owner, variation orders added to the BOQ, and retention
// release claims. Rules live in 0025_claims.sql; all documents print on the
// company letterhead when there is one.
import { forwardRef, useRef, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, useAction, Issues, useIssues, Panel, Table, Money, Modal, Field, Select } from "../ui.jsx";
import { today } from "../lib/format.js";
import { amountInArabicWords } from "../lib/tafqeet.js";
import { useLetterhead, letterheadStyle } from "../lib/letterhead.js";

const num = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v) => Number(Number(v || 0).toFixed(3)).toLocaleString("en-US", { maximumFractionDigits: 3 });
const r2 = (n) => Math.round(n * 100) / 100;

/** document header shared by the claim documents: the letterhead replaces logo and footer */
function DocHead({ org, letterhead, title, en }) {
  return (
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
      <div className="a4-title-box"><div className="a4-title">{title}</div><div className="a4-title-en">{en}</div></div>
    </header>
  );
}
const Signatures = ({ who }) => (
  <div className="qd-sign" style={{ gridTemplateColumns: `repeat(${who.length}, 1fr)`, marginTop: 28 }}>
    {who.map((w) => <div key={w}>{w}<div style={{ marginTop: 26 }}>............................</div></div>)}
  </div>
);

/* ── progress billing (مستخلص) ───────────────────────────────────────── */
/** amounts of a billing: stored ones once invoiced, estimates while a draft */
export function billingFigures(pb, lines, cum) {
  const current = lines.reduce((n, l) => n + r2((cum(l) - Number(l.previous_qty)) * Number(l.unit_price)), 0);
  const previous = lines.reduce((n, l) => n + r2(Number(l.previous_qty) * Number(l.unit_price)), 0);
  const invoiced = pb.status === "invoiced";
  const retention = invoiced ? Number(pb.retention) : r2(current * Number(pb.projects.retention_pct) / 100);
  const advance = invoiced ? Number(pb.advance_recovery) : r2(current * Number(pb.projects.advance_recovery_pct) / 100);
  const taxable = r2(current - advance), vat = r2(taxable * 0.15);
  return { current, previous, toDate: r2(previous + current), retention, advance, taxable, vat, due: r2(taxable + vat - retention), estimate: !invoiced };
}

export const ProgressBillingDocument = forwardRef(function ProgressBillingDocument({ pb, lines, cum, org, customer, letterhead }, ref) {
  const f = billingFigures(pb, lines, cum);
  return (
    <div className={`a4 ${letterhead ? "lh" : ""}`} ref={ref} dir="rtl" style={letterheadStyle(letterhead)}>
      <DocHead org={org} letterhead={letterhead} title={`مستخلص رقم ${pb.billing_no}`} en={`Progress billing No. ${pb.billing_no}`} />
      <table className="a4-kv" style={{ margin: "12px 0" }}><tbody>
        <tr><th>المشروع</th><td><b>{pb.projects.code} — {pb.projects.name_ar}</b></td><th>المالك</th><td>{customer || "—"}</td></tr>
        <tr><th>رقم العقد</th><td className="ltr">{pb.projects.contract_no || "—"}</td><th>الأعمال حتى تاريخ</th><td className="ltr">{pb.period_to}</td></tr>
      </tbody></table>
      <table className="a4-lines qd-billing">
        <thead>
          <tr><th rowSpan={2}>البند</th><th rowSpan={2} className="desc">الوصف</th><th rowSpan={2}>الوحدة</th><th rowSpan={2}>كمية العقد</th><th rowSpan={2}>السعر</th>
            <th colSpan={3}>الكميات</th><th colSpan={3}>القيمة</th></tr>
          <tr><th>السابقة</th><th>الحالية</th><th>التراكمية</th><th>السابقة</th><th>الحالية</th><th>التراكمية</th></tr>
        </thead>
        <tbody>{lines.map((l) => {
          const b = l.project_boq_items, c = cum(l), p = Number(l.previous_qty), rate = Number(l.unit_price);
          return <tr key={l.id}><td>{b.item_no}</td><td className="desc">{b.description}{b.variation_no && <small> ({b.variation_no})</small>}</td><td>{b.unit}</td>
            <td className="n">{qty(b.quantity)}</td><td className="n">{num(rate)}</td>
            <td className="n">{qty(p)}</td><td className="n">{qty(c - p)}</td><td className="n">{qty(c)}</td>
            <td className="n">{num(p * rate)}</td><td className="n"><b>{num((c - p) * rate)}</b></td><td className="n">{num(c * rate)}</td></tr>;
        })}</tbody>
      </table>
      <section className="a4-bottom">
        <div className="a4-words">
          <div className="a4-box-h">صافي المستحق كتابةً</div>
          <p>{amountInArabicWords(f.due)}</p>
          {f.estimate && <p className="muted" style={{ fontSize: 10 }}>مسودة: المحتجزات واسترداد الدفعة المقدمة تقديرية، وتُحسب نهائياً عند إنشاء الفاتورة.</p>}
        </div>
        <table className="a4-totals"><tbody>
          <tr><th>إجمالي الأعمال حتى تاريخه</th><td>{num(f.toDate)}</td></tr>
          <tr><th>يُخصم: المستخلصات السابقة</th><td>-{num(f.previous)}</td></tr>
          <tr><th>أعمال هذا المستخلص</th><td>{num(f.current)}</td></tr>
          <tr><th>يُخصم: استرداد الدفعة المقدمة</th><td>-{num(f.advance)}</td></tr>
          <tr><th>الصافي الخاضع للضريبة</th><td>{num(f.taxable)}</td></tr>
          <tr><th>ضريبة القيمة المضافة 15%</th><td>{num(f.vat)}</td></tr>
          <tr><th>يُخصم: المحتجزات ({Number(pb.projects.retention_pct)}%)</th><td>-{num(f.retention)}</td></tr>
          <tr className="grand"><th>صافي المستحق</th><td>{num(f.due)} ر.س</td></tr>
        </tbody></table>
      </section>
      <Signatures who={["إعداد: المقاول", "مراجعة: الاستشاري", "اعتماد: المالك"]} />
    </div>
  );
});

/* ── variation order (أمر تغيير) ─────────────────────────────────────── */
const blankItem = () => ({ item_no: "", description: "", unit: "", quantity: 1, unit_price: 0 });
export function VariationOrderModal({ project, existing, onClose, onDone }) {
  const { t } = useApp();
  const [act, busy] = useAction();
  const v = useIssues();
  const next = `VO-${String(new Set(existing.map((b) => b.variation_no).filter(Boolean)).size + 1).padStart(2, "0")}`;
  const [vo, setVo] = useState({ variation_no: next, variation_date: today(), variation_ref: "", items: [blankItem()] });
  const set = (k, patch) => setVo({ ...vo, items: vo.items.map((x, j) => (j === k ? { ...x, ...patch } : x)) });
  const used = vo.items.filter((x) => String(x.description || "").trim() || Number(x.unit_price));
  const total = used.reduce((n, x) => n + r2(Number(x.quantity || 0) * Number(x.unit_price || 0)), 0);
  async function save(e) {
    e.preventDefault();
    const out = [];
    if (!String(vo.variation_no || "").trim()) out.push({ key: "no", msg: t("اكتب رقم أمر التغيير", "Enter the variation order number") });
    else if (existing.some((b) => b.variation_no === vo.variation_no.trim())) out.push({ key: "no", msg: t(`أمر التغيير ${vo.variation_no} مسجّل مسبقاً في هذا المشروع`, "This variation order number already exists") });
    used.forEach((x, k) => {
      if (!String(x.description || "").trim()) out.push({ key: `i${k}`, msg: t(`البند ${k + 1}: اكتب الوصف`, `Item ${k + 1}: enter a description`) });
      if (!(Number(x.quantity) > 0)) out.push({ key: `i${k}`, msg: t(`البند ${k + 1}: الكمية أكبر من صفر`, `Item ${k + 1}: quantity must be above zero`) });
      if (Number(x.unit_price) < 0) out.push({ key: `i${k}`, msg: t(`البند ${k + 1}: السعر لا يكون سالباً`, `Item ${k + 1}: price cannot be negative`) });
    });
    if (!used.length) out.push(t("أضف بنداً واحداً على الأقل", "Add at least one item"));
    if (!v.check(out)) return;
    const n = await act(() => rpc("add_variation_order", { p_project: project.id, p: { ...vo, variation_no: vo.variation_no.trim(),
      items: used.map((x) => ({ ...x, quantity: Number(x.quantity), unit_price: Number(x.unit_price || 0) })) } }),
      t(`أُضيف أمر التغيير ${vo.variation_no}\nبنوده الآن في جدول الكميات، وتظهر في المستخلص القادم.`, "Variation order added"));
    if (n) onDone();
  }
  return (
    <Modal wide title={t("أمر تغيير (أعمال إضافية)", "Variation order")} onClose={onClose}
      footer={<><span className="muted">{t("قيمة الأمر:", "Order value:")} <Money v={total} /></span><span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="vo" disabled={busy}>{t("إضافة للجدول", "Add to BOQ")}</button></>}>
      <form id="vo" onSubmit={save} noValidate>
        <div className="alert">{t("أدخل الأعمال الإضافية التي اعتمدها المالك. تُضاف لجدول الكميات بعلامة رقم الأمر، ويفوترها المستخلص القادم مثل أي بند. لزيادة كمية بند قائم أضفه كبند جديد (مثال: «زيادة كمية بند 2.1»).",
          "Enter the additional work the owner approved. It joins the BOQ marked with the order number and the next billing bills it like any item. To increase an existing item, add it as a new line.")}</div>
        <Issues issues={v.issues} />
        <div className="form">
          <Field label={t("رقم أمر التغيير", "Order no.")} required invalid={v.has("no")}><input dir="ltr" value={vo.variation_no} onChange={(e) => setVo({ ...vo, variation_no: e.target.value })} /></Field>
          <Field label={t("التاريخ", "Date")}><input type="date" value={vo.variation_date} onChange={(e) => e.target.value && setVo({ ...vo, variation_date: e.target.value })} /></Field>
          <Field label={t("مرجع اعتماد المالك", "Owner's approval reference")} wide><input value={vo.variation_ref} placeholder={t("مثال: خطاب رقم 55 بتاريخ…", "e.g. Letter no. 55 dated…")} onChange={(e) => setVo({ ...vo, variation_ref: e.target.value })} /></Field>
        </div>
        <div className="tbl-wrap"><table className="tbl edit">
          <thead><tr><th style={{ width: 80 }}>{t("البند", "Item")}</th><th>{t("الوصف", "Description")}</th><th style={{ width: 80 }}>{t("الوحدة", "Unit")}</th>
            <th className="n" style={{ width: 100 }}>{t("الكمية", "Qty")}</th><th className="n" style={{ width: 120 }}>{t("السعر", "Rate")}</th><th /></tr></thead>
          <tbody>{vo.items.map((x, k) => (
            <tr key={k} className={v.has(`i${used.indexOf(x)}`) ? "invalid" : ""}>
              <td><input value={x.item_no} placeholder={`${vo.variation_no}-${k + 1}`} onChange={(e) => set(k, { item_no: e.target.value })} /></td>
              <td><input value={x.description} onChange={(e) => set(k, { description: e.target.value })} /></td>
              <td><input value={x.unit} onChange={(e) => set(k, { unit: e.target.value })} /></td>
              <td><input className="num" type="number" step="any" value={x.quantity} onChange={(e) => set(k, { quantity: e.target.value })} /></td>
              <td><input className="num" type="number" step="0.01" value={x.unit_price} onChange={(e) => set(k, { unit_price: e.target.value })} /></td>
              <td><button type="button" className="btn ghost sm" onClick={() => setVo({ ...vo, items: vo.items.length > 1 ? vo.items.filter((_, j) => j !== k) : [blankItem()] })}>✕</button></td>
            </tr>))}</tbody>
        </table></div>
        <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setVo({ ...vo, items: [...vo.items, blankItem()] })}>{t("+ بند", "+ Item")}</button>
      </form>
    </Modal>
  );
}

/* ── retention release (الإفراج عن المحتجزات) ────────────────────────── */
const KIND = (t) => [{ id: "completion", label: t("عند الاستلام الابتدائي / الإنجاز", "On completion") },
                     { id: "warranty", label: t("بعد انتهاء فترة الضمان", "After the warranty period") },
                     { id: "partial", label: t("إفراج جزئي", "Partial release") }];

export function RetentionTab({ project, customer }) {
  const { t, can, org } = useApp();
  const [act, busy] = useAction();
  const v = useIssues();
  const [claim, setClaim] = useState(null);
  const [printing, setPrinting] = useState(null);
  const docRef = useRef(null);
  const letterhead = useLetterhead();
  const d = useData(async () => ({
    r: (await rpc("project_retention", { p_project: project.id }))?.[0] || { held: 0, claimed: 0, received: 0, available: 0, outstanding: 0 },
    list: await run(supabase.from("retention_releases").select("*").eq("project_id", project.id).order("created_at", { ascending: false })),
  }), [project.id]);
  if (!d.data) return null;
  const { r, list } = d.data;
  const manage = can("projects.manage");

  async function save(e) {
    e.preventDefault();
    const amt = Number(claim.amount);
    if (!v.check([!(amt > 0) && { key: "amount", msg: t("المبلغ أكبر من صفر", "The amount must be above zero") },
                  amt > Number(r.available) && { key: "amount", msg: t(`المبلغ أكبر من المحتجزات المتبقية (${num(r.available)})`, "More than the retention still held") }])) return;
    const id = await act(() => rpc("create_retention_release", { p_project: project.id, p_amount: amt, p_date: claim.release_date, p_kind: claim.kind, p_notes: claim.notes || null }),
      t("تم إصدار مطالبة الإفراج عن المحتجزات\nنزّل ملف PDF وأرسله للمالك. عند التحصيل سجّل سند قبض بالحساب المقابل «محتجزات لدى العملاء» واختر المشروع.", "Retention release claim issued"));
    if (id) { setClaim(null); d.reload(); }
  }
  async function pdf(rel) {
    setPrinting(rel);
    await act(async () => {
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const { nodeToPdf, downloadBlob } = await import("../lib/pdf.js");
      downloadBlob(await nodeToPdf(docRef.current), `${rel.number}.pdf`);
      return true;
    });
    setPrinting(null);
  }
  return (
    <>
      <div className="grid k4" style={{ margin: "12px 0" }}>
        <div className="panel kpi"><div className="l">{t("المحتجزات على الفواتير", "Retention held on invoices")}</div><div className="v"><Money v={r.held} /></div></div>
        <div className="panel kpi"><div className="l">{t("تمت المطالبة بها", "Claimed")}</div><div className="v"><Money v={r.claimed} /></div>
          <div className="s">{t("المتبقي للمطالبة", "Left to claim")}: <Money v={r.available} /></div></div>
        <div className="panel kpi"><div className="l">{t("المحصّل", "Received")}</div><div className="v"><Money v={r.received} /></div></div>
        <div className="panel kpi"><div className="l">{t("المحتجزات غير المحصلة", "Outstanding")}</div><div className="v"><Money v={r.outstanding} /></div></div>
      </div>
      <Panel pad={false} title={t("مطالبات الإفراج عن المحتجزات", "Retention release claims")}
        actions={manage && Number(r.available) > 0 && <button className="btn sm primary" onClick={() => { v.clear(); setClaim({ amount: Number(r.available), release_date: today(), kind: "completion" }); }}>{t("+ مطالبة إفراج", "+ Release claim")}</button>}>
        <Table rows={list} empty={t("لا توجد مطالبات — تظهر المحتجزات هنا بعد إصدار فواتير المستخلصات", "No claims yet")} columns={[
          { key: "number", label: t("الرقم", "No."), render: (x) => <span className="mono">{x.number}</span> },
          { key: "release_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "kind", label: t("النوع", "Type"), render: (x) => KIND(t).find((k) => k.id === x.kind)?.label },
          { key: "amount", label: t("المبلغ", "Amount"), type: "money" },
          { key: "pdf", label: "", render: (x) => <button className="btn sm" onClick={() => pdf(x)} disabled={busy}>⬇ PDF</button> }]} />
      </Panel>
      {claim && <Modal title={t("مطالبة الإفراج عن المحتجزات", "Retention release claim")} onClose={() => { setClaim(null); v.clear(); }}
        footer={<><button className="btn" onClick={() => setClaim(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="ret" disabled={busy}>{t("إصدار المطالبة", "Issue claim")}</button></>}>
        <form id="ret" onSubmit={save} noValidate>
          <div className="alert">{t(`المتبقي للمطالبة ${num(r.available)} ر.س. لا تُحسب عليها ضريبة لأنها احتُسبت كاملة في فواتير المستخلصات. بعد الإصدار لا تُعدّل المطالبة.`,
            `Left to claim: ${num(r.available)}. No VAT: it was charged in full on the billing invoices. A claim is final once issued.`)}</div>
          <Issues issues={v.issues} />
          <div className="form">
            <Field label={t("المبلغ", "Amount")} required invalid={v.has("amount")}><input className="num" type="number" step="0.01" value={claim.amount} onChange={(e) => setClaim({ ...claim, amount: e.target.value })} /></Field>
            <Field label={t("التاريخ", "Date")}><input type="date" value={claim.release_date} onChange={(e) => e.target.value && setClaim({ ...claim, release_date: e.target.value })} /></Field>
            <Field label={t("النوع", "Type")}><Select value={claim.kind} onChange={(x) => setClaim({ ...claim, kind: x || "completion" })} options={KIND(t)} /></Field>
            <Field label={t("ملاحظات (تظهر في المطالبة)", "Notes (printed)")} wide><textarea rows={2} value={claim.notes || ""} placeholder={t("مثال: تم الاستلام الابتدائي بتاريخ…", "e.g. Provisional handover on…")} onChange={(e) => setClaim({ ...claim, notes: e.target.value })} /></Field>
          </div>
        </form>
      </Modal>}
      {printing && <div className="q-offscreen" dir="rtl"><RetentionClaimDocument ref={docRef} rel={printing} project={project} customer={customer} r={r} org={org} letterhead={letterhead} kind={KIND(t)} /></div>}
    </>
  );
}

export const RetentionClaimDocument = forwardRef(function RetentionClaimDocument({ rel, project, customer, r, org, letterhead, kind }, ref) {
  return (
    <div className={`a4 ${letterhead ? "lh" : ""}`} ref={ref} dir="rtl" style={letterheadStyle(letterhead)}>
      <DocHead org={org} letterhead={letterhead} title="مطالبة إفراج عن محتجزات" en="Retention release claim" />
      <table className="a4-kv" style={{ margin: "14px 0" }}><tbody>
        <tr><th>رقم المطالبة</th><td className="ltr"><b>{rel.number}</b></td><th>التاريخ</th><td className="ltr">{rel.release_date}</td></tr>
        <tr><th>المشروع</th><td><b>{project.code} — {project.name_ar}</b></td><th>رقم العقد</th><td className="ltr">{project.contract_no || "—"}</td></tr>
        <tr><th>السادة</th><td colSpan={3}><b>{customer || "—"}</b></td></tr>
      </tbody></table>
      <p className="qd-p">
        نأمل التكرم بالإفراج عن مبلغ <b>{num(rel.amount)} ريال</b> ({amountInArabicWords(rel.amount)}) من المحتجزات المستقطعة من مستخلصات المشروع،
        وذلك {kind.find((k) => k.id === rel.kind)?.label}.
      </p>
      {rel.notes && <p className="qd-p">{rel.notes}</p>}
      <table className="a4-totals" style={{ width: 360, marginTop: 16 }}><tbody>
        <tr><th>إجمالي المحتجزات المستقطعة</th><td>{num(r.held)}</td></tr>
        <tr><th>المبلغ المطالب به في هذه المطالبة</th><td>{num(rel.amount)}</td></tr>
        <tr className="grand"><th>المبلغ المطلوب</th><td>{num(rel.amount)} ر.س</td></tr>
      </tbody></table>
      <p className="qd-p muted" style={{ fontSize: 10, marginTop: 8 }}>المحتجزات خضعت لضريبة القيمة المضافة في فواتير المستخلصات، ولا تُحتسب عليها ضريبة في هذه المطالبة.</p>
      {(org.bank_name || org.iban) && <p className="qd-p">بيانات التحويل: {org.bank_name} <span className="ltr">{org.iban}</span></p>}
      <Signatures who={["المقاول", "الاستشاري", "المالك"]} />
    </div>
  );
});

