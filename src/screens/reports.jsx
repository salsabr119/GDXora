// Reports centre: one registry of reports grouped by module. Each report
// declares its permission, filters and a loader returning plain rows; the
// page renders KPIs, a table with totals, Excel export and print / PDF.
import { useMemo, useState } from "react";
import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, PageHead, Panel, Table, Money, Loading, Field, go } from "../ui.jsx";
import * as L from "../lookups.js";
import { today } from "../lib/format.js";

/* ── helpers ─────────────────────────────────────────────────────────── */
// PostgREST returns at most 1000 rows per request — page through bigger sets
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run(build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const num = (v, d = 2) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sum = (rows, k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const yearStart = () => today().slice(0, 4) + "-01-01";
const month = (d) => String(d || "").slice(0, 7);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const name = (e) => (e ? `${e.first_name_ar || ""} ${e.last_name_ar || ""}`.trim() : "—");

/** group rows → [{ label, ...sums, n }] sorted by the first sum descending (or by label) */
function groupBy(rows, keyOf, labelOf, sums, { sortByLabel } = {}) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r) ?? "—";
    if (!m.has(k)) m.set(k, { key: k, label: labelOf(r) || "—", n: 0, ...Object.fromEntries(Object.keys(sums).map((s) => [s, 0])) });
    const g = m.get(k);
    g.n += 1;
    for (const [s, f] of Object.entries(sums)) g[s] += Number(f(r) || 0);
  }
  const out = [...m.values()].map((g) => ({ ...g, ...Object.fromEntries(Object.keys(sums).map((s) => [s, round2(g[s])])) }));
  const first = Object.keys(sums)[0];
  return out.sort(sortByLabel ? (a, b) => String(a.key).localeCompare(String(b.key)) : (a, b) => (b[first] || 0) - (a[first] || 0));
}

const NATIONALITY = {
  SA: "سعودي", EG: "مصري", IN: "هندي", PK: "باكستاني", BD: "بنغلاديشي", PH: "فلبيني", YE: "يمني", SD: "سوداني",
  JO: "أردني", SY: "سوري", LB: "لبناني", NP: "نيبالي", LK: "سريلانكي", ID: "إندونيسي", ET: "إثيوبي", KE: "كيني",
  UG: "أوغندي", TR: "تركي", MA: "مغربي", TN: "تونسي", DZ: "جزائري", PS: "فلسطيني", IQ: "عراقي", GB: "بريطاني", US: "أمريكي",
};
const natLabel = (code, t) => (t("ar", "en") === "ar" ? NATIONALITY[code] || code : code);

/* ── report registry ─────────────────────────────────────────────────── */
const DATE_RANGE = (t) => [
  { key: "from", label: t("من تاريخ", "From"), type: "date", default: yearStart },
  { key: "to", label: t("إلى تاريخ", "To"), type: "date", default: today },
];

export const REPORTS = (t) => [
  /* ── HR ── */
  {
    key: "headcount", group: "hr", perm: "hr.view",
    title: t("عدد الموظفين والسعودة", "Headcount & Saudization"),
    desc: t("عدد الموظفين حسب القسم أو الجنسية أو المشروع أو المسمى، مع نسبة السعودة", "Employees by department, nationality, project or title, with the Saudization ratio"),
    filters: [
      { key: "by", label: t("التجميع حسب", "Group by"), type: "select", default: () => "department", options: [
        { id: "department", label: t("القسم", "Department") }, { id: "nationality", label: t("الجنسية", "Nationality") },
        { id: "project", label: t("المشروع", "Project") }, { id: "job", label: t("المسمى الوظيفي", "Job title") },
        { id: "gender", label: t("الجنس", "Gender") }] },
      { key: "scope", label: t("الموظفون", "Employees"), type: "select", default: () => "active", options: [
        { id: "active", label: t("على رأس العمل", "In service") }, { id: "all", label: t("الكل (مع منتهي الخدمة)", "All (incl. terminated)") }] },
    ],
    async load(f) {
      const [emps, projects] = await Promise.all([
        fetchAll(() => supabase.from("employees").select("id, nationality, is_saudi, gender, job_title, status, project_id, hire_date, termination_date, departments!employees_department_id_fkey(name_ar)").order("code")),
        L.projects()]);
      const list = f.scope === "all" ? emps : emps.filter((e) => e.status !== "terminated");
      const proj = Object.fromEntries(projects.map((p) => [p.id, p.name_ar]));
      const key = { department: (e) => e.departments?.name_ar || t("بدون قسم", "No department"), nationality: (e) => e.nationality,
                    project: (e) => proj[e.project_id] || t("بدون مشروع", "No project"), job: (e) => e.job_title || t("غير محدد", "Not set"),
                    gender: (e) => (e.gender === "female" ? t("أنثى", "Female") : e.gender === "male" ? t("ذكر", "Male") : t("غير محدد", "Not set")) }[f.by];
      const label = f.by === "nationality" ? (e) => natLabel(e.nationality, t) : key;
      const rows = groupBy(list, key, label, { saudi: (e) => (e.is_saudi ? 1 : 0), non_saudi: (e) => (e.is_saudi ? 0 : 1) })
        .map((g) => ({ ...g, total: g.n, saudization: pct(g.saudi, g.n), share: pct(g.n, list.length) }))
        .sort((a, b) => b.total - a.total);
      const year = today().slice(0, 4);
      const saudi = list.filter((e) => e.is_saudi).length;
      return {
        rows,
        kpis: [
          { label: t("إجمالي الموظفين", "Employees"), value: list.length, int: true },
          { label: t("سعوديون", "Saudi"), value: saudi, int: true },
          { label: t("غير سعوديين", "Non-Saudi"), value: list.length - saudi, int: true },
          { label: t("نسبة السعودة", "Saudization"), text: pct(saudi, list.length) },
          { label: t(`التعيينات في ${year}`, `Hires in ${year}`), value: emps.filter((e) => String(e.hire_date).startsWith(year)).length, int: true },
          { label: t(`انتهاء الخدمة في ${year}`, `Leavers in ${year}`), value: emps.filter((e) => String(e.termination_date || "").startsWith(year)).length, int: true },
        ],
        columns: [
          { key: "label", label: { department: t("القسم", "Department"), nationality: t("الجنسية", "Nationality"), project: t("المشروع", "Project"), job: t("المسمى", "Title"), gender: t("الجنس", "Gender") }[f.by] },
          { key: "total", label: t("العدد", "Count"), type: "num", total: true },
          { key: "saudi", label: t("سعودي", "Saudi"), type: "num", total: true },
          { key: "non_saudi", label: t("غير سعودي", "Non-Saudi"), type: "num", total: true },
          { key: "saudization", label: t("نسبة السعودة", "Saudization") },
          { key: "share", label: t("من الإجمالي", "Share") },
        ],
      };
    },
  },
  {
    key: "expiry", group: "hr", perm: "hr.view",
    title: t("الوثائق والعقود قرب الانتهاء", "Expiring documents & contracts"),
    desc: t("الهويات والإقامات والجوازات والعقود محددة المدة المنتهية أو التي تنتهي قريباً", "IDs / iqamas, passports and fixed-term contracts that expired or expire soon"),
    filters: [{ key: "days", label: t("خلال", "Within"), type: "select", default: () => "60", options: [
      { id: "30", label: t("30 يوماً", "30 days") }, { id: "60", label: t("60 يوماً", "60 days") }, { id: "90", label: t("90 يوماً", "90 days") },
      { id: "180", label: t("6 أشهر", "6 months") }, { id: "365", label: t("سنة", "1 year") }] }],
    async load(f) {
      const emps = await fetchAll(() => supabase.from("employees")
        .select("code, first_name_ar, last_name_ar, nationality, is_saudi, national_id, passport_no, id_expiry, passport_expiry, contract_type, contract_end_date, status, departments!employees_department_id_fkey(name_ar)")
        .neq("status", "terminated").order("code"));
      const now = today(); const rows = [];
      for (const e of emps) {
        const docs = [
          [e.id_expiry, e.is_saudi ? t("الهوية الوطنية", "National ID") : t("الإقامة", "Iqama"), e.national_id],
          [e.passport_expiry, t("جواز السفر", "Passport"), e.passport_no],
          [e.contract_type === "limited" ? e.contract_end_date : null, t("عقد العمل", "Employment contract"), null],
        ];
        for (const [d, doc, no] of docs) {
          if (!d) continue;
          const left = daysBetween(now, d);
          if (left > Number(f.days)) continue;
          rows.push({ code: e.code, name: name(e), department: e.departments?.name_ar || "—", doc, no: no || "", date: d, left,
                      state: left < 0 ? t(`منتهية منذ ${-left} يوم`, `Expired ${-left} days ago`) : left === 0 ? t("تنتهي اليوم", "Expires today") : t(`باقي ${left} يوم`, `${left} days left`) });
        }
      }
      rows.sort((a, b) => a.left - b.left);
      return {
        rows,
        kpis: [
          { label: t("منتهية", "Expired"), value: rows.filter((r) => r.left < 0).length, int: true, bad: true },
          { label: t("خلال 30 يوماً", "Within 30 days"), value: rows.filter((r) => r.left >= 0 && r.left <= 30).length, int: true },
          { label: t("الإجمالي في الفترة", "Total in range"), value: rows.length, int: true },
        ],
        columns: [
          { key: "code", label: t("الرقم", "No.") }, { key: "name", label: t("الموظف", "Employee") }, { key: "department", label: t("القسم", "Department") },
          { key: "doc", label: t("الوثيقة", "Document") }, { key: "no", label: t("الرقم", "Number") },
          { key: "date", label: t("تاريخ الانتهاء", "Expiry"), type: "date" }, { key: "state", label: t("الحالة", "Status"), bad: (r) => r.left < 0 },
        ],
        empty: t("لا توجد وثائق تنتهي في هذه الفترة", "Nothing expires in this period"),
      };
    },
  },
  {
    key: "leave", group: "hr", perm: "hr.view",
    title: t("أرصدة الإجازات السنوية", "Annual leave balances"),
    desc: t("المستحق والمستخدم والمتبقي لكل موظف حتى تاريخ معيّن", "Accrued, taken and remaining days per employee at a date"),
    filters: [{ key: "as_of", label: t("حتى تاريخ", "As of"), type: "date", default: today }],
    async load(f) {
      const rows = ((await rpc("report_leave_balances", { p_as_of: f.as_of })) || []).map((r) => ({ ...r, name: name(r), department: r.department || "—",
        accrued: Number(r.accrued), taken: Number(r.taken), balance: Number(r.balance), unpaid_taken: Number(r.unpaid_taken) }));
      return {
        rows,
        kpis: [
          { label: t("الموظفون", "Employees"), value: rows.length, int: true },
          { label: t("إجمالي الأيام المتبقية", "Total days remaining"), value: round2(sum(rows, "balance")) },
          { label: t("متوسط الرصيد", "Average balance"), value: rows.length ? round2(sum(rows, "balance") / rows.length) : 0 },
        ],
        columns: [
          { key: "code", label: t("الرقم", "No.") }, { key: "name", label: t("الموظف", "Employee") }, { key: "department", label: t("القسم", "Department") },
          { key: "hire_date", label: t("تاريخ المباشرة", "Hired"), type: "date" }, { key: "annual_leave_days", label: t("الاستحقاق السنوي", "Days / year"), type: "num" },
          { key: "accrued", label: t("المستحق", "Accrued"), type: "num", total: true }, { key: "taken", label: t("المستخدم", "Taken"), type: "num", total: true },
          { key: "balance", label: t("المتبقي", "Balance"), type: "num", total: true }, { key: "unpaid_taken", label: t("إجازات بدون راتب", "Unpaid leave"), type: "num", total: true },
        ],
      };
    },
  },
  {
    key: "eosb", group: "hr", perm: "hr.salaries",
    title: t("مخصص مكافأة نهاية الخدمة", "End-of-service provision"),
    desc: t("التزام نهاية الخدمة لكل موظف حتى تاريخ معيّن (المادتان 84 و85)، ومقارنته برصيد المخصص في الدفاتر", "End-of-service liability per employee at a date (art. 84/85), compared with the provision in the books"),
    filters: [{ key: "as_of", label: t("حتى تاريخ", "As of"), type: "date", default: today }],
    async load(f, { can }) {
      const rows = ((await rpc("report_eosb", { p_as_of: f.as_of })) || []).map((r) => ({ ...r, name: name(r), department: r.department || "—",
        years: Number(r.years), monthly_wage: Number(r.monthly_wage), on_termination: Number(r.on_termination), on_resignation: Number(r.on_resignation) }));
      const kpis = [
        { label: t("الالتزام (إنهاء من صاحب العمل)", "Liability (employer termination)"), value: round2(sum(rows, "on_termination")), money: true },
        { label: t("الالتزام (لو استقال الجميع)", "Liability (if all resign)"), value: round2(sum(rows, "on_resignation")), money: true },
      ];
      if (can("accounting.view")) {
        const [tb, acc] = await Promise.all([rpc("trial_balance", { p_to: f.as_of }), run(supabase.from("accounts").select("id").eq("system_key", "eosb_provision"))]);
        const book = -Number((tb || []).find((r) => r.account_id === acc?.[0]?.id)?.closing || 0);
        kpis.push({ label: t("رصيد المخصص في الدفاتر", "Provision in the books"), value: book, money: true },
                  { label: t("الفرق المطلوب تسجيله", "Difference to record"), value: round2(sum(rows, "on_termination") - book), money: true, bad: Math.abs(sum(rows, "on_termination") - book) >= 1 });
      }
      return {
        rows, kpis,
        note: t("الأجر = الأساسي + البدلات الثابتة. نصف شهر عن كل سنة من أول خمس سنوات وشهر عن كل سنة بعدها؛ في الاستقالة: لا شيء قبل سنتين، الثلث حتى 5، الثلثان حتى 10.",
                "Wage = basic + fixed allowances. Half a month per year for the first five years, a month per year after; on resignation: nothing under 2 years, ⅓ to 5, ⅔ to 10."),
        columns: [
          { key: "code", label: t("الرقم", "No.") }, { key: "name", label: t("الموظف", "Employee") }, { key: "department", label: t("القسم", "Department") },
          { key: "hire_date", label: t("تاريخ المباشرة", "Hired"), type: "date" }, { key: "years", label: t("سنوات الخدمة", "Years"), type: "num" },
          { key: "monthly_wage", label: t("الأجر الشهري", "Monthly wage"), type: "money", total: true },
          { key: "on_termination", label: t("المكافأة عند الإنهاء", "Award on termination"), type: "money", total: true },
          { key: "on_resignation", label: t("المكافأة عند الاستقالة", "Award on resignation"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "payroll-cost", group: "hr", perm: "payroll.view",
    title: t("تكلفة الرواتب", "Payroll cost"),
    desc: t("تكلفة الرواتب المعتمدة حسب الشهر أو القسم أو المشروع أو الموظف، شاملة حصة المنشأة في التأمينات", "Approved payroll cost by month, department, project or employee, including the employer GOSI share"),
    filters: [
      { key: "from", label: t("من شهر", "From month"), type: "month", default: () => today().slice(0, 4) + "-01" },
      { key: "to", label: t("إلى شهر", "To month"), type: "month", default: () => today().slice(0, 7) },
      { key: "by", label: t("التجميع حسب", "Group by"), type: "select", default: () => "month", options: [
        { id: "month", label: t("الشهر", "Month") }, { id: "department", label: t("القسم", "Department") },
        { id: "project", label: t("المشروع", "Project") }, { id: "employee", label: t("الموظف", "Employee") }] },
    ],
    async load(f) {
      const runs = await run(supabase.from("payroll_runs").select("id, period, status").gte("period", f.from).lte("period", f.to).in("status", ["approved", "posted"]));
      const period = Object.fromEntries(runs.map((r) => [r.id, r.period]));
      const [lines, projects] = await Promise.all([
        runs.length ? fetchAll(() => supabase.from("payroll_lines")
          .select("run_id, employee_id, project_id, gross, gosi_employee, gosi_employer, advance_deduction, other_deductions, net, employees(code, first_name_ar, last_name_ar, departments!employees_department_id_fkey(name_ar))")
          .in("run_id", runs.map((r) => r.id))) : [],
        L.projects()]);
      const proj = Object.fromEntries(projects.map((p) => [p.id, p.name_ar]));
      const key = { month: (l) => period[l.run_id], department: (l) => l.employees?.departments?.name_ar || t("بدون قسم", "No department"),
                    project: (l) => proj[l.project_id] || t("بدون مشروع (مصروف عام)", "No project (overhead)"), employee: (l) => l.employee_id }[f.by];
      const label = f.by === "employee" ? (l) => `${l.employees?.code || ""} — ${name(l.employees)}` : key;
      const rows = groupBy(lines, key, label, {
        gross: (l) => l.gross, gosi_employer: (l) => l.gosi_employer, cost: (l) => Number(l.gross) + Number(l.gosi_employer),
        deductions: (l) => Number(l.gosi_employee) + Number(l.advance_deduction) + Number(l.other_deductions), net: (l) => l.net,
      }, { sortByLabel: f.by === "month" });
      return {
        rows,
        kpis: [
          { label: t("إجمالي التكلفة", "Total cost"), value: round2(sum(rows, "cost")), money: true },
          { label: t("إجمالي الرواتب", "Gross pay"), value: round2(sum(rows, "gross")), money: true },
          { label: t("حصة المنشأة في التأمينات", "Employer GOSI"), value: round2(sum(rows, "gosi_employer")), money: true },
          { label: t("صافي المدفوع", "Net paid"), value: round2(sum(rows, "net")), money: true },
        ],
        note: runs.length ? null : t("لا توجد مسيّرات معتمدة في هذه الفترة.", "No approved payroll runs in this period."),
        columns: [
          { key: "label", label: { month: t("الشهر", "Month"), department: t("القسم", "Department"), project: t("المشروع", "Project"), employee: t("الموظف", "Employee") }[f.by] },
          { key: "n", label: f.by === "employee" ? t("عدد الأشهر", "Months") : t("أسطر الرواتب", "Pay lines"), type: "num", total: true },
          { key: "gross", label: t("إجمالي الرواتب", "Gross"), type: "money", total: true },
          { key: "gosi_employer", label: t("تأمينات المنشأة", "Employer GOSI"), type: "money", total: true },
          { key: "cost", label: t("إجمالي التكلفة", "Total cost"), type: "money", total: true },
          { key: "deductions", label: t("الاستقطاعات", "Deductions"), type: "money", total: true },
          { key: "net", label: t("الصافي", "Net"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "gosi", group: "hr", perm: "payroll.view",
    title: t("كشف التأمينات الاجتماعية الشهري", "Monthly GOSI statement"),
    desc: t("الأجر الخاضع وحصة الموظف وحصة المنشأة لكل موظف في مسيّر شهر معيّن", "Contributory wage and employee / employer shares per employee for a month's payroll"),
    filters: [{ key: "period", label: t("الشهر", "Month"), type: "month", default: () => today().slice(0, 7) }],
    async load(f) {
      const runs = await run(supabase.from("payroll_runs").select("id, status").eq("period", f.period));
      if (!runs.length) return { rows: [], columns: [], empty: t("لا يوجد مسيّر رواتب لهذا الشهر", "No payroll run for this month") };
      const lines = await fetchAll(() => supabase.from("payroll_lines")
        .select("is_saudi, gosi_wage, gosi_employee, gosi_employer, employees(code, first_name_ar, last_name_ar, national_id, gosi_number, nationality)")
        .eq("run_id", runs[0].id));
      const rows = lines.map((l) => ({ code: l.employees?.code, name: name(l.employees), national_id: l.employees?.national_id || "", gosi_number: l.employees?.gosi_number || "",
        nationality: natLabel(l.employees?.nationality, t), wage: Number(l.gosi_wage), emp: Number(l.gosi_employee), er: Number(l.gosi_employer),
        total: round2(Number(l.gosi_employee) + Number(l.gosi_employer)) })).sort((a, b) => String(a.code).localeCompare(String(b.code)));
      return {
        rows,
        kpis: [
          { label: t("حصة الموظفين", "Employee share"), value: round2(sum(rows, "emp")), money: true },
          { label: t("حصة المنشأة", "Employer share"), value: round2(sum(rows, "er")), money: true },
          { label: t("المستحق للتأمينات", "Due to GOSI"), value: round2(sum(rows, "total")), money: true },
        ],
        note: runs[0].status === "draft" ? t("المسيّر لهذا الشهر ما زال مسودة — الأرقام قد تتغير.", "This month's payroll is still a draft — figures may change.") : null,
        columns: [
          { key: "code", label: t("الرقم", "No.") }, { key: "name", label: t("الموظف", "Employee") }, { key: "national_id", label: t("الهوية / الإقامة", "ID / Iqama") },
          { key: "gosi_number", label: t("رقم المشترك", "GOSI no.") }, { key: "nationality", label: t("الجنسية", "Nationality") },
          { key: "wage", label: t("الأجر الخاضع", "Contributory wage"), type: "money", total: true },
          { key: "emp", label: t("حصة الموظف", "Employee"), type: "money", total: true }, { key: "er", label: t("حصة المنشأة", "Employer"), type: "money", total: true },
          { key: "total", label: t("الإجمالي", "Total"), type: "money", total: true },
        ],
      };
    },
  },

  /* ── finance ── */
  {
    key: "cash", group: "finance", perm: "accounting.view",
    title: t("حركة النقد والبنوك", "Cash & bank movement"),
    desc: t("الرصيد الافتتاحي والمقبوضات والمدفوعات والرصيد الختامي لكل صندوق وبنك", "Opening balance, receipts, payments and closing balance per cash and bank account"),
    filters: DATE_RANGE(t),
    async load(f) {
      const [tb, cash] = await Promise.all([rpc("trial_balance", { p_from: f.from, p_to: f.to }), L.accounts({ cash: true })]);
      const ids = new Set(cash.map((a) => a.id));
      const rows = (tb || []).filter((r) => ids.has(r.account_id)).map((r) => ({ label: `${r.code} — ${r.name_ar}`, opening: Number(r.opening), in: Number(r.debit), out: Number(r.credit), closing: Number(r.closing) }));
      return {
        rows,
        kpis: [
          { label: t("الرصيد الافتتاحي", "Opening"), value: round2(sum(rows, "opening")), money: true },
          { label: t("المقبوضات", "Receipts"), value: round2(sum(rows, "in")), money: true },
          { label: t("المدفوعات", "Payments"), value: round2(sum(rows, "out")), money: true },
          { label: t("الرصيد الختامي", "Closing"), value: round2(sum(rows, "closing")), money: true },
        ],
        columns: [
          { key: "label", label: t("الحساب", "Account") }, { key: "opening", label: t("افتتاحي", "Opening"), type: "money", total: true },
          { key: "in", label: t("مقبوضات", "Receipts"), type: "money", total: true }, { key: "out", label: t("مدفوعات", "Payments"), type: "money", total: true },
          { key: "closing", label: t("ختامي", "Closing"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "expenses", group: "finance", perm: "accounting.view",
    title: t("المصروفات والتكاليف", "Expenses & costs"),
    desc: t("المصروفات المرحّلة حسب الحساب أو الشهر أو المشروع", "Posted expenses by account, month or project"),
    filters: [...DATE_RANGE(t), { key: "by", label: t("التجميع حسب", "Group by"), type: "select", default: () => "account", options: [
      { id: "account", label: t("الحساب", "Account") }, { id: "month", label: t("الشهر", "Month") }, { id: "project", label: t("المشروع", "Project") }] }],
    async load(f) {
      const [lines, projects] = await Promise.all([
        fetchAll(() => supabase.from("journal_lines")
          .select("debit, credit, project_id, account_id, accounts!inner(code, name_ar, type), journal_entries!inner(entry_date, status)")
          .eq("accounts.type", "expense").in("journal_entries.status", ["posted", "reversed"])
          .gte("journal_entries.entry_date", f.from).lte("journal_entries.entry_date", f.to)),
        L.projects()]);
      const proj = Object.fromEntries(projects.map((p) => [p.id, p.name_ar]));
      const key = { account: (l) => l.accounts.code, month: (l) => month(l.journal_entries.entry_date), project: (l) => l.project_id || "—" }[f.by];
      const label = { account: (l) => `${l.accounts.code} — ${l.accounts.name_ar}`, month: (l) => month(l.journal_entries.entry_date),
                      project: (l) => proj[l.project_id] || t("مصروفات عامة (بدون مشروع)", "Overhead (no project)") }[f.by];
      const rows = groupBy(lines, key, label, { amount: (l) => Number(l.debit) - Number(l.credit) }, { sortByLabel: f.by !== "project" })
        .filter((g) => Math.abs(g.amount) >= 0.005);
      const total = sum(rows, "amount");
      rows.forEach((r) => { r.share = pct(r.amount, total); });
      return {
        rows,
        kpis: [{ label: t("إجمالي المصروفات", "Total expenses"), value: round2(total), money: true },
               { label: t("على المشاريع", "Charged to projects"), value: round2(lines.filter((l) => l.project_id).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0)), money: true }],
        columns: [
          { key: "label", label: { account: t("الحساب", "Account"), month: t("الشهر", "Month"), project: t("المشروع", "Project") }[f.by] },
          { key: "amount", label: t("المبلغ", "Amount"), type: "money", total: true }, { key: "share", label: t("النسبة", "Share") },
        ],
      };
    },
  },
  {
    key: "sales-customer", group: "finance", perm: "sales.view",
    title: t("المبيعات حسب العميل", "Sales by customer"),
    desc: t("الفواتير الصادرة في الفترة لكل عميل (الإشعارات الدائنة تُخصم)، مع المحصّل والمتبقي", "Invoices issued in the period per customer (credit notes deducted), with collected and outstanding"),
    filters: DATE_RANGE(t),
    async load(f) {
      const inv = await fetchAll(() => supabase.from("invoices").select("doc_type, customer_id, taxable_amount, vat_amount, total, net_payable, amount_paid, customers(name_ar)")
        .eq("status", "issued").gte("issue_date", f.from).lte("issue_date", f.to));
      const s = (r) => (r.doc_type === "credit_note" ? -1 : 1);
      const rows = groupBy(inv, (r) => r.customer_id || "cash", (r) => r.customers?.name_ar || t("عميل نقدي", "Cash customer"), {
        taxable: (r) => s(r) * r.taxable_amount, vat: (r) => s(r) * r.vat_amount, total: (r) => s(r) * r.total,
        paid: (r) => s(r) * r.amount_paid, balance: (r) => s(r) * (Number(r.net_payable) - Number(r.amount_paid)),
      });
      return {
        rows,
        kpis: [{ label: t("المبيعات قبل الضريبة", "Sales excl. VAT"), value: round2(sum(rows, "taxable")), money: true },
               { label: t("ضريبة المخرجات", "Output VAT"), value: round2(sum(rows, "vat")), money: true },
               { label: t("المحصّل", "Collected"), value: round2(sum(rows, "paid")), money: true },
               { label: t("المتبقي على العملاء", "Outstanding"), value: round2(sum(rows, "balance")), money: true }],
        columns: [
          { key: "label", label: t("العميل", "Customer") }, { key: "n", label: t("المستندات", "Documents"), type: "num", total: true },
          { key: "taxable", label: t("قبل الضريبة", "Excl. VAT"), type: "money", total: true }, { key: "vat", label: t("الضريبة", "VAT"), type: "money", total: true },
          { key: "total", label: t("الإجمالي", "Total"), type: "money", total: true }, { key: "paid", label: t("المحصّل", "Collected"), type: "money", total: true },
          { key: "balance", label: t("المتبقي", "Outstanding"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "sales-month", group: "finance", perm: "sales.view",
    title: t("المبيعات الشهرية", "Monthly sales"),
    desc: t("المبيعات والضريبة لكل شهر", "Sales and VAT per month"),
    filters: DATE_RANGE(t),
    async load(f) {
      const inv = await fetchAll(() => supabase.from("invoices").select("doc_type, issue_date, taxable_amount, vat_amount, total")
        .eq("status", "issued").gte("issue_date", f.from).lte("issue_date", f.to));
      const s = (r) => (r.doc_type === "credit_note" ? -1 : 1);
      const rows = groupBy(inv, (r) => month(r.issue_date), (r) => month(r.issue_date), {
        taxable: (r) => s(r) * r.taxable_amount, vat: (r) => s(r) * r.vat_amount, total: (r) => s(r) * r.total,
      }, { sortByLabel: true });
      return {
        rows,
        kpis: [{ label: t("المبيعات قبل الضريبة", "Sales excl. VAT"), value: round2(sum(rows, "taxable")), money: true },
               { label: t("متوسط الشهر", "Monthly average"), value: rows.length ? round2(sum(rows, "taxable") / rows.length) : 0, money: true }],
        columns: [
          { key: "label", label: t("الشهر", "Month") }, { key: "n", label: t("المستندات", "Documents"), type: "num", total: true },
          { key: "taxable", label: t("قبل الضريبة", "Excl. VAT"), type: "money", total: true }, { key: "vat", label: t("الضريبة", "VAT"), type: "money", total: true },
          { key: "total", label: t("الإجمالي", "Total"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "purchases-vendor", group: "finance", perm: "finance.view",
    title: t("المشتريات حسب المورد", "Purchases by vendor"),
    desc: t("فواتير الموردين المرحّلة في الفترة لكل مورد، مع المدفوع والمتبقي", "Posted vendor bills in the period per vendor, with paid and outstanding"),
    filters: DATE_RANGE(t),
    async load(f) {
      const bills = await fetchAll(() => supabase.from("bills").select("vendor_id, subtotal, vat_amount, total, net_payable, amount_paid, vendors(name_ar)")
        .eq("status", "posted").gte("bill_date", f.from).lte("bill_date", f.to));
      const rows = groupBy(bills, (r) => r.vendor_id, (r) => r.vendors?.name_ar, {
        subtotal: (r) => r.subtotal, vat: (r) => r.vat_amount, total: (r) => r.total, paid: (r) => r.amount_paid,
        balance: (r) => Number(r.net_payable) - Number(r.amount_paid),
      });
      return {
        rows,
        kpis: [{ label: t("المشتريات قبل الضريبة", "Purchases excl. VAT"), value: round2(sum(rows, "subtotal")), money: true },
               { label: t("ضريبة المدخلات", "Input VAT"), value: round2(sum(rows, "vat")), money: true },
               { label: t("المتبقي للموردين", "Outstanding"), value: round2(sum(rows, "balance")), money: true }],
        columns: [
          { key: "label", label: t("المورد", "Vendor") }, { key: "n", label: t("الفواتير", "Bills"), type: "num", total: true },
          { key: "subtotal", label: t("قبل الضريبة", "Excl. VAT"), type: "money", total: true }, { key: "vat", label: t("الضريبة", "VAT"), type: "money", total: true },
          { key: "total", label: t("الإجمالي", "Total"), type: "money", total: true }, { key: "paid", label: t("المدفوع", "Paid"), type: "money", total: true },
          { key: "balance", label: t("المتبقي", "Outstanding"), type: "money", total: true },
        ],
      };
    },
  },
  {
    key: "overdue", group: "finance", perm: "sales.view",
    title: t("الفواتير المتأخرة السداد", "Overdue invoices"),
    desc: t("فواتير تجاوزت تاريخ الاستحقاق ولم تُحصّل بالكامل", "Invoices past their due date and not fully collected"),
    filters: [{ key: "as_of", label: t("كما في", "As of"), type: "date", default: today }],
    async load(f) {
      const inv = await fetchAll(() => supabase.from("invoices").select("number, issue_date, due_date, net_payable, amount_paid, customers(name_ar), projects(name_ar)")
        .eq("status", "issued").neq("doc_type", "credit_note").lt("due_date", f.as_of).order("due_date"));
      const rows = inv.map((r) => ({ number: r.number, customer: r.customers?.name_ar || t("عميل نقدي", "Cash customer"), project: r.projects?.name_ar || "—",
        issue_date: r.issue_date, due_date: r.due_date, days: daysBetween(r.due_date, f.as_of), net: Number(r.net_payable), balance: round2(Number(r.net_payable) - Number(r.amount_paid)) }))
        .filter((r) => r.balance > 0.005);
      return {
        rows,
        kpis: [{ label: t("إجمالي المتأخر", "Total overdue"), value: round2(sum(rows, "balance")), money: true, bad: rows.length > 0 },
               { label: t("عدد الفواتير", "Invoices"), value: rows.length, int: true },
               { label: t("متأخر أكثر من 90 يوماً", "Over 90 days"), value: round2(sum(rows.filter((r) => r.days > 90), "balance")), money: true }],
        empty: t("لا توجد فواتير متأخرة 👍", "No overdue invoices 👍"),
        columns: [
          { key: "number", label: t("الفاتورة", "Invoice") }, { key: "customer", label: t("العميل", "Customer") }, { key: "project", label: t("المشروع", "Project") },
          { key: "issue_date", label: t("التاريخ", "Date"), type: "date" }, { key: "due_date", label: t("الاستحقاق", "Due"), type: "date" },
          { key: "days", label: t("أيام التأخير", "Days late"), type: "num", bad: (r) => r.days > 90 },
          { key: "net", label: t("المستحق", "Amount"), type: "money", total: true }, { key: "balance", label: t("المتبقي", "Outstanding"), type: "money", total: true },
        ],
      };
    },
  },
];

const GROUPS = (t) => [
  { id: "hr", title: t("الموارد البشرية والرواتب", "HR & payroll"), icon: "👥" },
  { id: "finance", title: t("المالية والمحاسبة", "Finance & accounting"), icon: "📊" },
];
/** every permission that opens at least one report — used by the sidebar */
export const REPORT_PERMS = ["hr.view", "hr.salaries", "payroll.view", "accounting.view", "sales.view", "finance.view"];

/* ── screens ─────────────────────────────────────────────────────────── */
export function ReportsHome() {
  const { t, can } = useApp();
  const list = REPORTS(t).filter((r) => can(r.perm));
  return (
    <>
      <PageHead title={t("التقارير", "Reports")} sub={t("كل تقرير قابل للتصفية والتصدير إلى Excel والطباعة", "Every report can be filtered, exported to Excel and printed")} />
      {GROUPS(t).map((g) => {
        const items = list.filter((r) => r.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} style={{ marginBottom: 20 }}>
            <h2 className="section-title" style={{ fontSize: 16 }}>{g.icon} {g.title}</h2>
            <div className="grid c3">
              {items.map((r) => (
                <button key={r.key} className="panel report-card" onClick={() => go(`/reports/${r.key}`)}>
                  <b>{r.title}</b><span className="muted">{r.desc}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {!list.length && <div className="empty">{t("لا توجد تقارير متاحة لدورك", "No reports are available for your role")}</div>}
    </>
  );
}

export function ReportView({ params }) {
  const { t, can, org } = useApp();
  const report = REPORTS(t).find((r) => r.key === params.key);
  const [f, setF] = useState(() => Object.fromEntries((report?.filters || []).map((x) => [x.key, x.default()])));
  const d = useData(async () => (report && can(report.perm) ? report.load(f, { can }) : null), [params.key, JSON.stringify(f)]);
  const totals = useMemo(() => {
    const res = d.data; if (!res?.rows?.length) return null;
    const cols = res.columns.filter((c) => c.total);
    if (!cols.length) return null;
    return Object.fromEntries([[res.columns[0].key, t("الإجمالي", "Total")], ...cols.map((c) => [c.key, round2(sum(res.rows, c.key))])]);
  }, [d.data, t]);

  if (!report || !can(report.perm)) return <div className="empty">{t("التقرير غير موجود أو لا تملك صلاحية له", "Report not found or not permitted")}</div>;
  const res = d.data;
  const filterText = report.filters.map((x) => `${x.label}: ${x.type === "select" ? x.options.find((o) => o.id === f[x.key])?.label : f[x.key]}`).join(" · ");
  const columns = (res?.columns || []).map((c) => ({
    ...c, n: c.type === "num" || c.type === "money",
    render: c.bad ? (r) => <span className={c.bad(r) ? "neg" : ""}>{c.type === "num" ? num(r[c.key], 0) : r[c.key]}</span> : undefined,
    exportValue: c.bad ? (r) => r[c.key] : undefined,
  }));

  return (
    <>
      <PageHead title={report.title} sub={report.desc}>
        <button className="btn" onClick={() => go("/reports")}>{t("كل التقارير", "All reports")}</button>
        <button className="btn" onClick={() => window.print()}>🖨 {t("طباعة / PDF", "Print / PDF")}</button>
      </PageHead>
      <div className="print-only report-print-head">
        <b>{org.name_ar}</b><h2>{report.title}</h2><div className="muted">{filterText} — {t("تاريخ الطباعة", "Printed")} {today()}</div>
      </div>
      <Panel>
        <div className="row no-print" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {report.filters.map((x) => (
            <Field key={x.key} label={x.label}>
              {x.type === "select"
                ? <select value={f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>{x.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
                : <input type={x.type} value={f[x.key]} onChange={(e) => e.target.value && setF({ ...f, [x.key]: e.target.value })} />}
            </Field>))}
        </div>
      </Panel>
      {!res ? <Loading /> : (
        <>
          {res.kpis?.length > 0 && (
            <div className="grid k4" style={{ margin: "16px 0" }}>
              {res.kpis.map((k) => (
                <div key={k.label} className="panel kpi"><div className="l">{k.label}</div>
                  <div className={`v ${k.bad ? "neg" : ""}`}>{k.text ?? (k.money ? <Money v={k.value} /> : num(k.value, k.int ? 0 : 2))}</div></div>))}
            </div>)}
          {res.note && <div className="alert">{res.note}</div>}
          <Panel pad={false}>
            <Table rows={res.rows} columns={columns} loading={d.loading} empty={res.empty}
                   exportName={`${report.title} ${filterText.replace(/[:·]/g, " ")}`} exportTotals={totals}
                   footer={totals && columns.map((c, i) => <td key={c.key} className={c.n ? "n" : ""}>
                     {i === 0 ? totals[c.key] : c.key in totals ? (c.type === "money" ? <Money v={totals[c.key]} currency={null} /> : num(totals[c.key], 0)) : ""}</td>)} />
          </Panel>
        </>
      )}
    </>
  );
}
