import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, StatusBadge, Modal, Field, Select, go, goBack, confirmDialog, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { today, downloadCsv, num } from "../lib/format.js";

const RUN_TYPES = (t) => [
  { id: "regular", label: t("رواتب شهرية", "Monthly salaries") }, { id: "overtime", label: t("عمل إضافي", "Overtime") },
  { id: "bonus", label: t("مكافآت", "Bonuses") }, { id: "other", label: t("أخرى", "Other") }];
export const runLabel = (r, t) => (r.run_type === "other" && r.title ? r.title
  : `${RUN_TYPES(t).find((x) => x.id === (r.run_type || "regular"))?.label}${r.title ? ` — ${r.title}` : ""}`);

export function PayrollRuns() {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [extra, setExtra] = useState(null);
  const list = useData(() => run(supabase.from("payroll_runs").select("*").order("period", { ascending: false }).order("created_at", { ascending: false })), []);
  const depts = useData(() => L.departments().catch(() => []), []);
  async function generate() {
    const out = [];
    if (!/^\d{4}-\d{2}$/.test(period || "")) out.push(t("اختر شهر المسيّر", "Choose the payroll month"));
    else if ((list.data || []).some((r) => r.period === period && (r.run_type || "regular") === "regular")) out.push(t(`يوجد مسيّر رواتب لشهر ${period} مسبقاً — افتحه من القائمة أدناه، أو أنشئ «مسيّراً إضافياً» للعمل الإضافي والمكافآت`, `A salary run for ${period} already exists — open it below, or create an extra run for overtime and bonuses`));
    if (!iss.check(out)) return;
    if (!await confirmDialog(t(`إعداد مسيّر رواتب شهر ${period} لكل الموظفين على رأس العمل؟\nيُحسب تلقائياً من الرواتب والأيام الفعلية والإجازات والتأمينات.`, `Prepare the ${period} salary run for everyone in service?`))) return;
    const id = await act(() => rpc("generate_payroll", { p_period: period }), t("تم إعداد مسيّر الرواتب كمسودة\nراجع الأسطر وأضف الإضافي أو الخصومات، ثم «اعتماد».", "Payroll prepared"));
    if (id) go(`/payroll/${id}`);
  }
  async function createExtra(e) {
    e.preventDefault();
    if (!iss.check([
      !/^\d{4}-\d{2}$/.test(extra.period || "") && { key: "period", msg: t("اختر الشهر", "Choose the month") },
      extra.run_type === "other" && !String(extra.title || "").trim() && { key: "title", msg: t("اكتب اسم المسيّر (مثال: بدل تذاكر)", "Enter a title (e.g. Ticket allowance)") },
      extra.scope === "dept" && !extra.department_id && { key: "department_id", msg: t("اختر القسم", "Choose the department") },
    ])) return;
    const id = await act(async () => {
      let emps = null;
      if (extra.scope === "none") emps = [];
      if (extra.scope === "dept") emps = (await run(supabase.from("employees").select("id").eq("department_id", extra.department_id))).map((x) => x.id);
      return rpc("create_extra_payroll", { p_period: extra.period, p_type: extra.run_type, p_title: extra.title || null, p_employees: emps });
    }, t("تم إنشاء المسيّر الإضافي\nأدخل المبالغ لكل موظف، واحذف من لا يستحق، ثم «اعتماد».", "Extra run created"));
    if (id) go(`/payroll/${id}`);
  }
  return (
    <>
      <PageHead title={t("مسيّرات الرواتب", "Payroll runs")} sub={t("يحسب الأيام الفعلية والإجازات بدون راتب والتأمينات الاجتماعية تلقائياً", "Computes worked days, unpaid leave and GOSI automatically")}>
        {can("payroll.manage") && <>
          <input type="month" style={{ width: 170 }} value={period} onChange={(e) => setPeriod(e.target.value)} />
          <button className="btn primary" onClick={generate} disabled={busy}>{t("إعداد مسيّر الرواتب", "Prepare salary run")}</button>
          <button className="btn" onClick={() => { iss.clear(); setExtra({ period, run_type: "overtime", scope: "all" }); }}>{t("+ مسيّر إضافي", "+ Extra run")}</button></>}
      </PageHead>
      {!extra && <Issues issues={iss.issues} />}
      {extra && <Modal title={t("مسيّر إضافي (عمل إضافي، مكافآت، أخرى)", "Extra run (overtime, bonuses, other)")} onClose={() => { setExtra(null); iss.clear(); }}
        footer={<><button className="btn" onClick={() => setExtra(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="xr" disabled={busy}>{t("إنشاء", "Create")}</button></>}>
        <form id="xr" onSubmit={createExtra} noValidate>
          <div className="alert">{t("المسيّر الإضافي يُصرف بجانب مسيّر الرواتب ويمكن إنشاء أكثر من واحد في الشهر. فيه المبالغ التي تدخلها فقط، بدون راتب أساسي ولا تأمينات.",
            "An extra run is paid alongside the salary run and you can create several a month. It holds only the amounts you enter — no basic pay, no GOSI.")}</div>
          <Issues issues={iss.issues} />
          <div className="form">
            <Field label={t("النوع", "Type")} required><Select value={extra.run_type} onChange={(v) => setExtra({ ...extra, run_type: v || "overtime" })} options={RUN_TYPES(t).slice(1)} /></Field>
            <Field label={t("الشهر", "Month")} required invalid={iss.has("period")}><input type="month" value={extra.period} onChange={(e) => setExtra({ ...extra, period: e.target.value })} /></Field>
            <Field label={t("اسم المسيّر", "Title")} required={extra.run_type === "other"} invalid={iss.has("title")} hint={t("مثال: مكافأة نهاية المشروع، بدل تذاكر", "e.g. Project completion bonus")}>
              <input value={extra.title || ""} onChange={(e) => setExtra({ ...extra, title: e.target.value })} /></Field>
            <Field label={t("الموظفون", "Employees")}><Select value={extra.scope} onChange={(v) => setExtra({ ...extra, scope: v || "all" })} options={[
              { id: "all", label: t("كل الموظفين على رأس العمل", "Everyone in service") },
              ...((depts.data || []).length ? [{ id: "dept", label: t("موظفو قسم معيّن", "One department") }] : []),
              { id: "none", label: t("بدون — أضيفهم واحداً واحداً", "None — add them one by one") }]} /></Field>
            {extra.scope === "dept" && <Field label={t("القسم", "Department")} required invalid={iss.has("department_id")}>
              <Select value={extra.department_id} onChange={(v) => setExtra({ ...extra, department_id: v })} options={depts.data || []} /></Field>}
          </div>
        </form>
      </Modal>}
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => go(`/payroll/${r.id}`)} columns={[
          { key: "period", label: t("الشهر", "Period"), render: (r) => <span className="mono">{r.period}</span> },
          { key: "type", label: t("النوع", "Type"), render: (r) => runLabel(r, t) },
          { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
          { key: "employees_count", label: t("الموظفون", "Employees"), type: "num" },
          { key: "total_gross", label: t("الإجمالي", "Gross"), type: "money" },
          { key: "total_gosi_employer", label: t("تأمينات المنشأة", "Employer GOSI"), type: "money" },
          { key: "total_net", label: t("الصافي", "Net"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
        ]} />
      </Panel>
    </>
  );
}

export function PayrollRun({ params }) {
  const { t, can, org } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const [changes, setChanges] = useState({});
  const [adding, setAdding] = useState(null);
  const emps = useData(() => L.employees().catch(() => []), []);
  const d = useData(async () => ({
    run: await run(supabase.from("payroll_runs").select("*").eq("id", params.id).single()),
    lines: await run(supabase.from("payroll_lines").select("*, employees(code, first_name_ar, last_name_ar, national_id, employee_pay(iban, bank_name)), projects(name_ar)").eq("run_id", params.id)),
  }), [params.id]);
  if (!d.data) return <Loading />;
  const r = d.data.run;
  const lines = [...d.data.lines].sort((a, b) => a.employees.code.localeCompare(b.employees.code));
  const draft = r.status === "draft" && can("payroll.manage");
  const extraRun = (r.run_type || "regular") !== "regular";
  const amountKey = r.run_type === "overtime" ? "overtime" : "additions";
  const val = (l, k) => changes[l.id]?.[k] ?? l[k];
  const set = (l, k, v) => setChanges({ ...changes, [l.id]: { ...changes[l.id], [k]: v } });
  const net = (l) => Number(l.basic) + Number(l.housing) + Number(l.transport) + Number(l.other_allowances) + Number(val(l, "overtime") || 0) + Number(val(l, "additions") || 0)
    - Number(l.gosi_employee) - Number(val(l, "advance_deduction") || 0) - Number(val(l, "other_deductions") || 0);

  async function saveChanges() {
    for (const [id, patch] of Object.entries(changes)) {
      const p = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Number(v || 0)]));
      await run(supabase.from("payroll_lines").update(p).eq("id", id));
    }
  }
  const reload = () => { setChanges({}); d.reload(); };
  function problems() {
    if (!lines.length) return [t("المسيّر لا يحتوي على موظفين — أضف موظفاً واحداً على الأقل", "The run has no employees — add at least one")];
    const empty = extraRun ? lines.filter((l) => !(Number(val(l, amountKey)) > 0)).map((l) => ({ key: l.id,
      msg: t(`${l.employees.first_name_ar} ${l.employees.last_name_ar}: أدخل المبلغ أو احذفه من المسيّر`, `${l.employees.first_name_ar} ${l.employees.last_name_ar}: enter an amount or remove them from the run`) })) : [];
    return [...empty, ...lines.filter((l) => net(l) < 0).map((l) => ({ key: l.id,
      msg: t(`${l.employees.first_name_ar} ${l.employees.last_name_ar}: صافي الراتب سالب (${num(net(l))}) — قلّل الخصومات أو السلف`,
             `${l.employees.first_name_ar} ${l.employees.last_name_ar}: net pay is negative — reduce deductions`) }))];
  }
  async function removeLine(l) {
    if (!await confirmDialog(t(`إزالة ${l.employees.first_name_ar} ${l.employees.last_name_ar} من هذا المسيّر؟`, `Remove ${l.employees.first_name_ar} ${l.employees.last_name_ar} from this run?`))) return;
    if (await act(async () => { await saveChanges(); await run(supabase.from("payroll_lines").delete().eq("id", l.id)); return true; }, t("أُزيل من المسيّر", "Removed from the run"))) reload();
  }
  async function addEmployee() {
    if (!adding) { iss.check([t("اختر الموظف المراد إضافته", "Choose the employee to add")]); return; }
    if (await act(async () => { await saveChanges(); await rpc("add_payroll_employee", { p_run: r.id, p_employee: adding }); return true; }, t("أُضيف إلى المسيّر", "Added to the run"))) { setAdding(null); reload(); }
  }
  const inRun = new Set(lines.map((l) => l.employee_id));
  async function onSave() { if (!iss.check(problems())) return; if (await act(async () => { await saveChanges(); return true; }, t("تم الحفظ", "Saved"))) reload(); }
  async function onApprove() {
    if (!iss.check(problems())) return;
    if (!await confirmDialog(t(`اعتماد المسيّر (${lines.length} موظف، صافي ${num(tot("net"))})؟\nبعد الاعتماد لا يمكن تعديل الأسطر.`, `Approve this run (${lines.length} employees)? Lines can't be edited afterwards.`))) return;
    if (await act(async () => { await saveChanges(); await rpc("approve_payroll", { p_run: r.id }); return true; },
      t("تم اعتماد المسيّر\nالخطوة التالية: «ترحيل للمحاسبة»، ويمكنك تنزيل ملف التحويل البنكي.", "Approved"))) reload();
  }
  async function onPost() {
    if (!await confirmDialog(t(`ترحيل المسيّر للمحاسبة؟\nيُنشأ قيد الرواتب والتأمينات المستحقة (صافي ${num(r.total_net)}).`, "Post payroll to the ledger?"))) return;
    if (await act(async () => { await rpc("post_payroll", { p_run: r.id }); return true; }, t("تم ترحيل المسيّر للمحاسبة\nأُنشئ القيد. الخطوة التالية: سند صرف الرواتب عند التحويل.", "Payroll posted"))) reload();
  }
  async function onDelete() {
    if (!await confirmDialog(t("حذف المسيّر (مسودة)؟", "Delete draft payroll?"))) return;
    if (await act(async () => { await run(supabase.from("payroll_runs").delete().eq("id", r.id)); return true; })) go("/payroll");
  }
  const payOf = (e) => (Array.isArray(e?.employee_pay) ? e.employee_pay[0] : e?.employee_pay);
  // bank / WPS transfer sheet (review with your bank's exact template before upload)
  const exportBank = () => downloadCsv(`payroll-${r.period}-bank.csv`, lines, [
    { label: "Employee No", value: (l) => l.employees.code }, { label: "Name", value: (l) => `${l.employees.first_name_ar} ${l.employees.last_name_ar}` },
    { label: "National ID / Iqama", value: (l) => l.employees.national_id || "" }, { label: "Bank", value: (l) => payOf(l.employees)?.bank_name || "" },
    { label: "IBAN", value: (l) => payOf(l.employees)?.iban || "" }, { label: "Basic", value: (l) => num(l.basic) }, { label: "Housing", value: (l) => num(l.housing) },
    { label: "Other earnings", value: (l) => num(Number(l.transport) + Number(l.other_allowances) + Number(l.overtime) + Number(l.additions)) },
    { label: "Deductions", value: (l) => num(Number(l.gosi_employee) + Number(l.advance_deduction) + Number(l.other_deductions)) },
    { label: "Net", value: (l) => num(l.net) }, { label: "Payer", value: () => org.name_ar },
  ]);
  const tot = (k) => lines.reduce((n, l) => n + Number(k === "net" ? net(l) : val(l, k) || 0), 0);
  const Num = ({ l, k }) => draft
    ? <input className="num" type="number" step="0.01" min="0" style={{ width: 95 }} value={val(l, k)} onChange={(e) => set(l, k, e.target.value)} />
    : <Money v={l[k]} currency={null} />;

  return (
    <>
      <PageHead title={`${t("مسيّر", "Payroll")} ${runLabel(r, t)} — ${r.period}`} sub={<span className="row"><StatusBadge status={r.status} />{r.number && <span className="mono">{r.number}</span>}</span>}>
        <button className="btn" onClick={() => goBack("/payroll")}>{t("رجوع", "Back")}</button>
        {draft && <button className="btn danger" onClick={onDelete} disabled={busy}>{t("حذف", "Delete")}</button>}
        {draft && <button className="btn" onClick={onSave} disabled={busy || !Object.keys(changes).length}>{t("حفظ التعديلات", "Save changes")}</button>}
        {r.status === "draft" && can("payroll.approve") && <button className="btn primary" onClick={onApprove} disabled={busy}>{t("اعتماد", "Approve")}</button>}
        {r.status === "approved" && can("payroll.approve") && <button className="btn primary" onClick={onPost} disabled={busy}>{t("ترحيل للمحاسبة", "Post to ledger")}</button>}
        {r.status !== "draft" && <button className="btn" onClick={exportBank}>{t("ملف التحويل البنكي", "Bank transfer file")}</button>}
        {r.journal_entry_id && <a className="btn" href={`#/accounting/journals/${r.journal_entry_id}`}>{t("القيد", "Journal")}</a>}
        {r.status === "posted" && can("finance.manage") && <a className="btn" href="#/finance/payments">{t("سند صرف الرواتب", "Salary payment voucher")}</a>}
      </PageHead>
      <Issues issues={iss.issues} />
      <div className="grid k4" style={{ marginBottom: 16 }}>
        <div className="panel kpi"><div className="l">{t("عدد الموظفين", "Employees")}</div><div className="v">{r.employees_count}</div></div>
        <div className="panel kpi"><div className="l">{t("إجمالي الرواتب", "Gross")}</div><div className="v"><Money v={r.total_gross} /></div></div>
        <div className="panel kpi"><div className="l">{t("التأمينات (موظف + منشأة)", "GOSI (employee + employer)")}</div><div className="v"><Money v={Number(r.total_gosi_employee) + Number(r.total_gosi_employer)} /></div></div>
        <div className="panel kpi"><div className="l">{t("صافي المستحق", "Net pay")}</div><div className="v"><Money v={r.total_net} /></div></div>
      </div>
      {draft && <div className="row no-print" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 300 }}><Select value={adding} onChange={setAdding} placeholder={t("— إضافة موظف للمسيّر —", "— Add an employee —")}
          options={(emps.data || []).filter((e) => !inRun.has(e.id) && e.status !== "terminated")} /></div>
        <button className="btn" onClick={addEmployee} disabled={busy}>{t("+ إضافة", "+ Add")}</button>
        <span className="muted" style={{ fontSize: 12 }}>{t("لإزالة موظف اضغط ✕ في سطره", "Click ✕ on a line to remove that employee")}</span>
      </div>}
      {extraRun ? <Panel pad={false}>
        <div className="tbl-wrap"><table className={`tbl ${draft ? "edit" : ""}`}>
          <thead><tr><th>{t("الموظف", "Employee")}</th><th className="n">{r.run_type === "overtime" ? t("مبلغ العمل الإضافي", "Overtime") : r.run_type === "bonus" ? t("المكافأة", "Bonus") : t("المبلغ", "Amount")}</th>
            <th className="n">{t("خصومات", "Deductions")}</th><th className="n">{t("الصافي", "Net")}</th>{draft && <th />}</tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} className={iss.has(l.id) ? "invalid" : ""}>
              <td>{l.employees.code} — {l.employees.first_name_ar} {l.employees.last_name_ar}{l.projects && <div className="muted" style={{ fontSize: 12 }}>{l.projects.name_ar}</div>}</td>
              <td className="n"><Num l={l} k={amountKey} /></td><td className="n"><Num l={l} k="other_deductions" /></td>
              <td className="n" style={{ fontWeight: 600 }}><Money v={draft ? net(l) : l.net} currency={null} /></td>
              {draft && <td><button className="btn ghost sm" title={t("إزالة من المسيّر", "Remove")} onClick={() => removeLine(l)} disabled={busy}>✕</button></td>}
            </tr>))}</tbody>
          <tfoot><tr><td>{t("الإجمالي", "Total")}</td><td className="n"><Money v={tot(amountKey)} currency={null} /></td>
            <td className="n"><Money v={tot("other_deductions")} currency={null} /></td><td className="n"><Money v={draft ? tot("net") : r.total_net} currency={null} /></td>{draft && <td />}</tr></tfoot>
        </table></div>
      </Panel> : <Panel pad={false}>
        <div className="tbl-wrap"><table className={`tbl ${draft ? "edit" : ""}`}>
          <thead><tr><th>{t("الموظف", "Employee")}</th><th className="n">{t("الأيام", "Days")}</th><th className="n">{t("الأساسي", "Basic")}</th><th className="n">{t("السكن", "Housing")}</th>
            <th className="n">{t("بدلات أخرى", "Allowances")}</th><th className="n">{t("إضافي", "Overtime")}</th><th className="n">{t("مكافآت", "Additions")}</th>
            <th className="n">{t("تأمينات الموظف", "GOSI emp.")}</th><th className="n">{t("سلف", "Advances")}</th><th className="n">{t("خصومات", "Deductions")}</th>
            <th className="n">{t("الصافي", "Net")}</th><th className="n">{t("تأمينات المنشأة", "GOSI empr.")}</th>{draft && <th />}</tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} className={iss.has(l.id) ? "invalid" : ""}>
              <td>{l.employees.code} — {l.employees.first_name_ar} {l.employees.last_name_ar}{l.projects && <div className="muted" style={{ fontSize: 12 }}>{l.projects.name_ar}</div>}</td>
              <td className="n">{Number(l.worked_days)}{Number(l.unpaid_days) > 0 && <div className="neg" style={{ fontSize: 11 }}>−{Number(l.unpaid_days)}</div>}</td>
              <td className="n"><Money v={l.basic} currency={null} /></td><td className="n"><Money v={l.housing} currency={null} /></td>
              <td className="n"><Money v={Number(l.transport) + Number(l.other_allowances)} currency={null} /></td>
              <td className="n"><Num l={l} k="overtime" /></td><td className="n"><Num l={l} k="additions" /></td>
              <td className="n"><Money v={l.gosi_employee} currency={null} /></td>
              <td className="n"><Num l={l} k="advance_deduction" /></td><td className="n"><Num l={l} k="other_deductions" /></td>
              <td className="n" style={{ fontWeight: 600 }}><Money v={draft ? net(l) : l.net} currency={null} /></td>
              <td className="n muted"><Money v={l.gosi_employer} currency={null} /></td>
              {draft && <td><button className="btn ghost sm" title={t("إزالة من المسيّر", "Remove")} onClick={() => removeLine(l)} disabled={busy}>✕</button></td>}
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={5}>{t("الإجمالي", "Total")}</td>
            <td className="n"><Money v={tot("overtime")} currency={null} /></td><td className="n"><Money v={tot("additions")} currency={null} /></td>
            <td className="n"><Money v={r.total_gosi_employee} currency={null} /></td>
            <td className="n"><Money v={tot("advance_deduction")} currency={null} /></td><td className="n"><Money v={tot("other_deductions")} currency={null} /></td>
            <td className="n"><Money v={draft ? tot("net") : r.total_net} currency={null} /></td><td className="n"><Money v={r.total_gosi_employer} currency={null} /></td>{draft && <td />}</tr></tfoot>
        </table></div>
      </Panel>}
    </>
  );
}
