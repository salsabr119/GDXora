import { supabase, rpc, run } from "../supabase.js";
import { useApp, useData, PageHead, Panel, Table, Money, StatusBadge, go } from "../ui.jsx";
import { today } from "../lib/format.js";

const safe = async (fn) => { try { return await fn(); } catch { return null; } };

export default function Dashboard() {
  const { t, can, org } = useApp();
  const monthStart = today().slice(0, 8) + "01";

  const d = useData(async () => {
    const [tbMonth, tbAll, invoices, bills, projects, payroll] = await Promise.all([
      can("accounting.view") ? safe(() => rpc("trial_balance", { p_from: monthStart, p_to: today() })) : null,
      can("accounting.view") ? safe(() => rpc("trial_balance", {})) : null,
      can("sales.view") ? safe(() => run(supabase.from("invoices")
        .select("id, number, doc_type, status, issue_date, total, net_payable, amount_paid, zatca_status, customers(name_ar)")
        .order("created_at", { ascending: false }).limit(8))) : null,
      can("finance.view") ? safe(() => run(supabase.from("bills").select("net_payable, amount_paid").eq("status", "posted"))) : null,
      can("projects.view") ? safe(() => rpc("project_summary", {})) : null,
      can("payroll.view") ? safe(() => run(supabase.from("payroll_runs").select("period, total_net, status").order("period", { ascending: false }).limit(1))) : null,
    ]);
    const sumType = (tb, type) => (tb || []).filter((r) => r.type === type).reduce((n, r) => n + Number(r.closing), 0);
    const cashIds = tbAll ? new Set((await run(supabase.from("accounts").select("id").eq("is_cash", true))).map((a) => a.id)) : new Set();
    const cash = (tbAll || []).filter((r) => cashIds.has(r.account_id)).reduce((n, r) => n + Number(r.closing), 0);
    const ar = can("sales.view") ? await safe(() => run(supabase.from("invoices").select("net_payable, amount_paid, doc_type").eq("status", "issued"))) : null;
    return {
      revenue: tbMonth ? -sumType(tbMonth, "revenue") : null,
      expenses: tbMonth ? sumType(tbMonth, "expense") : null,
      cash: tbAll ? cash : null,
      ar: ar ? ar.filter((i) => i.doc_type !== "credit_note").reduce((n, i) => n + Number(i.net_payable) - Number(i.amount_paid), 0) : null,
      ap: bills ? bills.reduce((n, b) => n + Number(b.net_payable) - Number(b.amount_paid), 0) : null,
      invoices, projects: (projects || []).filter((p) => Number(p.revenue) || Number(p.cost)).slice(0, 6),
      payroll: payroll?.[0] || null,
    };
  }, [org.id]);

  const k = d.data || {};
  const Kpi = ({ l, v, s }) => v === null || v === undefined ? null : (
    <div className="panel kpi"><div className="l">{l}</div><div className="v"><Money v={v} /></div>{s && <div className="s">{s}</div>}</div>
  );

  return (
    <>
      <PageHead title={t("لوحة المعلومات", "Dashboard")} sub={org.name_ar} />
      {!org.vat_number && can("settings.manage") && (
        <div className="alert warn">{t("أضف الرقم الضريبي والعنوان الوطني للشركة لتتمكن من إصدار الفواتير الضريبية.", "Add the company VAT number and national address to issue tax invoices.")}
          {" "}<a href="#/settings/company">{t("بيانات الشركة", "Company settings")}</a></div>
      )}
      <div className="grid k4" style={{ marginBottom: 16 }}>
        <Kpi l={t("إيرادات الشهر", "Revenue this month")} v={k.revenue} />
        <Kpi l={t("مصروفات وتكاليف الشهر", "Costs this month")} v={k.expenses} />
        <Kpi l={t("النقد والبنوك", "Cash & bank")} v={k.cash} />
        <Kpi l={t("مستحقات العملاء", "Receivables")} v={k.ar} />
        <Kpi l={t("مستحقات الموردين", "Payables")} v={k.ap} />
        <Kpi l={t("صافي آخر مسيّر رواتب", "Last payroll (net)")} v={k.payroll?.total_net} s={k.payroll?.period} />
      </div>
      <div className="grid c2">
        {k.invoices && (
          <Panel title={t("أحدث الفواتير", "Latest invoices")} pad={false}
                 actions={<a className="btn sm" href="#/sales/invoices">{t("الكل", "All")}</a>}>
            <Table rows={k.invoices} onRow={(r) => go(`/sales/invoices/${r.id}`)} columns={[
              { key: "number", label: t("الرقم", "No."), render: (r) => r.number || t("مسودة", "Draft") },
              { key: "c", label: t("العميل", "Customer"), render: (r) => r.customers?.name_ar || t("عميل نقدي", "Cash customer") },
              { key: "total", label: t("الإجمالي", "Total"), type: "money" },
              { key: "status", label: t("الحالة", "Status"), render: (r) => <StatusBadge status={r.status} /> },
            ]} />
          </Panel>
        )}
        {k.projects && (
          <Panel title={t("ربحية المشاريع", "Project profitability")} pad={false}
                 actions={<a className="btn sm" href="#/projects">{t("المشاريع", "Projects")}</a>}>
            <Table rows={k.projects} onRow={(r) => go(`/projects/${r.project_id}`)} empty={t("لا توجد حركات على المشاريع بعد", "No project activity yet")} columns={[
              { key: "name_ar", label: t("المشروع", "Project") },
              { key: "revenue", label: t("الإيراد", "Revenue"), type: "money" },
              { key: "cost", label: t("التكلفة", "Cost"), type: "money" },
              { key: "margin_pct", label: t("الهامش", "Margin"), n: true, render: (r) => r.margin_pct === null ? "—" : `${r.margin_pct}%` },
            ]} />
          </Panel>
        )}
      </div>
    </>
  );
}
