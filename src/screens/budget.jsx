// Project cost budget: the team adds lines (category, description, amount);
// once saved a line is locked and any change or deletion goes to the system
// administrator (budget.approve) for approval. Rules: 0027_budget_control.sql.
import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, useAction, Issues, useIssues, Panel, Money, Modal, Field, Select, Badge, StatusBadge } from "../ui.jsx";

export const BUDGET_CATS = (t) => [
  { id: "materials", label: t("مواد", "Materials") }, { id: "labour", label: t("عمالة", "Labour") },
  { id: "subcontract", label: t("مقاولو باطن", "Subcontract") }, { id: "equipment", label: t("معدات", "Equipment") },
  { id: "overhead", label: t("مصاريف غير مباشرة", "Overhead") }, { id: "other", label: t("أخرى", "Other") }];

export function BudgetTab({ project, actualCost, onChange }) {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const add = useIssues(), ch = useIssues(), dec = useIssues();
  const [row, setRow] = useState({ category: "materials", description: "", amount: "" });
  const [change, setChange] = useState(null);     // { line, action, category, description, amount, reason }
  const [deciding, setDeciding] = useState(null); // { request, approve, note }
  const d = useData(async () => ({
    lines: await run(supabase.from("project_budget_lines").select("*").eq("project_id", project.id).order("created_at")),
    reqs: await run(supabase.from("budget_change_requests").select("*").eq("project_id", project.id).order("requested_at", { ascending: false })),
  }), [project.id]);
  if (!d.data) return null;
  const { lines, reqs } = d.data;
  const manage = can("projects.manage"), approver = can("budget.approve");
  const cat = (id) => BUDGET_CATS(t).find((c) => c.id === id)?.label || id;
  const total = lines.reduce((n, l) => n + Number(l.amount), 0);
  const pending = reqs.filter((r) => r.status === "pending");
  const pendingOf = (l) => pending.find((r) => r.line_id === l.id);
  const reload = () => { d.reload(); onChange?.(); };

  async function addLine(e) {
    e.preventDefault();
    if (!add.check([
      !String(row.description || "").trim() && { key: "description", msg: t("اكتب وصف البند (مثال: حديد تسليح، عمالة الهيكل)", "Describe the line") },
      !(Number(row.amount) > 0) && { key: "amount", msg: t("قيمة التكلفة أكبر من صفر", "The cost must be above zero") },
      lines.some((l) => l.category === row.category && (l.description || "") === row.description.trim()) && { key: "description", msg: t("يوجد بند بنفس الفئة والوصف — اطلب تعديله بدلاً من إضافته مرة أخرى", "A line with this category and description exists — request a change instead") },
    ])) return;
    if (await act(async () => {
      await run(supabase.from("project_budget_lines").insert({ project_id: project.id, category: row.category, description: row.description.trim(), amount: Number(row.amount) }));
      return true;
    }, t("أُضيف البند للميزانية\nبعد الحفظ لا يُعدّل إلا بموافقة مدير النظام.", "Line added"))) { setRow({ ...row, description: "", amount: "" }); reload(); }
  }
  async function sendChange(e) {
    e.preventDefault();
    const c = change, upd = c.action === "update";
    if (!ch.check([
      !String(c.reason || "").trim() && { key: "reason", msg: t("اكتب سبب التعديل", "Give the reason for the change") },
      upd && !(Number(c.amount) > 0) && { key: "amount", msg: t("قيمة التكلفة أكبر من صفر", "The cost must be above zero") },
      upd && c.category === c.line.category && String(c.description || "").trim() === (c.line.description || "") && Number(c.amount) === Number(c.line.amount)
        && t("لم تغيّر شيئاً في البند", "Nothing changed in this line"),
    ])) return;
    const id = await act(() => rpc("request_budget_change", { p_line: c.line.id, p_action: c.action, p_reason: c.reason,
      p_category: upd ? c.category : null, p_description: upd ? c.description : null, p_amount: upd ? Number(c.amount) : null }),
      approver ? t("تم تطبيق التعديل على الميزانية", "Change applied")
               : t("أُرسل طلب التعديل لمدير النظام\nيبقى البند كما هو حتى يُعتمد الطلب.", "Change sent for approval"));
    if (id) { setChange(null); reload(); }
  }
  async function decide(e) {
    e.preventDefault();
    if (!dec.check([!deciding.approve && !String(deciding.note || "").trim() && { key: "note", msg: t("اكتب سبب الرفض", "Give the reason for the rejection") }])) return;
    if (await act(async () => { await rpc("decide_budget_change", { p_request: deciding.request.id, p_approve: deciding.approve, p_note: deciding.note || null }); return true; },
      deciding.approve ? t("اعتُمد التعديل وطُبّق على الميزانية", "Change approved") : t("رُفض طلب التعديل", "Change rejected"))) { setDeciding(null); reload(); }
  }
  const describe = (r) => r.action === "delete"
    ? t(`حذف «${cat(r.old_category)} — ${r.old_description || ""}» (${Number(r.old_amount).toLocaleString("en-US")})`, `Delete ${r.old_description || cat(r.old_category)}`)
    : <>{cat(r.old_category)} — {r.old_description} <span className="mono">{Number(r.old_amount).toLocaleString("en-US")}</span> ← <b>{cat(r.new_category)} — {r.new_description} <span className="mono">{Number(r.new_amount).toLocaleString("en-US")}</span></b></>;

  return (
    <>
      <Panel pad={false} title={t("الميزانية التقديرية للتكاليف", "Cost budget")}>
        <div className="alert" style={{ margin: 12 }}>{t("أضف بنود التكلفة المتوقعة للمشروع. البند المحفوظ لا يُعدّل ولا يُحذف إلا بطلب يعتمده مدير النظام.",
          "Add the expected cost lines. A saved line changes only through a request the administrator approves.")}</div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>{t("الفئة", "Category")}</th><th>{t("الوصف", "Description")}</th><th className="n">{t("قيمة التكلفة", "Cost")}</th><th /></tr></thead>
          <tbody>
            {!lines.length && <tr><td colSpan={4} className="muted">{t("لا توجد بنود بعد — أضف أول بند من الأسفل", "No lines yet — add the first one below")}</td></tr>}
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{cat(l.category)}</td><td>{l.description || "—"}</td><td className="n"><Money v={l.amount} currency={null} /></td>
                <td style={{ whiteSpace: "nowrap" }}>{pendingOf(l) ? <Badge kind="warn">{t("تعديل بانتظار الاعتماد", "Change pending")}</Badge>
                  : manage && <button className="btn sm" onClick={() => { ch.clear(); setChange({ line: l, action: "update", category: l.category, description: l.description || "", amount: Number(l.amount), reason: "" }); }}>
                    {approver ? t("تعديل", "Edit") : t("طلب تعديل", "Request change")}</button>}</td>
              </tr>))}
          </tbody>
          <tfoot><tr><td colSpan={2}>{t("إجمالي الميزانية", "Total budget")}</td><td className="n"><Money v={total} currency={null} /></td><td /></tr>
            <tr><td colSpan={2} className="muted">{t("التكلفة الفعلية حتى الآن", "Actual cost so far")}{total > 0 && ` (${Math.round(Number(actualCost || 0) / total * 100)}%)`}</td>
              <td className={`n ${Number(actualCost) > total ? "neg" : ""}`}><Money v={actualCost} currency={null} /></td><td /></tr></tfoot>
        </table></div>
        {manage && <form onSubmit={addLine} noValidate style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
          <Issues issues={add.issues} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label={t("الفئة", "Category")}><Select value={row.category} onChange={(v) => setRow({ ...row, category: v || "materials" })} options={BUDGET_CATS(t)} /></Field>
            <Field label={t("الوصف", "Description")} invalid={add.has("description")} wide><input value={row.description} placeholder={t("مثال: حديد تسليح للهيكل", "e.g. Rebar for the structure")} onChange={(e) => setRow({ ...row, description: e.target.value })} /></Field>
            <Field label={t("قيمة التكلفة", "Cost")} invalid={add.has("amount")}><input className="num" type="number" step="0.01" value={row.amount} onChange={(e) => setRow({ ...row, amount: e.target.value })} /></Field>
            <button className="btn primary" disabled={busy}>{t("+ إضافة البند", "+ Add line")}</button>
          </div>
        </form>}
      </Panel>

      {reqs.length > 0 && <Panel pad={false} title={t("طلبات تعديل الميزانية", "Budget change requests")}>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>{t("التعديل", "Change")}</th><th>{t("السبب", "Reason")}</th><th>{t("الطالب", "Requested by")}</th><th>{t("الحالة", "Status")}</th><th /></tr></thead>
          <tbody>{reqs.map((r) => (
            <tr key={r.id}>
              <td>{describe(r)}</td><td>{r.reason}</td>
              <td>{r.requested_name || "—"}<div className="muted" style={{ fontSize: 12 }}>{String(r.requested_at).slice(0, 10)}</div></td>
              <td><StatusBadge status={r.status} />{r.decision_note && <div className="muted" style={{ fontSize: 12 }}>{r.decided_name ? `${r.decided_name}: ` : ""}{r.decision_note}</div>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{r.status === "pending" && approver && <>
                <button className="btn sm primary" onClick={() => { dec.clear(); setDeciding({ request: r, approve: true, note: "" }); }}>{t("اعتماد", "Approve")}</button>{" "}
                <button className="btn sm danger" onClick={() => { dec.clear(); setDeciding({ request: r, approve: false, note: "" }); }}>{t("رفض", "Reject")}</button></>}</td>
            </tr>))}</tbody>
        </table></div>
      </Panel>}

      {change && <Modal title={approver ? t("تعديل بند الميزانية", "Edit budget line") : t("طلب تعديل بند الميزانية", "Request a budget change")} onClose={() => setChange(null)}
        footer={<><button className="btn" onClick={() => setChange(null)}>{t("إلغاء", "Cancel")}</button>
          <button className={`btn ${change.action === "delete" ? "danger" : "primary"}`} form="bch" disabled={busy}>{approver ? t("تطبيق", "Apply") : t("إرسال للاعتماد", "Send for approval")}</button></>}>
        <form id="bch" onSubmit={sendChange} noValidate>
          {!approver && <div className="alert">{t("يبقى البند كما هو حتى يعتمد مدير النظام طلبك.", "The line stays as it is until the administrator approves.")}</div>}
          <Issues issues={ch.issues} />
          <div className="form">
            <Field label={t("نوع التعديل", "Change")}><Select value={change.action} onChange={(v) => setChange({ ...change, action: v || "update" })}
              options={[{ id: "update", label: t("تعديل البند", "Change the line") }, { id: "delete", label: t("حذف البند", "Delete the line") }]} /></Field>
            {change.action === "update" && <>
              <Field label={t("الفئة", "Category")}><Select value={change.category} onChange={(v) => setChange({ ...change, category: v || change.category })} options={BUDGET_CATS(t)} /></Field>
              <Field label={t("الوصف", "Description")} wide><input value={change.description} onChange={(e) => setChange({ ...change, description: e.target.value })} /></Field>
              <Field label={t("قيمة التكلفة الجديدة", "New cost")} invalid={ch.has("amount")} hint={t(`الحالية: ${Number(change.line.amount).toLocaleString("en-US")}`, `Current: ${Number(change.line.amount).toLocaleString("en-US")}`)}>
                <input className="num" type="number" step="0.01" value={change.amount} onChange={(e) => setChange({ ...change, amount: e.target.value })} /></Field>
            </>}
            <Field label={t("سبب التعديل", "Reason")} required wide invalid={ch.has("reason")}><textarea rows={2} value={change.reason} onChange={(e) => setChange({ ...change, reason: e.target.value })} /></Field>
          </div>
        </form>
      </Modal>}

      {deciding && <Modal title={deciding.approve ? t("اعتماد تعديل الميزانية", "Approve budget change") : t("رفض تعديل الميزانية", "Reject budget change")} onClose={() => setDeciding(null)}
        footer={<><button className="btn" onClick={() => setDeciding(null)}>{t("إلغاء", "Cancel")}</button>
          <button className={`btn ${deciding.approve ? "primary" : "danger"}`} form="bdec" disabled={busy}>{deciding.approve ? t("اعتماد وتطبيق", "Approve and apply") : t("رفض", "Reject")}</button></>}>
        <form id="bdec" onSubmit={decide} noValidate>
          <p>{describe(deciding.request)}</p><p className="muted">{t("السبب:", "Reason:")} {deciding.request.reason}</p>
          <Issues issues={dec.issues} />
          <Field label={deciding.approve ? t("ملاحظة (اختياري)", "Note (optional)") : t("سبب الرفض", "Reason for rejecting")} required={!deciding.approve} wide invalid={dec.has("note")}>
            <textarea rows={2} value={deciding.note} onChange={(e) => setDeciding({ ...deciding, note: e.target.value })} /></Field>
        </form>
      </Modal>}
    </>
  );
}
