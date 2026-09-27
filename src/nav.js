// Module registry: sidebar sections + routes, each gated by a permission.
// Adding a module = one entry here + its screens.
import Dashboard from "./screens/Dashboard.jsx";
import * as A from "./screens/accounting.jsx";
import * as S from "./screens/sales.jsx";
import * as P from "./screens/projects.jsx";
import * as F from "./screens/finance.jsx";
import * as H from "./screens/hr.jsx";
import * as Y from "./screens/payroll.jsx";
import * as C from "./screens/settings.jsx";

export const NAV = [
  { group: ["الرئيسية", "Home"], items: [
    { path: "/", label: ["لوحة المعلومات", "Dashboard"], component: Dashboard },
  ]},
  { group: ["المحاسبة", "Accounting"], module: "accounting", items: [
    { path: "/accounting/journals", label: ["القيود اليومية", "Journal entries"], perm: "accounting.view", component: A.Journals },
    { path: "/accounting/accounts", label: ["دليل الحسابات", "Chart of accounts"], perm: "accounting.view", component: A.Accounts },
    { path: "/accounting/trial-balance", label: ["ميزان المراجعة", "Trial balance"], perm: "accounting.view", component: A.TrialBalance },
    { path: "/accounting/statements", label: ["القوائم المالية", "Financial statements"], perm: "accounting.view", component: A.Statements },
    { path: "/accounting/ledger", label: ["كشف حساب", "Account ledger"], perm: "accounting.view", component: A.Ledger },
    { path: "/accounting/periods", label: ["الفترات المالية", "Fiscal periods"], perm: "accounting.view", component: A.Periods },
  ]},
  { group: ["المبيعات والفوترة", "Sales & invoicing"], module: "sales", items: [
    { path: "/sales/invoices", label: ["الفواتير الضريبية", "Tax invoices"], perm: "sales.view", component: S.Invoices },
    { path: "/sales/customers", label: ["العملاء", "Customers"], perm: "sales.view", component: S.Customers },
    { path: "/sales/items", label: ["الخدمات والأصناف", "Services & items"], perm: "sales.view", component: S.Items },
  ]},
  { group: ["المشاريع", "Projects"], module: "projects", items: [
    { path: "/projects", label: ["المشاريع والعقود", "Projects & contracts"], perm: "projects.view", component: P.Projects },
  ]},
  { group: ["المالية", "Finance"], module: "finance", items: [
    { path: "/finance/payments", label: ["سندات القبض والصرف", "Receipts & payments"], perm: "finance.view", component: F.Payments },
    { path: "/finance/bills", label: ["فواتير الموردين", "Vendor bills"], perm: "finance.view", component: F.Bills },
    { path: "/finance/vendors", label: ["الموردون ومقاولو الباطن", "Vendors & subcontractors"], perm: "finance.view", component: F.Vendors },
    { path: "/finance/aging", label: ["أعمار الذمم", "Aging"], perm: "finance.view", component: F.Aging },
    { path: "/finance/vat", label: ["إقرار ضريبة القيمة المضافة", "VAT return"], perm: "accounting.view", component: F.VatReturn },
  ]},
  { group: ["الموارد البشرية", "Human resources"], module: "hr", items: [
    { path: "/hr/employees", label: ["الموظفون", "Employees"], perm: "hr.view", component: H.Employees },
    { path: "/hr/leave", label: ["الإجازات", "Leave"], perm: "hr.view", component: H.Leave },
    { path: "/hr/departments", label: ["الأقسام", "Departments"], perm: "hr.view", component: H.Departments },
    { path: "/hr/eosb", label: ["مكافأة نهاية الخدمة", "End of service"], perm: "hr.view", component: H.Eosb },
  ]},
  { group: ["الرواتب", "Payroll"], module: "payroll", items: [
    { path: "/payroll", label: ["مسيّرات الرواتب", "Payroll runs"], perm: "payroll.view", component: Y.PayrollRuns },
  ]},
  { group: ["الإعدادات", "Settings"], items: [
    { path: "/settings/company", label: ["بيانات الشركة", "Company"], perm: "settings.manage", component: C.Company },
    { path: "/settings/users", label: ["المستخدمون والصلاحيات", "Users & roles"], perm: "users.manage", component: C.Users },
    { path: "/settings/integrations", label: ["الربط والتكامل (API)", "Integrations (API)"], perm: "integrations.manage", component: C.Integrations },
    { path: "/settings/audit", label: ["سجل التدقيق", "Audit log"], perm: "audit.view", component: C.Audit },
  ]},
];

// detail routes (not in the sidebar)
export const DETAIL_ROUTES = [
  { path: "/accounting/journals/:id", perm: "accounting.view", component: A.JournalEditor },
  { path: "/sales/invoices/:id", perm: "sales.view", component: S.InvoiceEditor },
  { path: "/projects/:id", perm: "projects.view", component: P.ProjectDetail },
  { path: "/projects/:id/billing/:billingId", perm: "projects.view", component: P.ProgressBilling },
  { path: "/finance/bills/:id", perm: "finance.view", component: F.BillEditor },
  { path: "/payroll/:id", perm: "payroll.view", component: Y.PayrollRun },
];
