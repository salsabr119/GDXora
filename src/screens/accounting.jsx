import { useMemo, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { Resource } from "../crud.jsx";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, DateText, StatusBadge, Field, Badge, Modal, go, useName, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { today, num } from "../lib/format.js";

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
// which kind of party an account's lines refer to
const PARTY_BY_KEY = { ar: "customer", retention_receivable: "customer", customer_advances: "customer",
                       ap: "vendor", retention_payable: "vendor", employee_advances: "employee", salaries_payable: "employee" };

/** Opening balances from Excel → a draft journal entry the accountant reviews and posts. */
function OpeningImportDialog({ onClose }) {
  const { t } = useApp();
  const [act, busy] = useAction();
  const v = useIssues();
  const [date, setDate] = useState(today().slice(0, 4) + "-01-01");
  const [res, setRes] = useState(null);
  const lk = useData(async () => {
    const [accounts, projects, customers, vendors, employees] = await Promise.all([L.accounts(), L.projects(), L.customerNames(), L.vendors().catch(() => []), L.employees()]);
    return { accounts, projects, parties: { customer: customers, vendor: vendors, employee: employees } };
  }, []);
  const fields = [
    { key: "account_id", label: t("الحساب", "Account"), type: "select", required: true, options: (x) => x.accounts || [],
      hint: t("اختر من القائمة أو اكتب رمز الحساب", "Pick from the list or type the account code") },
    { key: "debit", label: t("مدين", "Debit"), type: "money" },
    { key: "credit", label: t("دائن", "Credit"), type: "money" },
    { key: "description", label: t("البيان", "Description") },
    { key: "party", label: t("الطرف (عميل / مورد / موظف)", "Party (customer / vendor / employee)"),
      hint: t("لحسابات العملاء والموردين وسلف الموظفين: الاسم أو الرمز", "For receivable, payable and advance accounts: name or code") },
    { key: "project_id", label: t("المشروع", "Project"), type: "select", options: (x) => x.projects || [] },
  ];
  const partyName = { customer: t("عميل", "customer"), vendor: t("مورد", "vendor"), employee: t("موظف", "employee") };
  const partyList = { customer: t("العملاء", "customers"), vendor: t("الموردين", "vendors"), employee: t("الموظفين", "employees") };

  async function template() {
    const { downloadTemplate } = await import("../lib/excel.js");
    await act(() => downloadTemplate({ name: t("قالب الأرصدة الافتتاحية", "Opening balances template"), entity: "opening_balances",
                                       fields, lookups: lk.data, t, rtl: document.documentElement.dir !== "ltr" }).then(() => true));
  }

  async function read(file) {
    v.clear(); setRes(null);
    if (!file || !lk.data) return;
    await act(async () => {
      const { readWorkbook, convertRow, matchOption } = await import("../lib/excel.js");
      const wb = await readWorkbook(file, fields);
      if (wb.entity && wb.entity !== "opening_balances") { v.check([t("هذا الملف قالب لقسم آخر. نزّل قالب الأرصدة الافتتاحية.", "This file is a template for another screen.")]); return true; }
      if (!wb.rows.length) { v.check([t("الملف لا يحتوي على أسطر.", "The file has no rows.")]); return true; }
      const errors = []; const lines = [];
      for (const { line, cells } of wb.rows) {
        const { record, errors: e, failed } = convertRow(cells, fields, lk.data, t);
        const where = t(`سطر ${line}`, `Row ${line}`);
        e.forEach((m) => errors.push(`${where}: ${m}`));
        if (!record.account_id && !failed.has("account_id")) errors.push(t(`${where}: اختر الحساب`, `${where}: choose the account`));
        const d = record.debit || 0, c = record.credit || 0;
        if (d < 0 || c < 0) errors.push(t(`${where}: المبالغ لا تكون سالبة`, `${where}: amounts cannot be negative`));
        if (d > 0 && c > 0) errors.push(t(`${where}: اكتب المبلغ في المدين أو الدائن، وليس الاثنين`, `${where}: use either debit or credit`));
        if (!d && !c && !failed.has("debit") && !failed.has("credit")) errors.push(t(`${where}: أدخل مبلغاً في المدين أو الدائن`, `${where}: enter a debit or credit`));
        const acc = lk.data.accounts.find((a) => a.id === record.account_id);
        let party_type = null, party_id = null, partyLabel = null;
        if (record.party) {
          const want = acc && PARTY_BY_KEY[acc.system_key];
          const hits = (want ? [want] : ["customer", "vendor", "employee"])
            .map((k) => [k, matchOption(lk.data.parties[k], record.party)]).filter(([, o]) => o);
          if (!hits.length) errors.push(t(`${where}: الطرف «${record.party}» غير موجود${want ? ` ضمن ${partyList[want]}` : ""} — أضفه أولاً أو اكتب رمزه`, `${where}: party "${record.party}" not found — add it first or use its code`));
          else if (hits.length > 1) errors.push(t(`${where}: «${record.party}» موجود كعميل ومورد/موظف — اكتب الرمز بدل الاسم`, `${where}: "${record.party}" matches several parties — use the code`));
          else [[party_type, { id: party_id, label: partyLabel }]] = hits;
        } else if (acc && PARTY_BY_KEY[acc.system_key]) {
          errors.push(t(`${where}: حساب «${acc.name_ar}» يحتاج تحديد ${partyName[PARTY_BY_KEY[acc.system_key]]} في عمود «الطرف»`, `${where}: account "${acc.name_ar}" needs the ${PARTY_BY_KEY[acc.system_key]} in the party column`));
        }
        lines.push({ line, acc, debit: d, credit: c, description: record.description || null, project_id: record.project_id || null, party_type, party_id, partyLabel });
      }
      const dr = lines.reduce((n, l) => n + l.debit, 0), cr = lines.reduce((n, l) => n + l.credit, 0);
      if (Math.abs(dr - cr) >= 0.005) errors.push(t(`الأرصدة غير متوازنة: المدين ${num(dr)} والدائن ${num(cr)} — الفرق ${num(Math.abs(dr - cr))}`, `Not balanced: debit ${num(dr)} vs credit ${num(cr)} — difference ${num(Math.abs(dr - cr))}`));
      setRes({ file: file.name, lines, dr, cr, errors });
      v.check(errors.slice(0, 200));
      return true;
    });
  }

  async function commit() {
    if (!res) { v.check([t("اختر ملف الأرصدة أولاً", "Choose the balances file first")]); return; }
    if (!date) { v.check([t("أدخل تاريخ الأرصدة الافتتاحية", "Enter the opening balances date")]); return; }
    if (!v.check(res.errors.slice(0, 200))) return;
    const id = await act(() => rpc("create_journal", {
      p_date: date, p_memo: t("الأرصدة الافتتاحية", "Opening balances"), p_post: false, p_source: "opening",
      p_lines: res.lines.map((l) => ({ account_id: l.acc.id, debit: l.debit, credit: l.credit, description: l.description,
                                       project_id: l.project_id, party_type: l.party_type, party_id: l.party_id })) }),
      t("تم إنشاء قيد الأرصدة الافتتاحية كمسودة — راجعه ثم رحّله", "Opening entry created as a draft — review and post it"));
    if (id) { onClose(); go(`/accounting/journals/${id}`); }
  }

  return (
    <Modal title={t("استيراد الأرصدة الافتتاحية من Excel", "Import opening balances from Excel")} onClose={onClose} wide
           footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{t("إلغاء", "Cancel")}</button>
             <button className="btn primary" onClick={commit} disabled={busy}>{t("إنشاء قيد الأرصدة (مسودة)", "Create opening entry (draft)")}</button></>}>
      <ol className="steps">
        <li>{t("نزّل القالب: سطر لكل رصيد — الحساب، والمبلغ في المدين أو الدائن.", "Download the template: one row per balance — account and the amount as debit or credit.")}
          {" "}<button className="btn sm" onClick={template} disabled={busy || !lk.data}>⬇ {t("تنزيل القالب", "Download template")}</button></li>
        <li>{t("أرصدة العملاء والموردين وسلف الموظفين: سطر لكل طرف مع اسمه أو رمزه في عمود «الطرف». الفرق يُقفل على حساب رأس المال أو الأرباح المبقاة.", "Customer, vendor and employee-advance balances: one row per party with its name or code. Close the difference to capital or retained earnings.")}</li>
        <li>{t("ارفع الملف. يُنشأ قيد مسودة بتاريخ الأرصدة تراجعه ثم ترحّله.", "Upload the file. A draft entry is created on the opening date for you to review and post.")}
          <div className="row" style={{ marginTop: 6, gap: 12, flexWrap: "wrap" }}>
            <Field label={t("تاريخ الأرصدة الافتتاحية", "Opening balances date")} required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <input type="file" accept=".xlsx" onChange={(e) => read(e.target.files?.[0])} /></div></li>
      </ol>
      <Issues issues={v.issues} title={res ? t("الرجاء تصحيح ما يلي في الملف ثم رفعه مرة أخرى:", "Please fix the following in the file and upload it again:") : undefined} />
      {res && (
        <>
          <div className={`alert ${res.errors.length ? "bad" : "ok"}`}>
            {t(`${res.file}: ${res.lines.length} سطر — مدين ${num(res.dr)} / دائن ${num(res.cr)}`, `${res.file}: ${res.lines.length} rows — debit ${num(res.dr)} / credit ${num(res.cr)}`)}
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 320 }}><table className="tbl">
            <thead><tr><th>{t("سطر", "Row")}</th><th>{t("الحساب", "Account")}</th><th>{t("الطرف", "Party")}</th><th className="n">{t("مدين", "Debit")}</th><th className="n">{t("دائن", "Credit")}</th></tr></thead>
            <tbody>{res.lines.slice(0, 300).map((l) => <tr key={l.line}><td className="mono">{l.line}</td><td>{l.acc?.label || "—"}</td><td>{l.partyLabel || ""}</td>
              <td className="n">{l.debit ? num(l.debit) : ""}</td><td className="n">{l.credit ? num(l.credit) : ""}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
    </Modal>
  );
}

export function Journals() {
  const { t, can } = useApp();
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState("");
  const list = useData(() => {
    let q = supabase.from("journal_entries").select("id, number, entry_date, memo, source_type, status, total").order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (status) q = q.eq("status", status);
    return run(q);
  }, [status]);
  const src = { manual: t("يدوي", "Manual"), invoice: t("فاتورة", "Invoice"), bill: t("فاتورة مورد", "Bill"),
                payment: t("سند", "Voucher"), payroll: t("رواتب", "Payroll"), reversal: t("عكس", "Reversal"), opening: t("أرصدة افتتاحية", "Opening balances") };
  return (
    <>
      <PageHead title={t("القيود اليومية", "Journal entries")} sub={t("القيود الآلية تُنشأ من الفواتير والسندات والرواتب", "Automatic entries come from invoices, vouchers and payroll")}>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("كل الحالات", "All statuses")}</option>
          <option value="draft">{t("مسودة", "Draft")}</option><option value="posted">{t("مُرحّل", "Posted")}</option><option value="reversed">{t("معكوس", "Reversed")}</option>
        </select>
        {can("accounting.manage") && <button className="btn" onClick={() => setOpening(true)}>⬆ {t("استيراد الأرصدة الافتتاحية", "Import opening balances")}</button>}
        {can("accounting.manage") && <button className="btn primary" onClick={() => go("/accounting/journals/new")}>{t("+ قيد يدوي", "+ Manual entry")}</button>}
      </PageHead>
      {opening && <OpeningImportDialog onClose={() => setOpening(false)} />}
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
  const v = useIssues();
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
    .map((l) => ({ account_id: l.account_id, description: l.description || null, debit: Number(l.debit || 0), credit: Number(l.credit || 0), project_id: l.project_id || null,
                   party_type: l.party_type || null, party_id: l.party_id || null }));

  // what is missing before saving / posting — shown in red above the form
  function problems(post) {
    const out = [];
    if (!form.entry_date) out.push({ key: "entry_date", msg: t("أدخل تاريخ القيد", "Enter the entry date") });
    if (post && !String(form.memo || "").trim()) out.push({ key: "memo", msg: t("أدخل بيان القيد (وصف مختصر للعملية)", "Enter a memo describing the entry") });
    lines.forEach((l, i) => {
      const d = Number(l.debit || 0), c = Number(l.credit || 0);
      const n = i + 1;
      if (d < 0 || c < 0) out.push({ key: `line${i}`, msg: t(`السطر ${n}: المبالغ لا تكون سالبة`, `Line ${n}: amounts cannot be negative`) });
      if (d > 0 && c > 0) out.push({ key: `line${i}`, msg: t(`السطر ${n}: اكتب المبلغ في المدين أو الدائن، وليس الاثنين`, `Line ${n}: use either debit or credit, not both`) });
      if ((d || c) && !l.account_id) out.push({ key: `line${i}`, msg: t(`السطر ${n}: اختر الحساب`, `Line ${n}: choose an account`) });
      if (l.account_id && !d && !c) out.push({ key: `line${i}`, msg: t(`السطر ${n}: أدخل مبلغاً في المدين أو الدائن`, `Line ${n}: enter a debit or credit amount`) });
    });
    const valid = lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit)));
    if (valid.length < 2) out.push(t("القيد يحتاج سطرين مكتملين على الأقل (حساب + مبلغ)", "An entry needs at least two complete lines (account + amount)"));
    if (post) {
      if (dr + cr <= 0) out.push(t("أدخل مبالغ القيد في المدين والدائن", "Enter the debit and credit amounts"));
      else if (!balanced) out.push(t(`القيد غير متوازن: المدين ${num(dr)} والدائن ${num(cr)} — الفرق ${num(Math.abs(dr - cr))}`,
                                    `Not balanced: debit ${num(dr)} vs credit ${num(cr)} — difference ${num(Math.abs(dr - cr))}`));
    }
    return out;
  }

  async function save(post) {
    if (!v.check(problems(post))) return;
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
        {editable && can("accounting.post") && <button className="btn primary" onClick={() => save(true)} disabled={busy}>{t("ترحيل", "Post")}</button>}
        {e?.status === "posted" && e.source_type === "manual" && can("accounting.post") && <button className="btn" onClick={reverse} disabled={busy}>{t("عكس القيد", "Reverse")}</button>}
        {e?.reversal_of && <a className="btn" href={`#/accounting/journals/${e.reversal_of}`}>{t("القيد الأصلي", "Original entry")}</a>}
        {e?.reversed_by && <a className="btn" href={`#/accounting/journals/${e.reversed_by}`}>{t("القيد العكسي", "Reversing entry")}</a>}
      </PageHead>

      <Issues issues={v.issues} />
      <Panel>
        <div className="form">
          <Field label={t("التاريخ", "Date")} required invalid={v.has("entry_date")}>
            {editable ? <input type="date" value={form.entry_date} onChange={(x) => setForm({ ...form, entry_date: x.target.value })} /> : <DateText v={e.entry_date} />}
          </Field>
          <Field label={t("البيان", "Memo")} wide required invalid={v.has("memo")}>
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
                <tr key={i} className={v.has(`line${i}`) ? "invalid" : ""}>
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
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </PageHead>
      <Panel pad={false}>
        <Table rows={rows} loading={tb.loading} columns={cols} exportName={`${t("ميزان المراجعة", "Trial balance")} ${from || ""} - ${to || ""}`} footer={<>
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

  async function exportStatements() {
    const { exportXlsx } = await import("../lib/excel.js");
    const out = [];
    const block = (title, rows, total, extra = []) => {
      out.push({ a: title, b: null });
      rows.forEach((r) => out.push({ a: `${r.code} — ${r.name_ar}`, b: r.amt }));
      extra.forEach((x) => out.push(x));
      out.push({ a: `${t("إجمالي", "Total")} ${title}`, b: total });
    };
    out.push({ a: t(`قائمة الدخل من ${from} إلى ${to}`, `Income statement ${from} – ${to}`), b: null });
    block(t("الإيرادات", "Revenue"), revenue, totRev);
    block(t("التكاليف والمصروفات", "Costs & expenses"), expense, totExp);
    out.push({ a: t("صافي الربح (الخسارة)", "Net profit (loss)"), b: totRev - totExp }, { a: "", b: null });
    out.push({ a: `${t("قائمة المركز المالي في", "Balance sheet at")} ${to}`, b: null });
    block(t("الأصول", "Assets"), assets, sum(assets));
    block(t("الالتزامات", "Liabilities"), liabilities, sum(liabilities));
    block(t("حقوق الملكية", "Equity"), equity, sum(equity) + profitToDate, [{ a: t("أرباح (خسائر) غير مقفلة", "Unclosed profit (loss)"), b: profitToDate }]);
    out.push({ a: t("الالتزامات + حقوق الملكية", "Liabilities + equity"), b: sum(liabilities) + sum(equity) + profitToDate });
    await exportXlsx({ filename: `${t("القوائم المالية", "Financial statements")} ${to}`, sheet: t("القوائم المالية", "Statements"),
                       columns: [{ label: t("البند", "Line"), value: (r) => r.a }, { label: t("المبلغ", "Amount"), type: "money", value: (r) => r.b }], rows: out });
  }

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
      <PageHead title={t("القوائم المالية", "Financial statements")}>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <button className="btn" onClick={exportStatements} disabled={!d.data}>⬇ {t("تصدير Excel", "Export to Excel")}</button>
      </PageHead>
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
        <Table rows={led.data} loading={led.loading} exportName={`${t("كشف حساب", "Ledger")} ${(accs.data || []).find((a) => a.id === account)?.label || ""} ${from} - ${to}`} empty={t("اختر حساباً لعرض حركاته", "Choose an account to see its movements")}
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
