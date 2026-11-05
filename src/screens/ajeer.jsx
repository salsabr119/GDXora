// Temporary workers through Ajeer (أجير): one row per Ajeer contract, added
// one by one or from Excel, ending by itself on its end date. The lending
// establishment stays the employer, so these workers are not on payroll; their
// cost reaches the project through the lender's vendor bills.
import { rpc } from "../supabase.js";
import { useApp, Panel, Money, Badge } from "../ui.jsx";
import { Resource } from "../crud.jsx";
import * as L from "../lookups.js";
import { today } from "../lib/format.js";
import { SOON, daysLeft, ajeerState, addYears } from "../lib/ajeer.js";

export function Ajeer() {
  const { t } = useApp();
  const STATE = {
    upcoming: ["", t("لم يبدأ", "Not started")], active: ["ok", t("ساري", "Active")],
    ending: ["warn", t("ينتهي قريباً", "Ending soon")], ended: ["bad", t("منتهي", "Ended")],
  };
  return <Resource cfg={{
    table: "temp_workers", title: t("العمالة المؤقتة (أجير)", "Temporary workers (Ajeer)"),
    sub: t("عمال معارون من منشآت أخرى عبر منصة أجير لفترة المشروع — لا يدخلون مسيّر الرواتب، وينتهي عقدهم تلقائياً بتاريخ النهاية",
           "Workers lent by other establishments through Ajeer for a project — not on payroll; each contract ends by itself on its end date"),
    order: "end_date.asc", managePerm: "hr.manage", canDelete: true,
    search: ["worker_name", "iqama_no", "permit_no", "provider_name", "profession"],
    saveRecords: (rows) => rpc("save_temp_workers", { p_rows: rows }),
    importKey: ["permit_no"],
    loadLookups: async () => ({ projects: await L.projects().catch(() => []), vendors: await L.vendors().catch(() => []) }),
    defaults: { start_date: today(), monthly_cost: 0 },
    validate: (w, tt) => {
      const out = [];
      if (w.start_date && w.end_date && w.end_date < w.start_date) out.push({ key: "end_date", msg: tt("تاريخ النهاية قبل تاريخ البداية", "The end date is before the start date") });
      if (w.start_date && w.end_date && w.end_date >= addYears(w.start_date, 3)) out.push({ key: "end_date", msg: tt("مدة تصريح أجير لا تتجاوز ثلاث سنوات", "An Ajeer permit cannot exceed three years") });
      return out;
    },
    banner: (rows, lk) => <AjeerSummary rows={rows} projects={lk.projects || []} />,
    columns: [
      { key: "worker_name", label: t("العامل", "Worker"), render: (w) => <>{w.worker_name}<div className="muted mono" style={{ fontSize: 12 }}>{w.iqama_no}</div></> },
      { key: "profession", label: t("المهنة", "Profession") },
      { key: "provider_name", label: t("المنشأة المُعيرة", "Lending establishment") },
      { key: "project", label: t("المشروع", "Project"), render: (w, lk) => lk?.projects?.find((p) => p.id === w.project_id)?.name_ar || "—" },
      { key: "permit_no", label: t("رقم العقد", "Contract no."), render: (w) => <span className="mono">{w.permit_no || "—"}</span> },
      { key: "start_date", label: t("من", "From"), type: "date" },
      { key: "end_date", label: t("إلى", "To"), type: "date" },
      { key: "monthly_cost", label: t("التكلفة الشهرية", "Monthly cost"), type: "money" },
      { key: "state", label: t("الحالة", "Status"), exportValue: (w) => STATE[ajeerState(w)][1], render: (w) => {
        const s = ajeerState(w); const left = daysLeft(w.end_date);
        return <><Badge kind={STATE[s][0]}>{STATE[s][1]}</Badge>{s === "ending" && <div className="muted" style={{ fontSize: 12 }}>{t(`باقي ${left} يوم`, `${left} days left`)}</div>}</>;
      } },
    ],
    fields: [
      { section: t("العامل", "Worker") },
      { key: "worker_name", label: t("اسم العامل", "Worker name"), required: true },
      { key: "iqama_no", label: t("رقم الإقامة", "Iqama number"), required: true, ltr: true, transform: (v) => String(v ?? "").replace(/\D/g, "").slice(0, 10),
        validate: (v) => (/^[12]\d{9}$/.test(String(v)) ? null : t("رقم الإقامة 10 أرقام ويبدأ بـ 2", "The iqama number is 10 digits starting with 2")) },
      { key: "nationality", label: t("الجنسية", "Nationality") },
      { key: "profession", label: t("المهنة (كما في أجير)", "Profession (as on Ajeer)"), required: true, hint: t("يعمل العامل في نفس المهنة المرخصة فقط", "The worker may only do the licensed profession") },
      { section: t("المنشأة المُعيرة", "Lending establishment") },
      { key: "provider_name", label: t("اسم المنشأة", "Establishment name"), required: true },
      { key: "provider_unified_no", label: t("الرقم الموحد للمنشأة", "Unified establishment number"), ltr: true },
      { key: "provider_cr", label: t("السجل التجاري", "Commercial registration"), ltr: true },
      { key: "vendor_id", label: t("المورد في النظام (لفواتيرها)", "Vendor in the system (for its bills)"), type: "select", options: (lk) => lk.vendors || [],
        hint: t("اختياري — يربط العقد بفواتير المنشأة على المشروع", "Optional — links the contract to the lender's bills") },
      { section: t("العقد", "Contract") },
      { key: "permit_no", label: t("رقم عقد / تصريح أجير", "Ajeer contract / permit no."), ltr: true },
      { key: "project_id", label: t("المشروع", "Project"), type: "select", options: (lk) => lk.projects || [] },
      { key: "start_date", label: t("تاريخ البداية", "Start date"), type: "date", required: true },
      { key: "end_date", label: t("تاريخ النهاية", "End date"), type: "date", required: true, hint: t("ينتهي العقد تلقائياً بهذا التاريخ — للإنهاء المبكر غيّره واكتب السبب", "The contract ends by itself on this date — to end early, change it and give the reason") },
      { key: "monthly_cost", label: t("التكلفة الشهرية (ر.س)", "Monthly cost (SAR)"), type: "money", hint: t("ما تدفعونه للمنشأة المُعيرة شهرياً عن العامل", "What you pay the lender per month for this worker") },
      { key: "end_reason", label: t("سبب الإنهاء المبكر", "Reason for ending early"), wide: true },
      { key: "notes", label: t("ملاحظات", "Notes"), type: "textarea", wide: true },
    ],
  }} />;
}

export function AjeerSummary({ rows, projects }) {
  const { t } = useApp();
  const live = rows.filter((w) => ["active", "ending"].includes(ajeerState(w)));
  const ending = rows.filter((w) => ajeerState(w) === "ending").sort((a, b) => a.end_date.localeCompare(b.end_date));
  const justEnded = rows.filter((w) => ajeerState(w) === "ended" && daysLeft(w.end_date) >= -7);
  const byProject = new Map();
  for (const w of live) byProject.set(w.project_id, (byProject.get(w.project_id) || 0) + 1);
  const pname = (id) => projects.find((p) => p.id === id)?.name_ar || t("بدون مشروع", "No project");
  return (
    <>
      <div className="grid k4" style={{ marginBottom: 12 }}>
        <div className="panel kpi"><div className="l">{t("على رأس العمل الآن", "Working now")}</div><div className="v">{live.length}</div></div>
        <div className="panel kpi"><div className="l">{t(`تنتهي خلال ${SOON} يوماً`, `Ending within ${SOON} days`)}</div><div className={`v ${ending.length ? "neg" : ""}`}>{ending.length}</div></div>
        <div className="panel kpi"><div className="l">{t("التكلفة الشهرية الحالية", "Current monthly cost")}</div><div className="v"><Money v={live.reduce((n, w) => n + Number(w.monthly_cost || 0), 0)} /></div></div>
        <div className="panel kpi"><div className="l">{t("المشاريع", "Projects")}</div><div className="v" style={{ fontSize: 13, fontWeight: 500 }}>
          {[...byProject].map(([id, n]) => `${pname(id)}: ${n}`).join(" · ") || "—"}</div></div>
      </div>
      {(ending.length > 0 || justEnded.length > 0) && <Panel title={t("تنبيهات العقود", "Contract alerts")}>
        <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4 }}>
          {ending.map((w) => <li key={w.id}>{t(`${w.worker_name} (${w.provider_name}) — ينتهي عقده بعد ${daysLeft(w.end_date)} يوم في ${w.end_date}. جدّده في أجير قبل الانتهاء أو جهّز إنهاء عمله.`,
            `${w.worker_name} (${w.provider_name}) — contract ends in ${daysLeft(w.end_date)} days on ${w.end_date}. Renew it on Ajeer or prepare to release the worker.`)}</li>)}
          {justEnded.map((w) => <li key={w.id} className="neg">{t(`${w.worker_name} — انتهى عقده في ${w.end_date}: يجب أن يتوقف عن العمل في الموقع.`,
            `${w.worker_name} — contract ended on ${w.end_date}: the worker must stop working on site.`)}</li>)}
        </ul>
      </Panel>}
    </>
  );
}
