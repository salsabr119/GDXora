import { useState } from "react";
import { supabase, rpc } from "../supabase.js";
import { useApp, useAction, Field, Tabs } from "../ui.jsx";
import { isVatNumber } from "../lib/format.js";

export function Auth() {
  const { t, lang, setLang, notify } = useApp();
  const [mode, setMode] = useState("in");
  const [f, setF] = useState({ email: "", password: "", name: "" });
  const [act, busy] = useAction();

  async function submit(e) {
    e.preventDefault();
    await act(async () => {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email: f.email, password: f.password });
        if (error) throw error;
      } else if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email: f.email, password: f.password, options: { data: { full_name: f.name } } });
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
      <form className="card" onSubmit={submit}>
        <div className="row"><div className="brand" style={{ flex: 1 }}>GDXora</div>
          <button type="button" className="btn ghost sm" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{lang === "ar" ? "EN" : "ع"}</button></div>
        <div className="tag">{t("نظام تخطيط موارد المؤسسات لشركات الخدمات والمقاولات", "ERP for services & contracting companies")}</div>
        <Tabs value={mode} onChange={setMode} tabs={[["in", t("دخول", "Sign in")], ["up", t("حساب جديد", "Sign up")], ["reset", t("نسيت كلمة المرور", "Forgot password")]]} />
        <div className="grid" style={{ gap: 12 }}>
          {mode === "up" && <Field label={t("الاسم الكامل", "Full name")} required><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
          <Field label={t("البريد الإلكتروني", "E-mail")} required><input type="email" dir="ltr" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          {mode !== "reset" && <Field label={t("كلمة المرور", "Password")} required hint={mode === "up" ? t("8 أحرف على الأقل", "At least 8 characters") : null}>
            <input type="password" dir="ltr" required minLength={mode === "up" ? 8 : undefined} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
          <button className="btn primary" disabled={busy}>{mode === "in" ? t("دخول", "Sign in") : mode === "up" ? t("إنشاء الحساب", "Create account") : t("إرسال الرابط", "Send link")}</button>
        </div>
      </form>
    </div>
  );
}

export function Onboarding({ onCreated }) {
  const { t, session } = useApp();
  const [f, setF] = useState({ name_ar: "", name_en: "", vat: "", cr: "" });
  const [act, busy] = useAction();
  const vatBad = f.vat && !isVatNumber(f.vat);

  async function submit(e) {
    e.preventDefault();
    const id = await act(() => rpc("create_organization", {
      p_name_ar: f.name_ar, p_name_en: f.name_en || null, p_vat_number: f.vat || null, p_cr_number: f.cr || null,
      p_full_name: session.user.user_metadata?.full_name || null,
    }), t("تم إنشاء الشركة وتجهيز دليل الحسابات والضرائب", "Company created with chart of accounts and VAT codes"));
    if (id) onCreated(id);
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit} style={{ width: "min(520px, 100%)" }}>
        <div className="brand">{t("لنجهّز شركتك", "Let's set up your company")}</div>
        <div className="tag">{t("نجهّز تلقائياً: دليل حسابات سعودي لشركات الخدمات والمقاولات، رموز ضريبة القيمة المضافة، الفترات المالية، الأدوار والصلاحيات.",
          "We automatically prepare a Saudi chart of accounts for services & contracting, VAT codes, fiscal periods, roles and permissions.")}</div>
        <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label={t("اسم الشركة (عربي)", "Company name (Arabic)")} required wide><input required value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} /></Field>
          <Field label={t("اسم الشركة (إنجليزي)", "Company name (English)")} wide><input dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
          <Field label={t("الرقم الضريبي", "VAT number")} hint={vatBad ? t("15 رقماً يبدأ وينتهي بـ 3", "15 digits, starts & ends with 3") : t("يمكن إضافته لاحقاً", "Can be added later")}>
            <input dir="ltr" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value.trim() })} style={vatBad ? { borderColor: "var(--bad)" } : null} /></Field>
          <Field label={t("السجل التجاري", "Commercial registration")}><input dir="ltr" value={f.cr} onChange={(e) => setF({ ...f, cr: e.target.value.trim() })} /></Field>
        </div>
        <div className="row" style={{ marginTop: 18, justifyContent: "space-between" }}>
          <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut()}>{t("خروج", "Sign out")}</button>
          <button className="btn primary" disabled={busy || vatBad}>{t("إنشاء الشركة", "Create company")}</button>
        </div>
      </form>
    </div>
  );
}
