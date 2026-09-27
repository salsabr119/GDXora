import { useMemo, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { Resource } from "../crud.jsx";
import { useApp, useData, useAction, PageHead, Panel, Table, Money, DateText, StatusBadge, Field, Badge, go, useName, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { today, downloadCsv, num } from "../lib/format.js";

const TYPES = (t) => [
  { id: "asset", label: t("أصول", "Asset") }, { id: "liability", label: t("التزامات", "Liability") },
  { id: "equity", label: t("حقوق ملكية", "Equity") }, { id: "revenue", label: t("إيرادات", "Revenue") },
  { id: "expense", label: t("مصروفات", "Expense") },
];

/* ── chart of accounts ───────────────────────────────────────────────── */
export function Accounts() {
  const { t } = useApp();
  const types = TYPES(t);
  const typeLabel = Object.fromEntries(types.map((x) => [x.id, x.label]));
  return <Resource cfg={{
    table: "accounts", title: t("دليل الحسابات", "Chart of accounts"),
    sub: t("الحسابات الرئيسية (تجميعية) لا يُرحّل عليها — الحسابات المرتبطة بالنظام تستخدمها العمليات تلقائياً",
           "Group accounts can't be posted to — system-linked accounts are used automatically by the modules"),
    order: "code.asc", managePerm: "accounting.manage", search: ["code", "name_ar", "name_en"],
    loadLookups: async () => ({ groups: await L.accounts({ postable: false }).then((a) => a.filter((x) => x.is_group)) }),
    defaults: { type: "expense", is_group: false, is_cash: false, active: true },
    columns: [
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono" style={{ paddingInlineStart: (r.code.length - 1) * 10 }}>{r.code}</span> },
      { key: "name_ar", label: t("اسم الحساب", "Account"), render: (r) => <span style={{ fontWeight: r.is_group ? 700 : 400 }}>{r.name_ar}</span> },
      { key: "type", label: t("النوع", "Type"), render: (r) => typeLabel[r.type] },
      { key: "flags", label: "", render: (r) => <span className="row">
          {r.is_group && <Badge>{t("رئيسي", "Group")}</Badge>}
          {r.is_cash && <Badge kind="info">{t("نقد/بنك", "Cash/bank")}</Badge>}
          {r.system_key && <Badge kind="ok">{t("مرتبط بالنظام", "System")}</Badge>}
          {!r.active && <Badge kind="bad">{t("موقوف", "Inactive")}</Badge>}</span> },
    ],
    fields: [
      { key: "code", label: t("الرمز", "Code"), required: true, ltr: true },
      { key: "name_ar", label: t("الاسم (عربي)", "Name (Arabic)"), required: true },
      { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
      { key: "type", label: t("النوع", "Type"), type: "select", required: true, options: types },
      { key: "parent_id", label: t("الحساب الأب", "Parent account"), type: "select", options: (lk) => lk.groups || [] },
      { key: "is_group", label: t("حساب رئيسي (تجميعي)", "Group account"), type: "checkbox" },
      { key: "is_cash", label: t("حساب نقدية أو بنك", "Cash / bank account"), type: "checkbox" },
      { key: "active", label: t("نشط", "Active"), type: "checkbox" },
    ],
  }} />;
}

/* ── journal list ────────────────────────────────────────────────────── */
export function Journals() {
  const { t, can } = useApp();
  const [status, setStatus] = useState("");
  const list = useData(() => {
    let q = supabase.from("journal_entries").select("id, number, entry_date, memo, source_type, status, total").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (status) q = q.eq("status", status);
    return run(q);
  }, [status]);
  const src = { manual: t("يدوي", "Manual"), invoice: t("فاتورة", "Invoice"), bill: t("فاتورة مورد", "Bill"),
                payment: t("سند", "Voucher"), payroll: t("رواتب", "Payroll"), reversal: t("عكس", "Reversal") };
  return (
    <>
      <PageHead title={t("القيود اليومية", "Journal entries")} sub={t("القيود الآلية تُنشأ من الفواتير والسندات والرواتب", "Automatic entries come from invoices, vouchers and payroll")}>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("كل الحالات", "All statuses")}</option>
          <option value="draft">{t("مسودة", "Draft")}</option><option value="posted">{t("مُرحّل", "Posted")}</option><option value="reversed">{t("معكوس", "Reversed")}</option>
        </select>
        {can("accounting.manage") && <button className="btn primary" onClick={() => go("/accounting/journals/new")}>{t("+ قيد يدوي", "+ Manual entry")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => go(`/accounting/journals/${r.id}`)} columns={[
          { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
          { key: "entry_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "memo", label: t("البيان", "Memo") },
          { key: "source_type", label: t("المصدر", "Source"), render: (r) => src[r.source_type] || r.source_type },
          { key: "total", label: t("المبلغ", "Amount"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
        ]} />
      </Panel>
    </>
  );
}

/* ── journal editor / viewer ─────────────────────────────────────────── */
const blankLine = () => ({ account_id: null, description: "", debit: "", credit: "", project_id: null });

export function JournalEditor({ params }) {
  const { t, can } = useApp();
  const isNew = params.id === "new";
  const [act, busy] = useAction();
  const lk = useData(async () => ({ accounts: await L.accounts(), projects: await L.projects() }), []);
  const [form, setForm] = useState(isNew ? { entry_date: today(), memo: "", lines: [blankLine(), blankLine()] } : null);
  const entry = useData(async () => {
    if (isNew) return null;
    const e = await run(supabase.from("journal_entries").select("*").eq("id", params.id).single());
    const lines = await run(supabase.from("journal_lines").select("*, accounts(code, name_ar), projects(code, name_ar)").eq("entry_id", params.id).order("line_no"));
    if (e.status === "draft") setForm({ entry_date: e.entry_date, memo: e.memo || "", lines: lines.map((l) => ({ ...l, debit: l.debit || "", credit: l.credit || "" })) });
    return { ...e, lines };
  }, [params.id]);

  const e = entry.data;
  const editable = isNew || e?.status === "draft";
  const lines = form?.lines || [];
  const dr = lines.reduce((n, l) => n + Number(l.debit || 0), 0);
  const cr = lines.reduce((n, l) => n + Number(l.credit || 0), 0);
  const balanced = Math.abs(dr - cr) < 0.005 && dr > 0;

  const setLine = (i, patch) => setForm({ ...form, lines: lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const payload = () => lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit)))
    .map((l) => ({ account_id: l.account_id, description: l.description || null, debit: Number(l.debit || 0), credit: Number(l.credit || 0), project_id: l.project_id || null }));

  async function save(post) {
    const id = await act(async () => {
      if (isNew) return rpc("create_journal", { p_date: form.entry_date, p_memo: form.memo, p_lines: payload(), p_post: post });
      await rpc("update_journal_draft", { p_entry: params.id, p_date: form.entry_date, p_memo: form.memo, p_lines: payload(), p_post: post });
      return params.id;
    }, post ? t("تم ترحيل القيد", "Entry posted") : t("تم حفظ المسودة", "Draft saved"));
    if (id) { if (isNew) go(`/accounting/journals/${id}`); else entry.reload(); }
  }
  async function reverse() {
    if (!window.confirm(t("إنشاء قيد عكسي بتاريخ اليوم؟", "Create a reversing entry dated today?"))) return;
    const id = await act(() => rpc("reverse_journal", { p_entry: params.id, p_date: today() }), t("تم عكس القيد", "Entry reversed"));
    if (id) go(`/accounting/journals/${id}`);
  }
  async function removeDraft() {
    if (!window.confirm(t("حذف المسودة؟", "Delete draft?"))) return;
    const ok = await act(async () => { await run(supabase.from("journal_entries").delete().eq("id", params.id)); return true; });
    if (ok) go("/accounting/journals");
  }

  if (!isNew && !e) return <Loading />;
  const accOpts = lk.data?.accounts || [];
  const prjOpts = lk.data?.projects || [];

  return (
    <>
      <PageHead title={isNew ? t("قيد يدوي جديد", "New manual entry") : `${t("قيد", "Entry")} ${e.number || t("(مسودة)", "(draft)")}`}
                sub={e && <StatusBadge status={e.status} />}>
        <button className="btn" onClick={() => go("/accounting/journals")}>{t("رجوع", "Back")}</button>
        {!isNew && e.status === "draft" && can("accounting.manage") && <button className="btn danger" onClick={removeDraft} disabled={busy}>{t("حذف", "Delete")}</button>}
        {editable && can("accounting.manage") && <button className="btn" onClick={() => save(false)} disabled={busy}>{t("حفظ كمسودة", "Save draft")}</button>}
        {editable && can("accounting.post") && <button className="btn primary" onClick={() => save(true)} disabled={busy || !balanced}>{t("ترحيل", "Post")}</button>}
        {e?.status === "posted" && e.source_type === "manual" && can("accounting.post") && <button className="btn" onClick={reverse} disabled={busy}>{t("عكس القيد", "Reverse")}</button>}
        {e?.reversal_of && <a className="btn" href={`#/accounting/journals/${e.reversal_of}`}>{t("القيد الأصلي", "Original entry")}</a>}
        {e?.reversed_by && <a className="btn" href={`#/accounting/journals/${e.reversed_by}`}>{t("القيد العكسي", "Reversing entry")}</a>}
      </PageHead>

      <Panel>
        <div className="form">
          <Field label={t("التاريخ", "Date")} required>
            {editable ? <input type="date" value={form.entry_date} onChange={(x) => setForm({ ...form, entry_date: x.target.value })} /> : <DateText v={e.entry_date} />}
          </Field>
          <Field label={t("البيان", "Memo")} wide>
            {editable ? <input value={form.memo} onChange={(x) => setForm({ ...form, memo: x.target.value })} /> : <span>{e.memo}</span>}
          </Field>
        </div>
      </Panel>

      <Panel pad={false} title={t("أسطر القيد", "Lines")}>
        <div className="tbl-wrap">
          <table className={`tbl ${editable ? "edit" : ""}`}>
            <thead><tr><th style={{ minWidth: 260 }}>{t("الحساب", "Account")}</th><th>{t("البيان", "Description")}</th><th style={{ minWidth: 180 }}>{t("المشروع", "Project")}</th>
              <th className="n">{t("مدين", "Debit")}</th><th className="n">{t("دائن", "Credit")}</th>{editable && <th />}</tr></thead>
            <tbody>
              {editable ? lines.map((l, i) => (
                <tr key={i}>
                  <td><select value={l.account_id || ""} onChange={(x) => setLine(i, { account_id: x.target.value || null })}>
                    <option value="">—</option>{accOpts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></td>
                  <td><input value={l.description || ""} onChange={(x) => setLine(i, { description: x.target.value })} /></td>
                  <td><select value={l.project_id || ""} onChange={(x) => setLine(i, { project_id: x.target.value || null })}>
                    <option value="">—</option>{prjOpts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></td>
                  <td><input className="num" type="number" step="0.01" min="0" value={l.debit} onChange={(x) => setLine(i, { debit: x.target.value, credit: x.target.value ? "" : l.credit })} /></td>
                  <td><input className="num" type="number" step="0.01" min="0" value={l.credit} onChange={(x) => setLine(i, { credit: x.target.value, debit: x.target.value ? "" : l.debit })} /></td>
                  <td><button className="btn ghost sm" onClick={() => setForm({ ...form, lines: lines.filter((_, j) => j !== i) })} disabled={lines.length <= 2}>✕</button></td>
                </tr>
              )) : e.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.accounts?.code} — {l.accounts?.name_ar}</td><td>{l.description}</td><td>{l.projects?.name_ar || "—"}</td>
                  <td className="n">{Number(l.debit) ? <Money v={l.debit} currency={null} /> : ""}</td>
                  <td className="n">{Number(l.credit) ? <Money v={l.credit} currency={null} /> : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td colSpan={3}>{editable && <button className="btn sm" onClick={() => setForm({ ...form, lines: [...lines, blankLine()] })}>{t("+ سطر", "+ Line")}</button>}
                {editable && !balanced && dr + cr > 0 && <span className="neg" style={{ marginInlineStart: 12 }}>{t("الفرق", "Difference")}: {num(dr - cr)}</span>}</td>
              <td className="n"><Money v={editable ? dr : e.total} currency={null} /></td>
              <td className="n"><Money v={editable ? cr : e.total} currency={null} /></td>{editable && <td />}
            </tr></tfoot>
          </table>
        </div>
      </Panel>
    </>
  );
}

/* ── trial balance ───────────────────────────────────────────────────── */
function DateRange({ from, to, setFrom, setTo, children }) {
  const { t } = useApp();
  return (
    <div className="row">
      <label className="muted">{t("من", "From")}</label><input type="date" style={{ width: 150 }} value={from} onChange={(e) => setFrom(e.target.value)} />
      <label className="muted">{t("إلى", "To")}</label><input type="date" style={{ width: 150 }} value={to} onChange={(e) => setTo(e.target.value)} />
      {children}
    </div>
  );
}

export function TrialBalance() {
  const { t } = useApp();
  const [from, setFrom] = useState(today().slice(0, 4) + "-01-01");
  const [to, setTo] = useState(today());
  const tb = useData(() => rpc("trial_balance", { p_from: from || null, p_to: to || null }), [from, to]);
  const rows = tb.data || [];
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k]), 0);
  const cols = [
    { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code}</span> },
    { key: "name_ar", label: t("الحساب", "Account"), render: (r) => <a href={`#/accounting/ledger?account=${r.account_id}`}>{r.name_ar}</a> },
    { key: "opening", label: t("رصيد افتتاحي", "Opening"), type: "money" },
    { key: "debit", label: t("مدين", "Debit"), type: "money" },
    { key: "credit", label: t("دائن", "Credit"), type: "money" },
    { key: "closing", label: t("الرصيد", "Closing"), type: "money" },
  ];
  return (
    <>
      <PageHead title={t("ميزان المراجعة", "Trial balance")} sub={t("الرصيد الموجب مدين والسالب دائن", "Positive = debit, negative = credit")}>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo}>
          <button className="btn" onClick={() => downloadCsv(`trial-balance-${to}.csv`, rows, cols.map((c) => ({ key: c.key, label: c.label })))}>{t("تصدير Excel", "Export")}</button>
        </DateRange>
      </PageHead>
      <Panel pad={false}>
        <Table rows={rows} loading={tb.loading} columns={cols} footer={<>
          <td colSpan={2}>{t("الإجمالي", "Total")}</td>
          <td className="n"><Money v={sum("opening")} currency={null} /></td>
          <td className="n"><Money v={sum("debit")} currency={null} /></td>
          <td className="n"><Money v={sum("credit")} currency={null} /></td>
          <td className="n"><Money v={sum("closing")} currency={null} /></td></>} />
      </Panel>
    </>
  );
}

/* ── financial statements (from the trial balance) ───────────────────── */
export function Statements() {
  const { t } = useApp();
  const [from, setFrom] = useState(today().slice(0, 4) + "-01-01");
  const [to, setTo] = useState(today());
  const d = useData(async () => ({
    period: await rpc("trial_balance", { p_from: from, p_to: to }),
    all: await rpc("trial_balance", { p_to: to }),
  }), [from, to]);
  const period = d.data?.period || [];
  const all = d.data?.all || [];
  const mv = (r) => Number(r.debit) - Number(r.credit);
  const revenue = period.filter((r) => r.type === "revenue").map((r) => ({ ...r, amt: -mv(r) }));
  const expense = period.filter((r) => r.type === "expense").map((r) => ({ ...r, amt: mv(r) }));
  const totRev = revenue.reduce((n, r) => n + r.amt, 0);
  const totExp = expense.reduce((n, r) => n + r.amt, 0);
  const profitToDate = -all.filter((r) => r.type === "revenue" || r.type === "expense").reduce((n, r) => n + Number(r.closing), 0);
  const bs = (type, sign) => all.filter((r) => r.type === type && Number(r.closing)).map((r) => ({ ...r, amt: sign * Number(r.closing) }));
  const assets = bs("asset", 1), liabilities = bs("liability", -1), equity = bs("equity", -1);
  const sum = (a) => a.reduce((n, r) => n + r.amt, 0);

  const Block = ({ title, rows, total, extra }) => (
    <>
      <tr><td colSpan={2} style={{ fontWeight: 700, color: "var(--brand)" }}>{title}</td></tr>
      {rows.map((r) => <tr key={r.account_id}><td style={{ paddingInlineStart: 24 }}>{r.code} — {r.name_ar}</td><td className="n"><Money v={r.amt} currency={null} /></td></tr>)}
      {extra}
      <tr><td style={{ fontWeight: 600 }}>{t("إجمالي", "Total")} {title}</td><td className="n" style={{ fontWeight: 600 }}><Money v={total} currency={null} /></td></tr>
    </>
  );

  return (
    <>
      <PageHead title={t("القوائم المالية", "Financial statements")}><DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} /></PageHead>
      <div className="grid c2">
        <Panel title={t("قائمة الدخل", "Income statement")} pad={false}>
          <table className="tbl"><tbody>
            <Block title={t("الإيرادات", "Revenue")} rows={revenue} total={totRev} />
            <Block title={t("التكاليف والمصروفات", "Costs & expenses")} rows={expense} total={totExp} />
          </tbody><tfoot><tr><td>{t("صافي الربح (الخسارة)", "Net profit (loss)")}</td><td className="n"><Money v={totRev - totExp} /></td></tr></tfoot></table>
        </Panel>
        <Panel title={`${t("قائمة المركز المالي في", "Balance sheet at")} ${to}`} pad={false}>
          <table className="tbl"><tbody>
            <Block title={t("الأصول", "Assets")} rows={assets} total={sum(assets)} />
            <Block title={t("الالتزامات", "Liabilities")} rows={liabilities} total={sum(liabilities)} />
            <Block title={t("حقوق الملكية", "Equity")} rows={equity} total={sum(equity) + profitToDate}
                   extra={<tr><td style={{ paddingInlineStart: 24 }}>{t("أرباح (خسائر) غير مقفلة", "Unclosed profit (loss)")}</td><td className="n"><Money v={profitToDate} currency={null} /></td></tr>} />
          </tbody><tfoot><tr><td>{t("الالتزامات + حقوق الملكية", "Liabilities + equity")}</td>
            <td className="n"><Money v={sum(liabilities) + sum(equity) + profitToDate} /></td></tr></tfoot></table>
        </Panel>
      </div>
    </>
  );
}

/* ── account ledger ──────────────────────────────────────────────────── */
export function Ledger() {
  const { t } = useApp();
  const initial = new URLSearchParams(window.location.hash.split("?")[1] || "").get("account");
  const [account, setAccount] = useState(initial);
  const [from, setFrom] = useState(today().slice(0, 4) + "-01-01");
  const [to, setTo] = useState(today());
  const accs = useData(() => L.accounts(), []);
  const led = useData(() => (account ? rpc("account_ledger", { p_account: account, p_from: from, p_to: to }) : []), [account, from, to]);
  return (
    <>
      <PageHead title={t("كشف حساب", "Account ledger")}>
        <select style={{ width: 280 }} value={account || ""} onChange={(e) => setAccount(e.target.value || null)}>
          <option value="">{t("اختر الحساب", "Choose account")}</option>
          {(accs.data || []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </PageHead>
      <Panel pad={false}>
        <Table rows={led.data} loading={led.loading} empty={t("اختر حساباً لعرض حركاته", "Choose an account to see its movements")}
               onRow={(r) => go(`/accounting/journals/${r.entry_id}`)} columns={[
          { key: "entry_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "number", label: t("القيد", "Entry"), render: (r) => <span className="mono">{r.number}</span> },
          { key: "memo", label: t("البيان", "Memo"), render: (r) => r.description || r.memo },
          { key: "debit", label: t("مدين", "Debit"), type: "money" },
          { key: "credit", label: t("دائن", "Credit"), type: "money" },
          { key: "balance", label: t("الرصيد", "Balance"), type: "money" },
        ]} />
      </Panel>
    </>
  );
}

/* ── fiscal periods ──────────────────────────────────────────────────── */
export function Periods() {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const list = useData(() => run(supabase.from("fiscal_periods").select("*").order("start_date")), []);
  async function close(p) {
    if (!window.confirm(t(`إقفال الفترة ${p.name}؟ لن يمكن الترحيل عليها بعد ذلك.`, `Close ${p.name}? No further posting will be allowed.`))) return;
    if (await act(async () => { await rpc("close_period", { p_period: p.id }); return true; }, t("تم الإقفال", "Closed"))) list.reload();
  }
  async function addYear() {
    const y = Number((list.data?.at(-1)?.start_date || today()).slice(0, 4)) + (list.data?.length ? 1 : 0);
    const rows = Array.from({ length: 12 }, (_, i) => {
      const s = new Date(Date.UTC(y, i, 1)); const e = new Date(Date.UTC(y, i + 1, 0));
      return { name: s.toISOString().slice(0, 7), start_date: s.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10) };
    });
    if (await act(async () => { await run(supabase.from("fiscal_periods").insert(rows)); return true; }, t("تمت إضافة السنة", "Year added"))) list.reload();
  }
  const pm = useMemo(() => list.data || [], [list.data]);
  return (
    <>
      <PageHead title={t("الفترات المالية", "Fiscal periods")}>
        {can("accounting.manage") && <button className="btn" onClick={addYear} disabled={busy}>{t("+ سنة مالية", "+ Fiscal year")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={pm} loading={list.loading} columns={[
          { key: "name", label: t("الفترة", "Period") },
          { key: "start_date", label: t("من", "From"), type: "date" },
          { key: "end_date", label: t("إلى", "To"), type: "date" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
          { key: "a", label: "", render: (r) => r.status === "open" && can("accounting.close") ? <button className="btn sm" onClick={() => close(r)} disabled={busy}>{t("إقفال", "Close")}</button> : null },
        ]} />
      </Panel>
    </>
  );
}

export { DateRange };
