import { useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { Resource, RecordForm, validateRecord } from "../crud.jsx";
import { useApp, useData, useAction, Issues, useIssues, PageHead, Panel, Table, Money, StatusBadge, Field, Modal, Select, confirmDialog } from "../ui.jsx";
import * as L from "../lookups.js";
import { eosb, gosi } from "../lib/payroll.js";
import { today, isSaIban } from "../lib/format.js";

const REASONS = (t) => [
  { id: "employer_termination", label: t("إنهاء من صاحب العمل", "Terminated by employer") },
  { id: "contract_end", label: t("انتهاء العقد", "Contract end") },
  { id: "resignation", label: t("استقالة", "Resignation") },
  { id: "mutual", label: t("اتفاق الطرفين", "Mutual agreement") },
  { id: "article_87", label: t("المادة 87 (قوة قاهرة/زواج/وضع)", "Article 87") },
  { id: "article_80", label: t("المادة 80 (فصل لسبب مشروع)", "Article 80 (for cause)") },
  { id: "retirement", label: t("تقاعد", "Retirement") }, { id: "death", label: t("وفاة", "Death") },
];

const PAY_KEYS = ["basic_salary", "housing_allowance", "transport_allowance", "other_allowances", "bank_name", "iban"];
const payOf = (r) => (Array.isArray(r?.employee_pay) ? r.employee_pay[0] : r?.employee_pay) || null;
const totalPay = (p) => (p ? Number(p.basic_salary) + Number(p.housing_allowance) + Number(p.transport_allowance) + Number(p.other_allowances) : null);

const EMPLOYEE_FIELDS = (t) => [
      { key: "code", label: t("رقم الموظف", "Employee no."), formHidden: true, ltr: true,
        hint: t("اتركه فارغاً للموظف الجديد — يُعطى رقماً تلقائياً. للموظف الموجود يُستخدم لتحديث بياناته.", "Leave empty for a new employee. For an existing one it is used to update the record.") },
      { section: t("البيانات الشخصية", "Personal") },
      { key: "first_name_ar", label: t("الاسم الأول", "First name (AR)"), required: true },
      { key: "last_name_ar", label: t("اسم العائلة", "Last name (AR)"), required: true },
      { key: "first_name_en", label: t("First name", "First name (EN)"), ltr: true },
      { key: "last_name_en", label: t("Last name", "Last name (EN)"), ltr: true },
      { key: "nationality", label: t("رمز الجنسية (SA للسعودي)", "Nationality code (SA = Saudi)"), ltr: true, required: true, transform: (v) => (v || "").toUpperCase().slice(0, 2), validate: (v) => (/^[A-Z]{2}$/.test(v) ? null : t("رمز الجنسية حرفان إنجليزيان (مثال: SA، EG، IN)", "Nationality is a 2-letter code (e.g. SA, EG, IN)")) },
      { key: "national_id", label: t("رقم الهوية / الإقامة", "National ID / Iqama"), ltr: true },
      { key: "id_expiry", label: t("انتهاء الهوية/الإقامة", "ID expiry"), type: "date" },
      { key: "passport_no", label: t("رقم الجواز", "Passport"), ltr: true },
      { key: "birth_date", label: t("تاريخ الميلاد", "Birth date"), type: "date" },
      { key: "gender", label: t("الجنس", "Gender"), type: "select", options: [{ id: "male", label: t("ذكر", "Male") }, { id: "female", label: t("أنثى", "Female") }] },
      { key: "phone", label: t("الجوال", "Phone"), ltr: true },
      { key: "email", label: t("البريد", "E-mail"), type: "email", ltr: true },
      { section: t("الوظيفة", "Employment") },
      { key: "job_title", label: t("المسمى الوظيفي", "Job title") },
      { key: "department_id", label: t("القسم", "Department"), type: "select", options: (lk) => lk.departments || [] },
      { key: "manager_id", label: t("المدير المباشر", "Direct manager"), type: "select", import: false,
        options: (lk, r) => (lk.employees || []).filter((e) => e.id !== r?.id) },
      { key: "manager_ref", label: t("المدير المباشر (الرقم أو الاسم الكامل)", "Direct manager (number or full name)"), formHidden: true,
        hint: t("رقم الموظف أو اسمه الأول والعائلة كما هو مسجّل — يمكن أن يكون في نفس الملف", "Employee number or first + last name — may be in the same file") },
      { key: "project_id", label: t("المشروع (توزيع تكلفة الراتب)", "Project (salary cost)"), type: "select", options: (lk) => lk.projects || [] },
      { key: "hire_date", label: t("تاريخ المباشرة", "Hire date"), type: "date", required: true },
      { key: "contract_type", label: t("نوع العقد", "Contract"), type: "select", options: [{ id: "unlimited", label: t("غير محدد المدة", "Unlimited") }, { id: "limited", label: t("محدد المدة", "Fixed term") }] },
      { key: "contract_end_date", label: t("نهاية العقد", "Contract end"), type: "date" },
      { key: "status", label: t("الحالة", "Status"), type: "select", options: [{ id: "active", label: t("نشط", "Active") }, { id: "on_leave", label: t("في إجازة", "On leave") }, { id: "terminated", label: t("منتهي الخدمة", "Terminated") }] },
      { key: "termination_date", label: t("تاريخ انتهاء الخدمة", "Termination date"), type: "date", validate: (v, r) => (r.hire_date && v < r.hire_date ? t("تاريخ انتهاء الخدمة قبل تاريخ المباشرة", "Termination date is before the hire date") : null) },
      { key: "termination_reason", label: t("سبب انتهاء الخدمة", "Termination reason"), type: "select", options: REASONS(t) },
      { key: "annual_leave_days", label: t("أيام الإجازة السنوية", "Annual leave days"), type: "number" },
      { section: t("الراتب الشهري", "Monthly pay"), pay: true },
      { key: "basic_salary", label: t("الراتب الأساسي", "Basic salary"), type: "money", required: true, validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
      { key: "housing_allowance", label: t("بدل السكن", "Housing"), type: "money", validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
      { key: "transport_allowance", label: t("بدل النقل", "Transport"), type: "money", validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
      { key: "other_allowances", label: t("بدلات أخرى", "Other allowances"), type: "money", validate: (v) => (Number(v) < 0 ? t("القيمة لا تكون سالبة", "Value cannot be negative") : null) },
      { section: t("التأمينات والبنك", "GOSI & bank") },
      { key: "gosi_registered", label: t("مسجل في التأمينات", "GOSI registered"), type: "checkbox" },
      { key: "gosi_scheme", label: t("نظام التأمينات", "GOSI scheme"), type: "select", options: [{ id: "legacy", label: t("مسجل قبل يوليو 2024", "Registered before Jul 2024") }, { id: "new", label: t("نظام 2024 الجديد", "2024 law (new entrant)") }] },
      { key: "gosi_number", label: t("رقم المشترك", "GOSI number"), ltr: true },
      { key: "bank_name", label: t("البنك", "Bank") },
      { key: "iban", label: t("الآيبان (لملف حماية الأجور)", "IBAN (for WPS)"), ltr: true, transform: (v) => (v || "").replace(/\s/g, "").toUpperCase() || null, validate: (v) => (isSaIban(v) ? null : t("الآيبان غير صحيح — SA متبوعاً بـ 22 رقماً", "Invalid IBAN — SA followed by 22 digits")) },
      { key: "notes", label: t("ملاحظات", "Notes"), type: "textarea", wide: true },
    ];

export function Employees() {
  const { t, can } = useApp();
  const salaries = can("hr.salaries");
  const fields = EMPLOYEE_FIELDS(t).filter((f) => salaries || !(PAY_KEYS.includes(f.key) || f.pay));
  return <Resource cfg={{
    table: "employees", title: t("الموظفون", "Employees"), select: salaries ? "*, departments!employees_department_id_fkey(name_ar), employee_pay(*)" : "*, departments!employees_department_id_fkey(name_ar)", order: "code.asc",
    // salaries live in employee_pay (permission hr.salaries); one database call saves both, for the form and the Excel import
    toForm: (r) => { const { employee_pay: _p, departments: _d, ...rest } = r; return { ...rest, ...(payOf(r) ? Object.fromEntries(PAY_KEYS.map((k) => [k, payOf(r)[k]])) : {}) }; },
    saveRecords: (rows) => rpc("save_employees", { p_rows: rows }),
    // Excel round trip: match by employee number, then ID / iqama; the manager travels as a name
    importKey: ["code", "national_id"],
    toImport: (r, lk) => { const { employee_pay: _p, departments: _d, ...rest } = r; const m = (lk.employees || []).find((e) => e.id === r.manager_id);
      return { ...rest, ...(payOf(r) ? Object.fromEntries(PAY_KEYS.map((k) => [k, payOf(r)[k]])) : {}), manager_ref: m ? `${m.first_name_ar} ${m.last_name_ar}` : null }; },
    managePerm: "hr.manage", search: ["code", "first_name_ar", "last_name_ar", "national_id", "job_title", "phone"],
    loadLookups: async () => ({ departments: await L.departments(), projects: await L.projects(), employees: await L.employees() }),
    defaults: { nationality: "SA", contract_type: "unlimited", status: "active", hire_date: today(), gosi_registered: true, gosi_scheme: "legacy",
                annual_leave_days: 21, ...(salaries ? { basic_salary: 0, housing_allowance: 0, transport_allowance: 0, other_allowances: 0 } : {}) },
    columns: [
      { key: "code", label: t("الرقم", "No."), render: (r) => <span className="mono">{r.code}</span> },
      { key: "name", label: t("الاسم", "Name"), render: (r) => `${r.first_name_ar} ${r.last_name_ar}` },
      { key: "job_title", label: t("المسمى", "Title") },
      { key: "d", label: t("القسم", "Department"), render: (r) => r.departments?.name_ar || "—" },
      { key: "m", label: t("المدير المباشر", "Manager"), render: (r, lk) => { const m = lk?.employees?.find((e) => e.id === r.manager_id); return m ? `${m.first_name_ar} ${m.last_name_ar}` : "—"; } },
      { key: "p", label: t("المشروع", "Project"), render: (r, lk) => lk?.projects?.find((p) => p.id === r.project_id)?.name_ar || "—" },
      { key: "nationality", label: t("الجنسية", "Nationality"), render: (r) => r.is_saudi ? t("سعودي", "Saudi") : r.nationality },
      ...(salaries ? [{ key: "total", label: t("إجمالي الراتب", "Total pay"), n: true, render: (r) => (payOf(r) ? <Money v={totalPay(payOf(r))} currency={null} /> : "—") }] : []),
      { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
    ],
    fields,
  }} />;
}

export const UNIT_TYPES = (t) => [
  { id: "sector", label: t("قطاع", "Sector") }, { id: "general_department", label: t("إدارة عامة", "General department") },
  { id: "department", label: t("إدارة", "Department") }, { id: "section", label: t("قسم", "Section") }, { id: "unit", label: t("وحدة", "Unit") }];

export function Departments() {
  const { t } = useApp();
  const types = UNIT_TYPES(t);
  const empName = (lk, id) => { const e = lk?.employees?.find((x) => x.id === id); return e ? `${e.first_name_ar} ${e.last_name_ar}` : ""; };
  return <Resource cfg={{
    table: "departments", title: t("الوحدات التنظيمية", "Organisation units"), order: "name_ar.asc", managePerm: "hr.manage", canDelete: true,
    sub: t("قطاعات وإدارات عامة وإدارات وأقسام ووحدات — كل وحدة يمكن أن تتبع وحدة أعلى، بأي عدد من المستويات", "Sectors, general departments, departments, sections and units — any number of levels"),
    loadLookups: async () => ({ departments: await L.departments(), employees: await L.employees() }),
    saveRecords: (rows) => rpc("save_departments", { p_rows: rows }),
    importKey: ["code", "name_ar"],
    toImport: (r, lk) => { const p = (lk.departments || []).find((d) => d.id === r.parent_id); return { ...r, parent_ref: p ? p.code || p.name_ar : null, head_ref: empName(lk, r.head_employee_id) || null }; },
    defaults: { unit_type: "department" },
    columns: [{ key: "name_ar", label: t("الوحدة", "Unit") }, { key: "type", label: t("النوع", "Type"), render: (r) => types.find((x) => x.id === r.unit_type)?.label },
      { key: "code", label: t("الرمز", "Code"), render: (r) => <span className="mono">{r.code || ""}</span> },
      { key: "parent", label: t("تتبع", "Under"), render: (r, lk) => lk?.departments?.find((d) => d.id === r.parent_id)?.name_ar || "—" },
      { key: "head", label: t("الرئيس", "Head"), render: (r, lk) => empName(lk, r.head_employee_id) || "—" }],
    fields: [{ key: "name_ar", label: t("الاسم (عربي)", "Name (Arabic)"), required: true }, { key: "name_en", label: t("الاسم (إنجليزي)", "Name (English)"), ltr: true },
      { key: "unit_type", label: t("نوع الوحدة", "Unit type"), type: "select", required: true, options: types },
      { key: "code", label: t("رمز الوحدة (اختياري)", "Unit code (optional)"), ltr: true },
      { key: "parent_id", label: t("تتبع وحدة", "Under unit"), type: "select", import: false, options: (lk, r) => (lk.departments || []).filter((d) => d.id !== r?.id) },
      { key: "parent_ref", label: t("تتبع (رمز أو اسم الوحدة الأعلى)", "Under (code or name of the parent unit)"), formHidden: true,
        hint: t("يمكن أن تكون الوحدة الأعلى في نفس الملف", "The parent may be in the same file") },
      { key: "head_employee_id", label: t("رئيس الوحدة", "Head of unit"), type: "select", import: false, options: (lk) => lk.employees || [] },
      { key: "head_ref", label: t("الرئيس (رقم الموظف أو اسمه)", "Head (employee number or name)"), formHidden: true }],
  }} />;
}

const LEAVE_TYPES = (t) => [
  { id: "annual", label: t("سنوية", "Annual") }, { id: "sick", label: t("مرضية", "Sick") }, { id: "unpaid", label: t("بدون راتب", "Unpaid") },
  { id: "maternity", label: t("وضع", "Maternity") }, { id: "hajj", label: t("حج", "Hajj") }, { id: "marriage", label: t("زواج", "Marriage") },
  { id: "bereavement", label: t("وفاة قريب", "Bereavement") }, { id: "other", label: t("أخرى", "Other") },
];

export function Leave() {
  const { t, can } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const [edit, setEdit] = useState(null);
  const [balance, setBalance] = useState(null);
  const list = useData(() => run(supabase.from("leave_requests").select("*, employees(code, first_name_ar, last_name_ar)").order("start_date", { ascending: false }).limit(500)), []);
  const emps = useData(() => L.employees(), []);
  const types = LEAVE_TYPES(t); const typeLabel = Object.fromEntries(types.map((x) => [x.id, x.label]));

  async function decide(r, ok) {
    const who = `${r.employees?.first_name_ar} ${r.employees?.last_name_ar}`;
    if (!await confirmDialog({ message: ok ? t(`اعتماد إجازة ${who} (${r.days} يوم من ${r.start_date})؟`, `Approve ${who}'s leave?`)
                                           : t(`رفض طلب إجازة ${who}؟`, `Reject ${who}'s leave request?`), danger: !ok })) return;
    if (await act(async () => { await rpc("decide_leave", { p_leave: r.id, p_approve: ok }); return true; }, ok ? t("تم اعتماد الإجازة\nتُخصم من رصيده، والإجازة بدون راتب تُخصم تلقائياً في المسيّر.", "Leave approved") : t("تم رفض طلب الإجازة", "Leave rejected"))) list.reload();
  }
  const leaveFields = [
            { key: "employee_id", label: t("الموظف", "Employee"), type: "select", required: true, options: emps.data || [] },
            { key: "leave_type", label: t("النوع", "Type"), type: "select", required: true, options: types },
            { key: "start_date", label: t("من", "From"), type: "date", required: true }, { key: "end_date", label: t("إلى", "To"), type: "date", required: true },
            { key: "notes", label: t("ملاحظات", "Notes"), wide: true }];
  async function save(e) {
    e.preventDefault();
    const out = validateRecord(leaveFields, edit, t);
    if (edit.start_date && edit.end_date && edit.end_date < edit.start_date) out.push({ key: "end_date", msg: t("تاريخ النهاية قبل تاريخ البداية", "End date is before the start date") });
    if (!iss.check(out)) return;
    const rec = { employee_id: edit.employee_id, leave_type: edit.leave_type, start_date: edit.start_date, end_date: edit.end_date, notes: edit.notes || null };
    if (await act(async () => { await run(supabase.from("leave_requests").insert(rec)); return true; }, t("تم تقديم الطلب", "Request submitted"))) { setEdit(null); list.reload(); }
  }
  async function onEmp(v) {
    setEdit(v);
    if (v.employee_id) setBalance(await rpc("leave_balance", { p_employee: v.employee_id }).catch(() => null));
  }
  return (
    <>
      <PageHead title={t("الإجازات", "Leave")} sub={t("الإجازة بدون راتب تُخصم تلقائياً في مسيّر الرواتب", "Unpaid leave is deducted automatically in payroll")}>
        {can("hr.manage") && <button className="btn primary" onClick={() => { setBalance(null); setEdit({ leave_type: "annual", start_date: today(), end_date: today() }); }}>{t("+ طلب إجازة", "+ Leave request")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table rows={list.data} loading={list.loading} columns={[
          { key: "e", label: t("الموظف", "Employee"), render: (r) => `${r.employees?.code} — ${r.employees?.first_name_ar} ${r.employees?.last_name_ar}` },
          { key: "leave_type", label: t("النوع", "Type"), render: (r) => typeLabel[r.leave_type] },
          { key: "start_date", label: t("من", "From"), type: "date" }, { key: "end_date", label: t("إلى", "To"), type: "date" },
          { key: "days", label: t("الأيام", "Days"), type: "num" },
          { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
          { key: "a", label: "", render: (r) => r.status === "pending" && can("hr.manage") && <span className="row">
              <button className="btn sm" disabled={busy} onClick={() => decide(r, true)}>{t("اعتماد", "Approve")}</button>
              <button className="btn sm danger" disabled={busy} onClick={() => decide(r, false)}>{t("رفض", "Reject")}</button></span> },
        ]} />
      </Panel>
      {edit && <Modal title={t("طلب إجازة", "Leave request")} onClose={() => { setEdit(null); iss.clear(); }}
        footer={<><button className="btn" onClick={() => setEdit(null)}>{t("إلغاء", "Cancel")}</button><button className="btn primary" form="lv" disabled={busy}>{t("تقديم", "Submit")}</button></>}>
        <form id="lv" onSubmit={save} noValidate>
          <Issues issues={iss.issues} />
          <RecordForm value={edit} onChange={onEmp} fields={leaveFields} invalid={iss.has} />
          {balance && <div className="alert" style={{ marginTop: 12 }}>{t("رصيد الإجازة السنوية", "Annual leave balance")}: <b>{balance.balance}</b> {t("يوم", "days")} ({t("مستحق", "accrued")} {balance.accrued} · {t("مستخدم", "taken")} {balance.taken})</div>}
        </form>
      </Modal>}
    </>
  );
}

export function Eosb() {
  const { t, can } = useApp();
  const emps = useData(() => run(supabase.from("employees").select(can("hr.salaries") || can("payroll.view") ? "*, employee_pay(*)" : "*").order("code")), []);
  const [f, setF] = useState({ employee_id: null, wage: 10000, start: "2020-01-01", end: today(), reason: "employer_termination" });
  const pick = (id) => {
    const e = (emps.data || []).find((x) => x.id === id);
    if (!e) return setF({ ...f, employee_id: null });
    setF({ employee_id: id, wage: payOf(e) ? totalPay(payOf(e)) : f.wage,
           start: e.hire_date, end: e.termination_date || today(), reason: e.termination_reason || "employer_termination" });
  };
  const r = eosb(Number(f.wage || 0), f.start, f.end, f.reason);
  const emp = (emps.data || []).find((x) => x.id === f.employee_id);
  const pay = payOf(emp);
  const g = emp && pay ? gosi({ basic: pay.basic_salary, housing: pay.housing_allowance, isSaudi: emp.is_saudi, registered: emp.gosi_registered, scheme: emp.gosi_scheme }) : null;
  return (
    <>
      <PageHead title={t("حاسبة مكافأة نهاية الخدمة", "End-of-service calculator")} sub={t("وفق المادتين 84 و85 من نظام العمل السعودي", "Per Saudi Labour Law articles 84 & 85")} />
      <div className="grid c2">
        <Panel>
          <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label={t("الموظف (اختياري)", "Employee (optional)")} wide>
              <Select value={f.employee_id} onChange={pick} options={(emps.data || []).map((e) => ({ id: e.id, label: `${e.code} — ${e.first_name_ar} ${e.last_name_ar}` }))} /></Field>
            <Field label={t("الأجر الشهري الفعلي", "Monthly wage")} hint={t("الأساسي + البدلات الثابتة", "Basic + fixed allowances")}><input className="num" type="number" value={f.wage} onChange={(e) => setF({ ...f, wage: e.target.value })} /></Field>
            <Field label={t("سبب انتهاء العلاقة", "Reason")}><Select value={f.reason} onChange={(v) => setF({ ...f, reason: v || "employer_termination" })} options={REASONS(t)} /></Field>
            <Field label={t("تاريخ المباشرة", "Start")}><input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
            <Field label={t("آخر يوم عمل", "Last day")}><input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
          </div>
        </Panel>
        <Panel title={t("النتيجة", "Result")}>
          <div className="grid" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><span>{t("مدة الخدمة (سنة)", "Service (years)")}</span><b>{r.years}</b></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span>{t("المكافأة الكاملة", "Full award")}</span><Money v={r.full} /></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span>{t("نسبة الاستحقاق", "Entitlement")}</span><b>{Math.round(r.factor * 1000) / 10}%</b></div>
            <div className="row" style={{ justifyContent: "space-between", fontSize: 18, fontWeight: 700 }}><span>{t("المكافأة المستحقة", "Award due")}</span><Money v={r.amount} /></div>
            {g && <div className="muted" style={{ marginTop: 8 }}>{t("اشتراك التأمينات الشهري", "Monthly GOSI")}: {t("الموظف", "employee")} <Money v={g.employee} /> · {t("المنشأة", "employer")} <Money v={g.employer} /></div>}
            <p className="muted" style={{ fontSize: 12 }}>{t("نصف أجر شهر عن كل سنة من السنوات الخمس الأولى، وأجر شهر عن كل سنة بعدها. في الاستقالة: لا شيء قبل سنتين، الثلث من 2 إلى 5، الثلثان من 5 إلى 10، وكاملة بعد 10.",
              "Half a month per year for the first five years, a full month per year after. On resignation: nothing under 2 years, ⅓ for 2–5, ⅔ for 5–10, full after 10.")}</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
