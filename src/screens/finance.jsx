import { useEffect, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { Resource, RecordForm, validateRecord } from "../crud.jsx";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, StatusBadge, Field, Modal, Tabs, Select, go, Loading } from "../ui.jsx";
import * as L from "../lookups.js";
import { today, num, downloadCsv, isVatNumber, isSaIban } from "../lib/format.js";
import { DateRange } from "./accounting.jsx";

/* ── vendors ─────────────────────────────────────────────────────────── */
export function Vendors() {
  const { t } = useApp();
  return <Resource cfg={{
    table: "vendors", title: t("الموردون ومقاولو الباطن", "Vendors & subcontractors"), order: "name_ar.asc", managePerm: "finance.manage",
    search: ["code", "name_ar", "name_en", "vat_number"], defaults: { vendor_type: "supplier", payment_terms_days: 30, active: true },
    columns: [
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code}</span> },
      { key: "name_ar", label: t("الاسم", "Name") },
      { key: "vendor_type", label: t("النوع", "Type"), render: (r) => ({ supplier: t("مورد", "Supplier"), subcontractor: t("مقاول باطن", "Subcontractor"), service: t("خدمات", "Services"), government: t("جهة حكومية", "Government") })[r.vendor_type] },
      { key: "vat_number", label: t("الرقم الضريبي", "VAT no."), render: (r) => <span className="mono">{r.vat_number || "—"}</span> },
      { key: "phone", label: t("الجوال", "Phone"), render: (r) => <span className="mono">{r.phone || "—"}</span> },
    ],
    fields: [
      { key: "name_ar", label: t("الاسم (عربي)", "Name (Arabic)"), required: true },
      { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
      { key: "vendor_type", label: t("النوع", "Type"), type: "select", options: [
        { id: "supplier", label: t("مورد", "Supplier") }, { id: "subcontractor", label: t("مقاول باطن", "Subcontractor") },
        { id: "service", label: t("خدمات", "Services") }, { id: "government", label: t("جهة حكومية", "Government") }] },
      { key: "vat_number", label: t("الرقم الضريبي", "VAT number"), ltr: true, validate: (v) => (isVatNumber(v) ? null : t("الرقم الضريبي غير صحيح — 15 رقماً يبدأ وينتهي بـ 3", "Invalid VAT number — 15 digits starting and ending with 3")) },
      { key: "cr_number", label: t("السجل التجاري", "CR number"), ltr: true },
      { key: "phone", label: t("الجوال", "Phone"), ltr: true },
      { key: "email", label: t("البريد", "E-mail"), type: "email", ltr: true },
      { key: "city", label: t("المدينة", "City") },
      { key: "address", label: t("العنوان", "Address") },
      { key: "iban", label: t("الآيبان", "IBAN"), ltr: true, validate: (v) => (isSaIban(v) ? null : t("الآيبان غير صحيح — SA متبوعاً بـ 22 رقماً", "Invalid IBAN — SA followed by 22 digits")) },
      { key: "payment_terms_days", label: t("مدة السداد (يوم)", "Payment terms (days)"), type: "number" },
      { key: "active", label: t("نشط", "Active"), type: "checkbox" },
      { key: "notes", label: t("ملاحظات", "Notes"), type: "textarea", wide: true },
    ],
  }} />;
}

/* ── vendor bills ────────────────────────────────────────────────────── */
export function Bills() {
  const { t, can } = useApp();
  const list = useData(() => run(supabase.from("bills").select("id, number, vendor_ref, bill_date, due_date, status, total, net_payable, amount_paid, vendors(name_ar), projects(name_ar)")
    .order("bill_date", { ascending: false }).limit(500)), []);
  return (
    <>
      <PageHead title={t("فواتير الموردين", "Vendor bills")} sub={t("ضريبة المدخلات تُسجّل تلقائياً وتظهر في الإقرار الضريبي", "Input VAT is recorded automatically for the VAT return")}>
        {can("finance.manage") && <button className="btn primary" onClick={() => go("/finance/bills/new")}>{t("+ فاتورة مورد", "+ Bill")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => go(`/finance/bills/${r.id}`)} columns={[
          { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
          { key: "vendor_ref", label: t("رقم فاتورة المورد", "Vendor ref"), render: (r) => <span className="mono">{r.vendor_ref || "—"}</span> },
          { key: "v", label: t("المورد", "Vendor"), render: (r) => r.vendors?.name_ar },
          { key: "p", label: t("المشروع", "Project"), render: (r) => r.projects?.name_ar || "—" },
          { key: "bill_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "total", label: t("الإجمالي", "Total"), type: "money" },
          { key: "bal", label: t("المتبقي", "Balance"), n: true, render: (r) => r.status === "posted" ? <Money v={r.net_payable - r.amount_paid} currency={null} /> : "—" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
        ]} />
      </Panel>
    </>
  );
}

const blankBillLine = (tax) => ({ description: "", account_id: null, project_id: null, quantity: 1, unit_price: 0, tax_code_id: tax || null });

export function BillEditor({ params }) {
  const { t, can } = useApp();
  const isNew = params.id === "new";
  const [act, busy] = useAction();
  const iss = useIssues();
  const [form, setForm] = useState(null);
  const lk = useData(async () => ({
    vendors: await L.vendors(), projects: await L.projects(), tax: await L.taxCodes(),
    accounts: (await L.accounts()).filter((a) => a.type === "expense" || a.type === "asset"),
  }), []);
  const bill = useData(async () => {
    if (isNew) return null;
    const b = await run(supabase.from("bills").select("*, vendors(name_ar)").eq("id", params.id).single());
    const lines = await run(supabase.from("bill_lines").select("*, accounts(code, name_ar), projects(name_ar)").eq("bill_id", params.id).order("line_no"));
    const pays = await run(supabase.from("payments").select("id, number, payment_date, amount, status").eq("bill_id", params.id));
    return { ...b, lines, pays };
  }, [params.id]);
  const std = lk.data?.tax?.find((x) => x.category === "S")?.id;
  useEffect(() => {
    if (isNew && lk.data && !form) setForm({ vendor_id: null, vendor_ref: "", project_id: null, bill_date: today(), retention_amount: 0, notes: "", lines: [blankBillLine(std)] });
    if (!isNew && bill.data?.status === "draft" && !form) setForm({ ...bill.data, lines: bill.data.lines.length ? bill.data.lines : [blankBillLine(std)] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk.data, bill.data]);

  const b = bill.data;
  if ((!isNew && !b) || !lk.data) return <Loading />;
  const editable = (isNew || b.status === "draft") && can("finance.manage");

  if (!editable || !form) {
    if (!b) return <Loading />;
    const balance = Number(b.net_payable) - Number(b.amount_paid);
    return (
      <>
        <PageHead title={`${t("فاتورة مورد", "Bill")} ${b.number || ""}`} sub={<StatusBadge status={b.status} />}>
          <button className="btn" onClick={() => go("/finance/bills")}>{t("رجوع", "Back")}</button>
          {b.status === "posted" && balance > 0 && can("finance.manage") && <button className="btn primary" onClick={() => go(`/finance/payments?bill=${b.id}`)}>{t("تسجيل سداد", "Record payment")}</button>}
          {b.journal_entry_id && <a className="btn" href={`#/accounting/journals/${b.journal_entry_id}`}>{t("القيد", "Journal")}</a>}
        </PageHead>
        <Panel><div className="form">
          <Field label={t("المورد", "Vendor")}>{b.vendors?.name_ar}</Field><Field label={t("رقم فاتورة المورد", "Vendor ref")}>{b.vendor_ref || "—"}</Field>
          <Field label={t("التاريخ", "Date")}>{b.bill_date}</Field><Field label={t("الاستحقاق", "Due")}>{b.due_date || "—"}</Field>
          <Field label={t("الإجمالي", "Total")}><Money v={b.total} /></Field><Field label={t("المحتجزات", "Retention")}><Money v={b.retention_amount} /></Field>
          <Field label={t("صافي المستحق", "Net payable")}><Money v={b.net_payable} /></Field><Field label={t("المتبقي", "Balance")}><Money v={balance} /></Field>
        </div></Panel>
        <Panel pad={false}><Table rows={b.lines} columns={[
          { key: "description", label: t("الوصف", "Description") }, { key: "a", label: t("الحساب", "Account"), render: (r) => `${r.accounts?.code} — ${r.accounts?.name_ar}` },
          { key: "p", label: t("المشروع", "Project"), render: (r) => r.projects?.name_ar || "—" },
          { key: "line_net", label: t("الصافي", "Net"), type: "money" }, { key: "line_vat", label: t("الضريبة", "VAT"), type: "money" }]} /></Panel>
      </>
    );
  }

  const lines = form.lines;
  const taxById = Object.fromEntries(lk.data.tax.map((x) => [x.id, x]));
  const calc = lines.map((l) => { const net = Math.round(Number(l.quantity || 0) * Number(l.unit_price || 0) * 100) / 100; return { net, vat: Math.round(net * Number(taxById[l.tax_code_id]?.rate || 0)) / 100 }; });
  const sub = calc.reduce((n, c) => n + c.net, 0), vat = calc.reduce((n, c) => n + c.vat, 0);
  const setLine = (k, patch) => setForm({ ...form, lines: lines.map((l, j) => (j === k ? { ...l, ...patch } : l)) });

  function problems(posting) {
    const out = [];
    if (!form.vendor_id) out.push({ key: "vendor", msg: t("اختر المورد", "Choose the vendor") });
    if (!form.bill_date) out.push({ key: "date", msg: t("أدخل تاريخ الفاتورة", "Enter the bill date") });
    lines.forEach((l, k) => {
      const n = k + 1, started = l.description || l.account_id || Number(l.unit_price);
      if (!started) return;
      if (!String(l.description || "").trim()) out.push({ key: `line${k}`, msg: t(`البند ${n}: أدخل الوصف`, `Line ${n}: enter a description`) });
      if (!l.account_id) out.push({ key: `line${k}`, msg: t(`البند ${n}: اختر حساب المصروف أو التكلفة`, `Line ${n}: choose the expense/cost account`) });
      if (!(Number(l.quantity) > 0)) out.push({ key: `line${k}`, msg: t(`البند ${n}: الكمية يجب أن تكون أكبر من صفر`, `Line ${n}: quantity must be above zero`) });
      if (Number(l.unit_price) < 0) out.push({ key: `line${k}`, msg: t(`البند ${n}: السعر لا يكون سالباً`, `Line ${n}: price cannot be negative`) });
    });
    if (!lines.some((l) => String(l.description || "").trim() && l.account_id)) out.push(t("أضف بنداً واحداً على الأقل (وصف + حساب + مبلغ)", "Add at least one line (description, account, amount)"));
    if (posting && sub + vat <= 0) out.push(t("إجمالي الفاتورة يجب أن يكون أكبر من صفر", "The bill total must be above zero"));
    if (Number(form.retention_amount) < 0) out.push({ key: "retention", msg: t("المحتجزات لا تكون سالبة", "Retention cannot be negative") });
    if (Number(form.retention_amount) > sub + vat) out.push({ key: "retention", msg: t("المحتجزات أكبر من إجمالي الفاتورة", "Retention exceeds the bill total") });
    return out;
  }
  async function save() {
    const header = { vendor_id: form.vendor_id, vendor_ref: form.vendor_ref || null, project_id: form.project_id || null, bill_date: form.bill_date,
                     due_date: form.due_date || null, retention_amount: Number(form.retention_amount || 0), notes: form.notes || null };
    if (!header.vendor_id) throw new Error(t("اختر المورد", "Select a vendor"));
    let id = params.id;
    if (isNew) id = (await run(supabase.from("bills").insert(header).select("id").single())).id;
    else await run(supabase.from("bills").update(header).eq("id", id));
    await run(supabase.from("bill_lines").delete().eq("bill_id", id));
    const rows = lines.filter((l) => l.description && l.account_id).map((l, k) => ({ bill_id: id, line_no: k + 1, description: l.description, account_id: l.account_id,
      project_id: l.project_id || form.project_id || null, quantity: Number(l.quantity || 1), unit_price: Number(l.unit_price || 0), tax_code_id: l.tax_code_id || null }));
    if (rows.length) await run(supabase.from("bill_lines").insert(rows));
    return id;
  }
  const after = (id) => { if (isNew) go(`/finance/bills/${id}`); else { setForm(null); bill.reload(); } };
  async function onSave() { if (!iss.check(problems(false))) return; const id = await act(save, t("تم الحفظ", "Saved")); if (id) after(id); }
  async function onPost() { if (!iss.check(problems(true))) return; const id = await act(async () => { const id = await save(); await rpc("post_bill", { p_bill: id }); return id; }, t("تم ترحيل الفاتورة", "Bill posted")); if (id) after(id); }

  return (
    <>
      <PageHead title={isNew ? t("فاتورة مورد جديدة", "New bill") : t("فاتورة مورد — مسودة", "Bill — draft")}>
        <button className="btn" onClick={() => go("/finance/bills")}>{t("رجوع", "Back")}</button>
        {!isNew && <button className="btn danger" disabled={busy} onClick={async () => { if (window.confirm(t("حذف المسودة؟", "Delete draft?")) && await act(async () => { await run(supabase.from("bills").delete().eq("id", params.id)); return true; })) go("/finance/bills"); }}>{t("حذف", "Delete")}</button>}
        <button className="btn" onClick={onSave} disabled={busy}>{t("حفظ كمسودة", "Save draft")}</button>
        {can("finance.approve") && <button className="btn primary" onClick={onPost} disabled={busy}>{t("ترحيل", "Post")}</button>}
      </PageHead>
      <Issues issues={iss.issues} />
      <Panel><div className="form">
        <Field label={t("المورد", "Vendor")} required invalid={iss.has("vendor")}><Select value={form.vendor_id} onChange={(v) => setForm({ ...form, vendor_id: v })} options={lk.data.vendors} /></Field>
        <Field label={t("رقم فاتورة المورد", "Vendor invoice no.")}><input value={form.vendor_ref || ""} onChange={(e) => setForm({ ...form, vendor_ref: e.target.value })} /></Field>
        <Field label={t("المشروع (اختياري)", "Project (optional)")}><Select value={form.project_id} onChange={(v) => setForm({ ...form, project_id: v })} options={lk.data.projects} placeholder={t("بدون مشروع — مصروف عام للشركة", "No project — company overhead")} /></Field>
        <Field label={t("التاريخ", "Date")} required invalid={iss.has("date")}><input type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} /></Field>
        <Field label={t("الاستحقاق", "Due date")}><input type="date" value={form.due_date || ""} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
        <Field label={t("محتجزات (مقاول باطن)", "Retention (subcontractor)")} invalid={iss.has("retention")}><input className="num" type="number" step="0.01" min="0" value={form.retention_amount ?? 0} onChange={(e) => setForm({ ...form, retention_amount: e.target.value })} /></Field>
      </div></Panel>
      <Panel pad={false} title={t("البنود", "Lines")}>
        <div className="tbl-wrap"><table className="tbl edit">
          <thead><tr><th style={{ minWidth: 200 }}>{t("الوصف", "Description")}</th><th style={{ minWidth: 220 }}>{t("حساب المصروف/التكلفة", "Expense/cost account")}</th><th style={{ minWidth: 160 }}>{t("المشروع", "Project")}</th>
            <th className="n">{t("الكمية", "Qty")}</th><th className="n">{t("السعر", "Price")}</th><th style={{ minWidth: 140 }}>{t("الضريبة", "Tax")}</th><th className="n">{t("الصافي", "Net")}</th><th /></tr></thead>
          <tbody>{lines.map((l, k) => (
            <tr key={k} className={iss.has(`line${k}`) ? "invalid" : ""}>
              <td><input value={l.description} onChange={(e) => setLine(k, { description: e.target.value })} /></td>
              <td><select value={l.account_id || ""} onChange={(e) => setLine(k, { account_id: e.target.value || null })}><option value="">—</option>{lk.data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></td>
              <td><select value={l.project_id || ""} onChange={(e) => setLine(k, { project_id: e.target.value || null })}><option value="">{form.project_id ? t("(نفس مشروع الفاتورة)", "(same as bill)") : t("بدون مشروع", "No project")}</option>{lk.data.projects.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></td>
              <td><input className="num" type="number" step="any" style={{ width: 80 }} value={l.quantity} onChange={(e) => setLine(k, { quantity: e.target.value })} /></td>
              <td><input className="num" type="number" step="0.01" style={{ width: 110 }} value={l.unit_price} onChange={(e) => setLine(k, { unit_price: e.target.value })} /></td>
              <td><select value={l.tax_code_id || ""} onChange={(e) => setLine(k, { tax_code_id: e.target.value || null })}><option value="">{t("بدون ضريبة", "No VAT")}</option>{lk.data.tax.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></td>
              <td className="n">{num(calc[k].net)}</td>
              <td><button className="btn ghost sm" disabled={lines.length <= 1} onClick={() => setForm({ ...form, lines: lines.filter((_, j) => j !== k) })}>✕</button></td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={6}><button className="btn sm" onClick={() => setForm({ ...form, lines: [...lines, blankBillLine(std)] })}>{t("+ بند", "+ Line")}</button></td>
            <td className="n"><Money v={sub} currency={null} /></td><td /></tr></tfoot>
        </table></div>
        <div className="panel-body row" style={{ justifyContent: "flex-end", gap: 24 }}>
          <span>{t("الضريبة", "VAT")}: <Money v={vat} /></span><b>{t("الإجمالي", "Total")}: <Money v={sub + vat} /></b>
          {Number(form.retention_amount) > 0 && <span>{t("الصافي بعد المحتجزات", "Net after retention")}: <Money v={sub + vat - Number(form.retention_amount)} /></span>}
        </div>
      </Panel>
    </>
  );
}

/* ── receipt & payment vouchers ──────────────────────────────────────── */
export function Payments() {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const q = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const [edit, setEdit] = useState(null);
  const list = useData(() => run(supabase.from("payments").select("*, accounts!payments_account_id_fkey(name_ar), customers(name_ar), vendors(name_ar), invoices(number), bills(number)")
    .order("payment_date", { ascending: false }).order("created_at", { ascending: false }).limit(500)), []);
  const lk = useData(async () => ({
    cash: await L.accounts({ cash: true }), customers: await L.customers(), vendors: await L.vendors(), projects: await L.projects(),
    accounts: await L.accounts(),
    invoices: (await run(supabase.from("invoices").select("id, number, customer_id, net_payable, amount_paid, project_id").eq("status", "issued").neq("doc_type", "credit_note")))
      .filter((i) => Number(i.net_payable) - Number(i.amount_paid) > 0).map((i) => ({ ...i, label: `${i.number} — ${num(i.net_payable - i.amount_paid)}` })),
    bills: (await run(supabase.from("bills").select("id, number, vendor_ref, vendor_id, net_payable, amount_paid, project_id").eq("status", "posted")))
      .filter((b) => Number(b.net_payable) - Number(b.amount_paid) > 0).map((b) => ({ ...b, label: `${b.number} ${b.vendor_ref ? `(${b.vendor_ref})` : ""} — ${num(b.net_payable - b.amount_paid)}` })),
  }), []);

  useEffect(() => {
    if (!lk.data || edit) return;
    const inv = q.get("invoice") && lk.data.invoices.find((i) => i.id === q.get("invoice"));
    const bill = q.get("bill") && lk.data.bills.find((b) => b.id === q.get("bill"));
    if (inv) setEdit({ direction: "receipt", purpose: "invoice", invoice_id: inv.id, customer_id: inv.customer_id, amount: Number(inv.net_payable) - Number(inv.amount_paid), payment_date: today(), method: "bank_transfer", account_id: lk.data.cash[0]?.id });
    if (bill) setEdit({ direction: "payment", purpose: "bill", bill_id: bill.id, vendor_id: bill.vendor_id, amount: Number(bill.net_payable) - Number(bill.amount_paid), payment_date: today(), method: "bank_transfer", account_id: lk.data.cash[0]?.id });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lk.data]);

  const purposes = {
    receipt: [["invoice", t("تحصيل فاتورة", "Invoice receipt")], ["customer_advance", t("دفعة مقدمة من عميل", "Customer advance")],
              ["customer_on_account", t("دفعة على الحساب من عميل", "Customer on account")], ["other", t("قبض آخر", "Other receipt")]],
    payment: [["bill", t("سداد فاتورة مورد", "Bill payment")], ["vendor_on_account", t("دفعة لمورد على الحساب", "Vendor on account")],
              ["salaries", t("صرف رواتب", "Salaries")], ["gosi", t("سداد التأمينات الاجتماعية", "GOSI")], ["other", t("مصروف / صرف آخر", "Other payment / expense")]],
  };
  const e = edit || {};
  const fields = lk.data ? [
    { key: "direction", label: t("نوع السند", "Voucher type"), type: "select", required: true, options: [{ id: "receipt", label: t("سند قبض", "Receipt") }, { id: "payment", label: t("سند صرف", "Payment") }] },
    { key: "purpose", label: t("الغرض", "Purpose"), type: "select", required: true, options: (purposes[e.direction] || []).map(([id, label]) => ({ id, label })) },
    { key: "payment_date", label: t("التاريخ", "Date"), type: "date", required: true },
    { key: "account_id", label: t("الصندوق / البنك", "Cash / bank"), type: "select", required: true, options: lk.data.cash },
    { key: "amount", label: t("المبلغ", "Amount"), type: "money", required: true },
    { key: "method", label: t("طريقة الدفع", "Method"), type: "select", options: [{ id: "bank_transfer", label: t("تحويل بنكي", "Bank transfer") }, { id: "cash", label: t("نقداً", "Cash") },
      { id: "cheque", label: t("شيك", "Cheque") }, { id: "card", label: t("بطاقة", "Card") }, { id: "sadad", label: t("سداد", "SADAD") }] },
    ...(e.purpose === "invoice" ? [{ key: "invoice_id", label: t("الفاتورة", "Invoice"), type: "select", required: true, options: lk.data.invoices }] : []),
    ...(e.purpose === "bill" ? [{ key: "bill_id", label: t("فاتورة المورد", "Bill"), type: "select", required: true, options: lk.data.bills }] : []),
    ...(["customer_advance", "customer_on_account"].includes(e.purpose) ? [{ key: "customer_id", label: t("العميل", "Customer"), type: "select", required: true, options: lk.data.customers }] : []),
    ...(e.purpose === "vendor_on_account" ? [{ key: "vendor_id", label: t("المورد", "Vendor"), type: "select", required: true, options: lk.data.vendors }] : []),
    ...(e.purpose === "other" ? [{ key: "counter_account_id", label: t("الحساب المقابل", "Counter account"), type: "select", required: true, options: lk.data.accounts.filter((a) => !a.is_cash) }] : []),
    { key: "project_id", label: t("المشروع", "Project"), type: "select", options: lk.data.projects },
    { key: "reference", label: t("المرجع (رقم الحوالة/الشيك)", "Reference"), ltr: true },
    { key: "memo", label: t("البيان", "Memo"), wide: true },
  ] : [];

  async function save(post) {
    const out = validateRecord(fields, e, t);
    if (!(Number(e.amount) > 0)) out.push({ key: "amount", msg: t("المبلغ يجب أن يكون أكبر من صفر", "The amount must be above zero") });
    const inv = e.purpose === "invoice" && lk.data.invoices.find((x) => x.id === e.invoice_id);
    if (inv && Number(e.amount) > Number(inv.net_payable) - Number(inv.amount_paid) + 0.001)
      out.push({ key: "amount", msg: t(`المبلغ أكبر من المتبقي على الفاتورة (${num(Number(inv.net_payable) - Number(inv.amount_paid))})`, "Amount exceeds the invoice balance") });
    const bl = e.purpose === "bill" && lk.data.bills.find((x) => x.id === e.bill_id);
    if (bl && Number(e.amount) > Number(bl.net_payable) - Number(bl.amount_paid) + 0.001)
      out.push({ key: "amount", msg: t(`المبلغ أكبر من المتبقي على فاتورة المورد (${num(Number(bl.net_payable) - Number(bl.amount_paid))})`, "Amount exceeds the bill balance") });
    if (!iss.check(out)) return;
    const rec = {};
    for (const f of fields) rec[f.key] = e[f.key] ?? null;
    for (const k of ["invoice_id", "bill_id", "customer_id", "vendor_id", "counter_account_id"]) if (!fields.find((f) => f.key === k)) rec[k] = null;
    const id = await act(async () => {
      let id = e.id;
      if (id) await run(supabase.from("payments").update(rec).eq("id", id));
      else id = (await run(supabase.from("payments").insert(rec).select("id").single())).id;
      if (post) await rpc("post_payment", { p_payment: id });
      return id;
    }, post ? t("تم ترحيل السند", "Voucher posted") : t("تم الحفظ", "Saved"));
    if (id) { setEdit(null); list.reload(); lk.reload(); window.location.hash = "#/finance/payments"; }
  }
  const dir = { receipt: t("قبض", "Receipt"), payment: t("صرف", "Payment") };
  const allPurposes = Object.fromEntries([...purposes.receipt, ...purposes.payment]);

  return (
    <>
      <PageHead title={t("سندات القبض والصرف", "Receipts & payments")}>
        {can("finance.manage") && <>
          <button className="btn" onClick={() => setEdit({ direction: "payment", purpose: "other", payment_date: today(), method: "bank_transfer", account_id: lk.data?.cash[0]?.id })}>{t("+ سند صرف", "+ Payment")}</button>
          <button className="btn primary" onClick={() => setEdit({ direction: "receipt", purpose: "invoice", payment_date: today(), method: "bank_transfer", account_id: lk.data?.cash[0]?.id })}>{t("+ سند قبض", "+ Receipt")}</button></>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} onRow={(r) => r.status === "draft" ? setEdit({ ...r }) : r.journal_entry_id && go(`/accounting/journals/${r.journal_entry_id}`)} columns={[
          { key: "number", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.number || "—"}</span> },
          { key: "direction", label: t("النوع", "Type"), render: (r) => <span className={r.direction === "receipt" ? "pos" : "neg"}>{dir[r.direction]}</span> },
          { key: "payment_date", label: t("التاريخ", "Date"), type: "date" },
          { key: "purpose", label: t("الغرض", "Purpose"), render: (r) => allPurposes[r.purpose] },
          { key: "party", label: t("الطرف / المستند", "Party / document"), render: (r) => r.invoices?.number || r.bills?.number || r.customers?.name_ar || r.vendors?.name_ar || r.memo || "—" },
          { key: "acc", label: t("الحساب", "Account"), render: (r) => r.accounts?.name_ar },
          { key: "amount", label: t("المبلغ", "Amount"), type: "money" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
        ]} />
      </Panel>
      {edit && lk.data && (
        <Modal wide title={e.direction === "receipt" ? t("سند قبض", "Receipt voucher") : t("سند صرف", "Payment voucher")} onClose={() => { setEdit(null); iss.clear(); }}
          footer={<>
            {e.id && <button className="btn danger" disabled={busy} onClick={async () => { if (await act(async () => { await run(supabase.from("payments").delete().eq("id", e.id)); return true; })) { setEdit(null); list.reload(); } }}>{t("حذف", "Delete")}</button>}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setEdit(null)}>{t("إلغاء", "Cancel")}</button>
            <button className="btn" onClick={() => save(false)} disabled={busy}>{t("حفظ كمسودة", "Save draft")}</button>
            {can("finance.approve") && <button className="btn primary" onClick={() => save(true)} disabled={busy}>{t("ترحيل", "Post")}</button>}
          </>}>
          <Issues issues={iss.issues} />
          <RecordForm fields={fields} value={e} invalid={iss.has} onChange={(v) => {
            if (v.direction !== e.direction) v.purpose = purposes[v.direction][0][0];
            if (v.invoice_id && v.invoice_id !== e.invoice_id) { const i = lk.data.invoices.find((x) => x.id === v.invoice_id); v.amount = Number(i.net_payable) - Number(i.amount_paid); v.project_id = i.project_id; }
            if (v.bill_id && v.bill_id !== e.bill_id) { const b = lk.data.bills.find((x) => x.id === v.bill_id); v.amount = Number(b.net_payable) - Number(b.amount_paid); v.project_id = b.project_id; }
            setEdit(v);
          }} />
        </Modal>
      )}
    </>
  );
}

/* ── aging ───────────────────────────────────────────────────────────── */
export function Aging() {
  const { t } = useApp();
  const [tab, setTab] = useState("ar");
  const [asOf, setAsOf] = useState(today());
  const d = useData(() => rpc(tab === "ar" ? "ar_aging" : "ap_aging", { p_as_of: asOf }), [tab, asOf]);
  const rows = d.data || [];
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k]), 0);
  const cols = [
    { key: tab === "ar" ? "customer" : "vendor", label: tab === "ar" ? t("العميل", "Customer") : t("المورد", "Vendor") },
    { key: "current_amt", label: t("غير مستحق", "Current"), type: "money" }, { key: "d30", label: "1–30", type: "money" },
    { key: "d60", label: "31–60", type: "money" }, { key: "d90", label: "61–90", type: "money" },
    { key: "over90", label: t("أكثر من 90", "90+"), type: "money" }, { key: "total", label: t("الإجمالي", "Total"), type: "money" },
  ];
  return (
    <>
      <PageHead title={t("أعمار الذمم", "Aging")}>
        <label className="muted">{t("كما في", "As of")}</label><input type="date" style={{ width: 160 }} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        <button className="btn" onClick={() => downloadCsv(`aging-${tab}-${asOf}.csv`, rows, cols.map((c) => ({ key: c.key, label: c.label })))}>{t("تصدير", "Export")}</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[["ar", t("مستحقات العملاء", "Receivables")], ["ap", t("مستحقات الموردين", "Payables")]]} />
      <Panel pad={false}>
        <Table rows={rows} loading={d.loading} columns={cols} footer={<><td>{t("الإجمالي", "Total")}</td>
          {["current_amt", "d30", "d60", "d90", "over90", "total"].map((k) => <td key={k} className="n"><Money v={sum(k)} currency={null} /></td>)}</>} />
      </Panel>
    </>
  );
}

/* ── VAT return ──────────────────────────────────────────────────────── */
export function VatReturn() {
  const { t } = useApp();
  const y = today().slice(0, 4);
  const qStart = `${y}-${String(Math.floor((Number(today().slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  const [from, setFrom] = useState(qStart);
  const [to, setTo] = useState(today());
  const d = useData(() => rpc("vat_return", { p_from: from, p_to: to }), [from, to]);
  const rows = Object.fromEntries((d.data || []).map((r) => [r.line, r]));
  const g = (k, f) => Number(rows[k]?.[f] || 0);
  const outVat = g("sales_standard", "vat") + g("sales_advance_recovery", "vat");
  const inVat = g("purchases_standard", "vat");
  const Line = ({ label, k }) => <tr><td>{label}</td><td className="n"><Money v={g(k, "taxable")} currency={null} /></td><td className="n"><Money v={g(k, "vat")} currency={null} /></td></tr>;
  return (
    <>
      <PageHead title={t("إقرار ضريبة القيمة المضافة", "VAT return")} sub={t("ملخص بحسب نموذج الإقرار لدى هيئة الزكاة والضريبة والجمارك", "Summary following the ZATCA return form")}>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </PageHead>
      <Panel pad={false}>
        <table className="tbl">
          <thead><tr><th>{t("البند", "Line")}</th><th className="n">{t("المبلغ", "Amount")}</th><th className="n">{t("الضريبة", "VAT")}</th></tr></thead>
          <tbody>
            <Line label={t("المبيعات الخاضعة للنسبة الأساسية", "Standard-rated sales")} k="sales_standard" />
            <Line label={t("تعديلات: استرداد دفعات مقدمة", "Adjustments: advance recoveries")} k="sales_advance_recovery" />
            <Line label={t("المبيعات الخاضعة للنسبة الصفرية", "Zero-rated sales")} k="sales_zero_rated" />
            <Line label={t("المبيعات المعفاة / خارج النطاق", "Exempt / out-of-scope sales")} k="sales_exempt" />
            <tr><td><b>{t("إجمالي ضريبة المخرجات", "Total output VAT")}</b></td><td /><td className="n"><b><Money v={outVat} currency={null} /></b></td></tr>
            <Line label={t("المشتريات الخاضعة للنسبة الأساسية", "Standard-rated purchases")} k="purchases_standard" />
            <tr><td><b>{t("إجمالي ضريبة المدخلات", "Total input VAT")}</b></td><td /><td className="n"><b><Money v={inVat} currency={null} /></b></td></tr>
          </tbody>
          <tfoot><tr><td>{t("صافي الضريبة المستحقة (المستردة)", "Net VAT due (refundable)")}</td><td /><td className="n"><Money v={outVat - inVat} /></td></tr></tfoot>
        </table>
      </Panel>
    </>
  );
}
