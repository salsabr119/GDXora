import { useState } from "react";
import { supabase, rpc } from "../supabase.js";
import { useApp, useAction, Field, Tabs, Issues, useIssues } from "../ui.jsx";
import { isVatNumber } from "../lib/format.js";

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits ↔ Latin digits. An Arabic keyboard
// types ١٢٣ in password fields; we store Latin digits for new passwords and, on
// sign-in, also try the other form so accounts created either way still work.
const toLatinDigits = (s) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
const toArabicDigits = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d)));

export function Auth() {
  const { t, lang, setLang, notify } = useApp();
  const [mode, setMode] = useState("in");
  const [f, setF] = useState({ email: "", password: "", name: "" });
  const [act, busy] = useAction();
  const iss = useIssues();

  async function submit(e) {
    e.preventDefault();
    const out = [];
    if (mode === "up" && !f.name.trim()) out.push({ key: "name", msg: t("أدخل الاسم الكامل", "Enter your full name") });
    if (!f.email.trim()) out.push({ key: "email", msg: t("أدخل البريد الإلكتروني", "Enter your e-mail") });
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) out.push({ key: "email", msg: t("البريد الإلكتروني غير صحيح", "The e-mail address is not valid") });
    if (mode !== "reset" && !f.password) out.push({ key: "password", msg: t("أدخل كلمة المرور", "Enter your password") });
    else if (mode === "up" && f.password.length < 8) out.push({ key: "password", msg: t("كلمة المرور 8 أحرف على الأقل", "Password must be at least 8 characters") });
    if (!iss.check(out)) return;
    await act(async () => {
      if (mode === "in") {
        const email = f.email.trim();
        let { error } = await supabase.auth.signInWithPassword({ email, password: f.password });
        if (error && /invalid login credentials/i.test(error.message)) {
          const alt = [toLatinDigits(f.password), toArabicDigits(toLatinDigits(f.password))].find((p) => p !== f.password);
          if (alt) ({ error } = await supabase.auth.signInWithPassword({ email, password: alt }));
        }
        if (error) throw error;
      } else if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email: f.email.trim(), password: toLatinDigits(f.password), options: { data: { full_name: f.name } } });
        if (error) throw error;
        if (!data.session) notify(t("تم إنشاء الحساب — افتح الرابط المرسل إلى بريدك لتفعيله", "Account created — confirm via the link sent to your e-mail"), "ok");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(f.email, { redirectTo: window.location.origin });
        if (error) throw error;
        notify(t("أرسلنا رابط استعادة كلمة المرور إلى بريدك", "We sent a password reset link to your e-mail"), "ok");
      }
    });
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit} noValidate>
        <div className="row" style={{ alignItems: "flex-start" }}><img className="logo-img" src="/logo.png" alt="Global Drive" /><span style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{lang === "ar" ? "EN" : "ع"}</button></div>
        <div className="brand">GDXora</div>
        <div className="motto">Knowledge | Experience | Technology</div>
        <div className="tag">{t("نظام تخطيط موارد المؤسسات لشركات الخدمات والمقاولات", "ERP for services & contracting companies")}</div>
        <Issues issues={iss.issues} />
        <Tabs value={mode} onChange={(m) => { setMode(m); iss.clear(); }} tabs={[["in", t("دخول", "Sign in")], ["up", t("حساب جديد", "Sign up")], ["reset", t("نسيت كلمة المرور", "Forgot password")]]} />
        <div className="grid" style={{ gap: 12 }}>
          {mode === "up" && <Field label={t("الاسم الكامل", "Full name")} required invalid={iss.has("name")}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
          <Field label={t("البريد الإلكتروني", "E-mail")} required invalid={iss.has("email")}><input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          {mode !== "reset" && <Field label={t("كلمة المرور", "Password")} required invalid={iss.has("password")} hint={mode === "up" ? t("8 أحرف على الأقل", "At least 8 characters") : null}>
            <input type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
          <button className="btn primary" disabled={busy}>{mode === "in" ? t("دخول", "Sign in") : mode === "up" ? t("إنشاء الحساب", "Create account") : t("إرسال الرابط", "Send link")}</button>
        </div>
        <div className="foot">{t("من", "By")} <b>Global Drive IT Solutions</b> · <a href="https://www.gdrivesol.com" target="_blank" rel="noreferrer">gdrivesol.com</a></div>
      </form>
    </div>
  );
}

export function Onboarding({ onCreated }) {
  const { t, session } = useApp();
  const [f, setF] = useState({ name_ar: "", name_en: "", vat: "", cr: "" });
  const [act, busy] = useAction();
  const iss = useIssues();
  const vatBad = f.vat && !isVatNumber(f.vat);

  async function submit(e) {
    e.preventDefault();
    const out = [];
    if (!f.name_ar.trim()) out.push({ key: "name_ar", msg: t("أدخل اسم الشركة بالعربي", "Enter the company name in Arabic") });
    if (f.vat && !isVatNumber(f.vat)) out.push({ key: "vat", msg: t("الرقم الضريبي غير صحيح — 15 رقماً يبدأ وينتهي بـ 3 (أو اتركه فارغاً وأضفه لاحقاً)", "Invalid VAT number — 15 digits starting and ending with 3 (or leave it empty)") });
    if (f.cr && !/^\d{10}$/.test(f.cr)) out.push({ key: "cr", msg: t("السجل التجاري 10 أرقام", "Commercial registration is 10 digits") });
    if (!iss.check(out)) return;
    const id = await act(() => rpc("create_organization", {
      p_name_ar: f.name_ar, p_name_en: f.name_en || null, p_vat_number: f.vat || null, p_cr_number: f.cr || null,
      p_full_name: session.user.user_metadata?.full_name || null,
    }), t("تم إنشاء الشركة وتجهيز دليل الحسابات والضرائب", "Company created with chart of accounts and VAT codes"));
    if (id) onCreated(id);
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit} style={{ width: "min(520px, 100%)" }} noValidate>
        <img className="logo-img" src="/logo.png" alt="Global Drive" />
        <div className="brand">{t("لنجهّز شركتك", "Let's set up your company")}</div>
        <div className="tag">{t("نجهّز تلقائياً: دليل حسابات سعودي لشركات الخدمات والمقاولات، رموز ضريبة القيمة المضافة، الفترات المالية، الأدوار والصلاحيات.",
          "We automatically prepare a Saudi chart of accounts for services & contracting, VAT codes, fiscal periods, roles and permissions.")}</div>
        <Issues issues={iss.issues} />
        <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label={t("اسم الشركة (عربي)", "Company name (Arabic)")} required wide invalid={iss.has("name_ar")}><input value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
          <Field label={t("اسم الشركة (إنجليزي)", "Company name (English)")} wide><input dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
          <Field label={t("الرقم الضريبي", "VAT number")} invalid={iss.has("vat")} hint={vatBad ? t("15 رقماً يبدأ وينتهي بـ 3", "15 digits, starts & ends with 3") : t("يمكن إضافته لاحقاً", "Can be added later")}>
            <input dir="ltr" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value.trim() })} style={vatBad ? { borderColor: "var(--bad)" } : null} /></Field>
          <Field label={t("السجل التجاري", "Commercial registration")} invalid={iss.has("cr")}><input dir="ltr" value={f.cr} onChange={(e) => setF({ ...f, cr: e.target.value.trim() })} /></Field>
        </div>
        <div className="row" style={{ marginTop: 18, justifyContent: "space-between" }}>
          <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut()}>{t("خروج", "Sign out")}</button>
          <button className="btn primary" disabled={busy}>{t("إنشاء الشركة", "Create company")}</button>
        </div>
      </form>
    </div>
  );
}
