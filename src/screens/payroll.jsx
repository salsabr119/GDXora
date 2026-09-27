import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, useAction, PageHead, Panel, Table, Money, StatusBadge, go, Loading } from "../ui.jsx";
import { today, downloadCsv, num } from "../lib/format.js";

export function PayrollRuns() {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const [period, setPeriod] = useState(today().slice(0, 7));
  const list = useData(() => run(supabase.from("payroll_runs").select("*").order("period", { ascending: false })), []);
  async function generate() {
    const id = await act(() => rpc("generate_payroll", { p_period: period }), t("تم إعداد المسيّر", "Payroll prepared"));
    if (id) go(`/payroll/${id}`);
  }
  return (
    <>
      <PageHead title={t("مسيّرات الرواتب", "Payroll runs")} sub={t("يحسب الأيام الفعلية والإجازات بدون راتب والتأمينات الاجتماعية تلقائياً", "Computes worked days, unpaid leave and GOSI automatically")}>
        {can("payroll.manage") && <>
          <input type="month" style={{ width: 170 }} value={period} onChange={(e) => setPeriod(e.target.value)} />
          <button className="btn primary" onClick={generate} disabled={busy || !period}>{t("إعداد مسيّر الشهر", "Prepare payroll")}</button></>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => go(`/payroll/${r.id}`)} columns={[
          { key: "period", label: t("الشهر", "Period"), render: (r) => <span className="mono">{r.period}</span> },
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
  const [changes, setChanges] = useState({});
  const d = useData(async () => ({
    run: await run(supabase.from("payroll_runs").select("*").eq("id", params.id).single()),
    lines: await run(supabase.from("payroll_lines").select("*, employees(code, first_name_ar, last_name_ar, national_id, iban, bank_name), projects(name_ar)").eq("run_id", params.id)),
  }), [params.id]);
  if (!d.data) return <Loading />;
  const r = d.data.run;
  const lines = [...d.data.lines].sort((a, b) => a.employees.code.localeCompare(b.employees.code));
  const draft = r.status === "draft" && can("payroll.manage");
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
  async function onSave() { if (await act(async () => { await saveChanges(); return true; }, t("تم الحفظ", "Saved"))) reload(); }
  async function onApprove() { if (await act(async () => { await saveChanges(); await rpc("approve_payroll", { p_run: r.id }); return true; }, t("تم الاعتماد", "Approved"))) reload(); }
  async function onPost() {
    if (!window.confirm(t("ترحيل المسيّر للمحاسبة؟", "Post payroll to the ledger?"))) return;
    if (await act(async () => { await rpc("post_payroll", { p_run: r.id }); return true; }, t("تم ترحيل الرواتب", "Payroll posted"))) reload();
  }
  async function onDelete() {
    if (!window.confirm(t("حذف المسيّر (مسودة)؟", "Delete draft payroll?"))) return;
    if (await act(async () => { await run(supabase.from("payroll_runs").delete().eq("id", r.id)); return true; })) go("/payroll");
  }
  // bank / WPS transfer sheet (review with your bank's exact template before upload)
  const exportBank = () => downloadCsv(`payroll-${r.period}-bank.csv`, lines, [
    { label: "Employee No", value: (l) => l.employees.code }, { label: "Name", value: (l) => `${l.employees.first_name_ar} ${l.employees.last_name_ar}` },
    { label: "National ID / Iqama", value: (l) => l.employees.national_id || "" }, { label: "Bank", value: (l) => l.employees.bank_name || "" },
    { label: "IBAN", value: (l) => l.employees.iban || "" }, { label: "Basic", value: (l) => num(l.basic) }, { label: "Housing", value: (l) => num(l.housing) },
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
      <PageHead title={`${t("مسيّر رواتب", "Payroll")} ${r.period}`} sub={<span className="row"><StatusBadge status={r.status} />{r.number && <span className="mono">{r.number}</span>}</span>}>
        <button className="btn" onClick={() => go("/payroll")}>{t("رجوع", "Back")}</button>
        {draft && <button className="btn danger" onClick={onDelete} disabled={busy}>{t("حذف", "Delete")}</button>}
        {draft && <button className="btn" onClick={onSave} disabled={busy || !Object.keys(changes).length}>{t("حفظ التعديلات", "Save changes")}</button>}
        {r.status === "draft" && can("payroll.approve") && <button className="btn primary" onClick={onApprove} disabled={busy}>{t("اعتماد", "Approve")}</button>}
        {r.status === "approved" && can("payroll.approve") && <button className="btn primary" onClick={onPost} disabled={busy}>{t("ترحيل للمحاسبة", "Post to ledger")}</button>}
        {r.status !== "draft" && <button className="btn" onClick={exportBank}>{t("ملف التحويل البنكي", "Bank transfer file")}</button>}
        {r.journal_entry_id && <a className="btn" href={`#/accounting/journals/${r.journal_entry_id}`}>{t("القيد", "Journal")}</a>}
        {r.status === "posted" && can("finance.manage") && <a className="btn" href="#/finance/payments">{t("سند صرف الرواتب", "Salary payment voucher")}</a>}
      </PageHead>
      <div className="grid k4" style={{ marginBottom: 16 }}>
        <div className="panel kpi"><div className="l">{t("عدد الموظفين", "Employees")}</div><div className="v">{r.employees_count}</div></div>
        <div className="panel kpi"><div className="l">{t("إجمالي الرواتب", "Gross")}</div><div className="v"><Money v={r.total_gross} /></div></div>
        <div className="panel kpi"><div className="l">{t("التأمينات (موظف + منشأة)", "GOSI (employee + employer)")}</div><div className="v"><Money v={Number(r.total_gosi_employee) + Number(r.total_gosi_employer)} /></div></div>
        <div className="panel kpi"><div className="l">{t("صافي المستحق", "Net pay")}</div><div className="v"><Money v={r.total_net} /></div></div>
      </div>
      <Panel pad={false}>
        <div className="tbl-wrap"><table className={`tbl ${draft ? "edit" : ""}`}>
          <thead><tr><th>{t("الموظف", "Employee")}</th><th className="n">{t("الأيام", "Days")}</th><th className="n">{t("الأساسي", "Basic")}</th><th className="n">{t("السكن", "Housing")}</th>
            <th className="n">{t("بدلات أخرى", "Allowances")}</th><th className="n">{t("إضافي", "Overtime")}</th><th className="n">{t("مكافآت", "Additions")}</th>
            <th className="n">{t("تأمينات الموظف", "GOSI emp.")}</th><th className="n">{t("سلف", "Advances")}</th><th className="n">{t("خصومات", "Deductions")}</th>
            <th className="n">{t("الصافي", "Net")}</th><th className="n">{t("تأمينات المنشأة", "GOSI empr.")}</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id}>
              <td>{l.employees.code} — {l.employees.first_name_ar} {l.employees.last_name_ar}{l.projects && <div className="muted" style={{ fontSize: 12 }}>{l.projects.name_ar}</div>}</td>
              <td className="n">{Number(l.worked_days)}{Number(l.unpaid_days) > 0 && <div className="neg" style={{ fontSize: 11 }}>−{Number(l.unpaid_days)}</div>}</td>
              <td className="n"><Money v={l.basic} currency={null} /></td><td className="n"><Money v={l.housing} currency={null} /></td>
              <td className="n"><Money v={Number(l.transport) + Number(l.other_allowances)} currency={null} /></td>
              <td className="n"><Num l={l} k="overtime" /></td><td className="n"><Num l={l} k="additions" /></td>
              <td className="n"><Money v={l.gosi_employee} currency={null} /></td>
              <td className="n"><Num l={l} k="advance_deduction" /></td><td className="n"><Num l={l} k="other_deductions" /></td>
              <td className="n" style={{ fontWeight: 600 }}><Money v={draft ? net(l) : l.net} currency={null} /></td>
              <td className="n muted"><Money v={l.gosi_employer} currency={null} /></td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={5}>{t("الإجمالي", "Total")}</td>
            <td className="n"><Money v={tot("overtime")} currency={null} /></td><td className="n"><Money v={tot("additions")} currency={null} /></td>
            <td className="n"><Money v={r.total_gosi_employee} currency={null} /></td>
            <td className="n"><Money v={tot("advance_deduction")} currency={null} /></td><td className="n"><Money v={tot("other_deductions")} currency={null} /></td>
            <td className="n"><Money v={draft ? tot("net") : r.total_net} currency={null} /></td><td className="n"><Money v={r.total_gosi_employer} currency={null} /></td></tr></tfoot>
        </table></div>
      </Panel>
    </>
  );
}
