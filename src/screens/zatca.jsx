// ZATCA phase 2: onboarding the company's e-invoice generation unit (EGS) and
// its status. The work happens on the server (api/zatca/onboard): key + CSR,
// compliance CSID with the OTP, compliance checks, production CSID.
import { useState } from "react";
import { rpc, api } from "../supabase.js";
import { useApp, useData, useAction, PageHead, Panel, Field, Select, Issues, useIssues, Badge, DateText, Loading, confirmDialog, go } from "../ui.jsx";
import { isVatNumber } from "../lib/format.js";

const ENVS = (t) => [
  { id: "sandbox", label: t("بيئة التجربة (Sandbox) — بدون رمز حقيقي", "Sandbox — no real OTP") },
  { id: "simulation", label: t("بيئة المحاكاة (Simulation) — رمز من بوابة فاتورة للمحاكاة", "Simulation — OTP from the simulation portal") },
  { id: "production", label: t("الإنتاج (Production) — الربط الفعلي", "Production — live") },
];
const DOCS = (t) => ({ invoice: t("فاتورة", "Invoice"), credit_note: t("إشعار دائن", "Credit note"), debit_note: t("إشعار مدين", "Debit note") });
const KINDS = (t) => ({ standard: t("ضريبية (B2B)", "Standard (B2B)"), simplified: t("مبسطة (B2C)", "Simplified (B2C)") });

export function Zatca() {
  const { t, org } = useApp();
  const [act, busy] = useAction();
  const iss = useIssues();
  const st = useData(() => rpc("zatca_onboarding_status"), []);
  const [f, setF] = useState({ environment: "sandbox", otp: "123345", unit_name: "الفرع الرئيسي", industry: "" });
  const [form, setForm] = useState(false);
  const envs = ENVS(t);
  if (!st.data) return <Loading />;
  const s = st.data;
  const envLabel = (e) => ({ sandbox: t("تجريبية", "Sandbox"), simulation: t("محاكاة", "Simulation"), production: t("الإنتاج", "Production") }[e] || e);

  // company details ZATCA checks — listed in red before anything is sent
  const companyIssues = [
    !isVatNumber(org.vat_number) && t("الرقم الضريبي للشركة (15 رقماً يبدأ وينتهي بـ 3)", "Company VAT number"),
    !/^\d{4}$/.test(org.building_no || "") && t("رقم المبنى (4 أرقام)", "Building number (4 digits)"),
    !/^\d{5}$/.test(org.postal_code || "") && t("الرمز البريدي (5 أرقام)", "Postal code (5 digits)"),
    !org.street && t("اسم الشارع", "Street"), !org.district && t("الحي", "District"), !org.city && t("المدينة", "City"),
  ].filter(Boolean);

  async function onboard() {
    const out = [...companyIssues.map((x) => t(`بيانات الشركة: ${x}`, `Company details: ${x}`))];
    if (!/^\d{6}$/.test(f.otp || "")) out.push({ key: "otp", msg: t("رمز التحقق (OTP) من 6 أرقام", "The OTP is 6 digits") });
    if (!String(f.unit_name || "").trim()) out.push({ key: "unit_name", msg: t("اكتب اسم الفرع أو الوحدة", "Enter the branch / unit name") });
    if (!iss.check(out)) return;
    const msg = f.environment === "production"
      ? t("الربط الفعلي مع زاتكا؟\nبعدها كل فاتورة تُصدرها تُرسل للهيئة مباشرة: الضريبية للاعتماد قبل مشاركتها، والمبسطة للإبلاغ.", "Connect to ZATCA production? Every invoice will be sent to ZATCA.")
      : t(`ربط الشركة ببيئة زاتكا «${envLabel(f.environment)}»؟\nتُرسل الفواتير لهذه البيئة للاختبار فقط ولا يكون لها أثر رسمي.`, `Connect to the ZATCA ${f.environment} environment? For testing only.`);
    if (!await confirmDialog(msg)) return;
    const r = await act(() => api("/api/zatca/onboard", f),
      t("تم الربط مع زاتكا\nاجتازت الشركة فحوصات الامتثال وصدرت شهادة الإنتاج. الفواتير الجديدة تُرسل للهيئة تلقائياً.", "Connected to ZATCA"));
    st.reload();
    if (r) setForm(false);
  }

  return (
    <>
      <PageHead title={t("الفوترة الإلكترونية — زاتكا (المرحلة الثانية)", "E-invoicing — ZATCA phase 2")}
                sub={t("ربط النظام بمنصة فاتورة: توقيع رقمي لكل فاتورة، واعتماد الفواتير الضريبية والإبلاغ عن المبسطة", "Connect to Fatoora: every invoice signed, standard invoices cleared, simplified reported")} />
      {s.active && !form ? (
        <Panel title={<span className="row" style={{ gap: 8 }}>{t("الشركة مربوطة مع زاتكا", "Connected to ZATCA")} <Badge kind={s.environment === "production" ? "ok" : "warn"}>{envLabel(s.environment)}</Badge></span>}
               actions={<button className="btn" onClick={() => { iss.clear(); setForm(true); }}>{t("إعادة الربط", "Re-onboard")}</button>}>
          <div className="grid k4">
            <div><div className="muted">{t("الوحدة / الفرع", "Unit")}</div><b>{s.unit_name}</b></div>
            <div><div className="muted">{t("اسم الجهاز (EGS)", "EGS")}</div><b className="mono">{s.egs_name}</b></div>
            <div><div className="muted">{t("تاريخ الربط", "Onboarded")}</div><b><DateText v={s.activated_at} /></b></div>
            <div><div className="muted">{t("انتهاء الشهادة", "Certificate expires")}</div><b><DateText v={s.cert_expires_at} /></b></div>
          </div>
          {s.environment !== "production" && <div className="alert warn" style={{ marginTop: 12 }}>
            {t("هذه بيئة اختبار: الفواتير تُرسل لزاتكا للتجربة فقط ولا يكون لها أثر رسمي. للتشغيل الفعلي أعد الربط ببيئة الإنتاج برمز OTP من بوابة فاتورة.",
               "Test environment: invoices are sent for testing only. Re-onboard to production with an OTP from the Fatoora portal to go live.")}</div>}
          <Checks checks={s.checks} t={t} />
        </Panel>
      ) : (
        <>
          {s.status === "failed" && <div className="alert bad"><b>{t("لم تكتمل محاولة الربط السابقة:", "The last attempt did not complete:")}</b> {s.error}</div>}
          <Panel title={t("ربط الشركة مع زاتكا", "Onboard with ZATCA")}>
            <ol className="steps">
              <li>{t("تأكد أن بيانات الشركة مكتملة (الرقم الضريبي والعنوان الوطني).", "Make sure the company VAT number and national address are complete.")}
                {companyIssues.length > 0 && <> <a href="#/settings/company" onClick={(e) => { e.preventDefault(); go("/settings/company"); }}>{t("بيانات الشركة ←", "Company details →")}</a></>}</li>
              <li>{t("للتشغيل الفعلي: ادخل بوابة فاتورة (fatoora.zatca.gov.sa) ← «تسجيل وحدة/جهاز جديد» ← أنشئ رمز OTP (صالح لساعة واحدة). في بيئة التجربة يكفي الرمز 123345.",
                "For production: Fatoora portal (fatoora.zatca.gov.sa) → onboard new solution unit → generate an OTP (valid one hour). In the sandbox, 123345 works.")}</li>
              <li>{t("اختر البيئة وأدخل الرمز ثم «ربط». يتم تلقائياً: إنشاء المفتاح وطلب الشهادة، واجتياز 6 فحوصات امتثال، وإصدار شهادة الإنتاج.",
                "Pick the environment, enter the OTP and connect. Key, CSR, six compliance checks and the production certificate are done automatically.")}</li>
            </ol>
            {companyIssues.length > 0 && <div className="alert warn">{t("بيانات ناقصة في الشركة: ", "Missing company details: ")}{companyIssues.join("، ")}</div>}
            <Issues issues={iss.issues} />
            <div className="form">
              <Field label={t("البيئة", "Environment")} required wide>
                <Select value={f.environment} onChange={(v) => setF({ ...f, environment: v || "sandbox", otp: v === "sandbox" ? "123345" : "" })} options={envs} /></Field>
              <Field label={t("رمز التحقق OTP", "OTP")} required invalid={iss.has("otp")} hint={f.environment === "sandbox" ? t("بيئة التجربة تقبل 123345", "The sandbox accepts 123345") : t("من بوابة فاتورة — صالح لساعة", "From the Fatoora portal — valid one hour")}>
                <input dir="ltr" inputMode="numeric" maxLength={6} value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value.replace(/\D/g, "") })} /></Field>
              <Field label={t("اسم الفرع / الوحدة", "Branch / unit")} required invalid={iss.has("unit_name")}><input value={f.unit_name} onChange={(e) => setF({ ...f, unit_name: e.target.value })} /></Field>
              <Field label={t("النشاط", "Industry")} hint={t("مثال: خدمات تقنية، مقاولات", "e.g. IT services, contracting")}><input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} /></Field>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn primary" onClick={onboard} disabled={busy}>{busy ? t("جارِ الربط… (حتى دقيقة)", "Connecting… (up to a minute)") : t("ربط مع زاتكا", "Connect to ZATCA")}</button>
              {s.active && <button className="btn" onClick={() => setForm(false)}>{t("إلغاء", "Cancel")}</button>}
            </div>
          </Panel>
          {s.status === "failed" && <Checks checks={s.checks} t={t} />}
        </>
      )}
    </>
  );
}

function Checks({ checks, t }) {
  if (!checks?.length) return null;
  const docs = DOCS(t); const kinds = KINDS(t);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="section-title">{t("فحوصات الامتثال", "Compliance checks")}</div>
      <table className="tbl"><tbody>{checks.map((c, i) => (
        <tr key={i}><td>{kinds[c.kind]} — {docs[c.doc]}</td>
          <td>{c.status === "PASS" ? <Badge kind="ok">✓ {t("ناجح", "Passed")}</Badge> : c.status === "WARNING" ? <Badge kind="warn">{t("ناجح مع تنبيهات", "Passed with warnings")}</Badge> : <Badge kind="bad">{t("لم ينجح", "Failed")}</Badge>}</td>
          <td className="muted" style={{ fontSize: 12 }}>{(c.messages || []).map((m) => `${m.code}: ${m.message}`).join(" · ")}</td></tr>))}</tbody></table>
    </div>
  );
}
