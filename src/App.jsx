import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, configured, rpc, run, setOrg, getOrg } from "./supabase.js";
import { AppCtx, useRoute, match, go, useToasts, ErrorBoundary } from "./ui.jsx";
import { NAV, DETAIL_ROUTES } from "./nav.js";
import { Auth, Onboarding } from "./screens/auth.jsx";

export default function App() {
  const [lang, setLang] = useState(() => { try { return localStorage.getItem("gdx_lang") || "ar"; } catch { return "ar"; } });
  const t = useCallback((ar, en) => (lang === "ar" ? ar : en ?? ar), [lang]);
  const toasts = useToasts(lang);
  const [session, setSession] = useState(undefined);        // undefined = loading
  const [orgs, setOrgs] = useState(null);
  const [org, setOrgRow] = useState(null);
  const [perms, setPerms] = useState(new Set());
  const [modules, setModules] = useState(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useRoute();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    try { localStorage.setItem("gdx_lang", lang); } catch { /* ignore */ }
  }, [lang]);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadOrgs = useCallback(async () => {
    const list = await rpc("my_organizations");
    setOrgs(list);
    return list;
  }, []);

  const selectOrg = useCallback(async (id) => {
    setOrg(id);
    const [row, p, m] = await Promise.all([
      run(supabase.from("organizations").select("*").eq("id", id).single()),
      rpc("my_permissions"),
      run(supabase.from("org_modules").select("module_key, enabled")),
    ]);
    setOrgRow(row);
    setPerms(new Set(p || []));
    setModules(new Set((m || []).filter((x) => x.enabled).map((x) => x.module_key)));
  }, []);

  useEffect(() => {
    if (!session) { setOrgs(null); setOrgRow(null); return; }
    loadOrgs().then((list) => {
      if (!list?.length) return;
      const keep = list.find((o) => o.org_id === getOrg());
      selectOrg((keep || list[0]).org_id).catch(toasts.notifyError);
    }).catch(toasts.notifyError);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const can = useCallback((p) => perms.has(p), [perms]);
  const ctx = useMemo(() => ({
    lang, setLang, t, can, org, orgs, session, modules,
    notify: toasts.notify, notifyError: toasts.notifyError,
    refreshOrg: () => org && selectOrg(org.id),
  }), [lang, t, can, org, orgs, session, modules, toasts.notify, toasts.notifyError, selectOrg]);

  if (!configured) return <SetupNeeded />;
  if (session === undefined) return <div className="empty">…</div>;
  if (!session) return <AppCtx.Provider value={ctx}><Auth />{toasts.view}</AppCtx.Provider>;
  if (orgs && orgs.length === 0) {
    return (
      <AppCtx.Provider value={ctx}>
        <Onboarding onCreated={async (id) => { await loadOrgs(); await selectOrg(id); go("/"); }} />
        {toasts.view}
      </AppCtx.Provider>
    );
  }
  if (!org) return <div className="empty">…</div>;

  // resolve route
  const visibleNav = NAV.map((s) => ({
    ...s, items: s.items.filter((i) => (!i.perm || can(i.perm)) && (!s.module || modules.has(s.module))),
  })).filter((s) => s.items.length);
  let page = null; let params = {};
  for (const s of visibleNav) for (const i of s.items) if (!page && match(i.path, path)) page = i;
  if (!page) {
    for (const r of DETAIL_ROUTES) {
      const m = match(r.path, path);
      if (m && (!r.perm || can(r.perm))) { page = r; params = m; break; }
    }
  }
  const Page = page?.component;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <aside className={`side ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen(false)}>
          <div className="logo"><i />GDXora</div>
          {visibleNav.map((s) => (
            <div key={s.group[0]}>
              <div className="group">{t(...s.group)}</div>
              {s.items.map((i) => (
                <a key={i.path} href={`#${i.path}`}
                   className={path === i.path || (i.path !== "/" && path.startsWith(i.path + "/")) ? "on" : ""}>
                  {t(...i.label)}
                </a>
              ))}
            </div>
          ))}
        </aside>
        <div className="main">
          <div className="top">
            <button className="btn ghost menu-btn" onClick={() => setMenuOpen(true)} aria-label="menu">☰</button>
            <select style={{ width: "auto", maxWidth: 260 }} value={org.id}
                    onChange={(e) => selectOrg(e.target.value).then(() => go("/")).catch(toasts.notifyError)}>
              {orgs.map((o) => <option key={o.org_id} value={o.org_id}>{lang === "en" && o.name_en ? o.name_en : o.name_ar}</option>)}
            </select>
            <span className="grow" />
            <button className="btn ghost sm" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>{lang === "ar" ? "English" : "العربية"}</button>
            <span className="muted who" style={{ fontSize: 13 }}>{session.user.email}</span>
            <button className="btn sm" onClick={() => { setOrg(null); supabase.auth.signOut(); }}>{t("خروج", "Sign out")}</button>
          </div>
          <div className="content">
            {Page ? <ErrorBoundary key={path}><Page params={params} /></ErrorBoundary> : <div className="empty">{t("الصفحة غير موجودة أو لا تملك صلاحية لها", "Page not found or not permitted")}</div>}
          </div>
        </div>
      </div>
      {toasts.view}
    </AppCtx.Provider>
  );
}

function SetupNeeded() {
  return (
    <div className="auth">
      <div className="card" dir="rtl">
        <div className="brand">GDXora</div>
        <p>لم يتم ربط التطبيق بقاعدة البيانات بعد.</p>
        <ol style={{ lineHeight: 1.9 }}>
          <li>أنشئ مشروعاً على Supabase وطبّق ملفات <code>supabase/migrations</code> بالترتيب.</li>
          <li>انسخ <code>.env.example</code> إلى <code>.env</code> وضع <code>VITE_SUPABASE_URL</code> و <code>VITE_SUPABASE_ANON_KEY</code>.</li>
          <li>أعد تشغيل <code>npm run dev</code>.</li>
        </ol>
        <p className="muted">التفاصيل في README.md</p>
      </div>
    </div>
  );
}
