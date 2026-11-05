// «المساعد»: the in-app support assistant. A floating button opens a chat that
// answers "how do I…" questions from the user manual (api/assistant.js). It
// sees the current screen and the user's permissions, never company data.
import { useEffect, useRef, useState } from "react";
import { api } from "./supabase.js";
import { useApp, useRoute } from "./ui.jsx";

const KEY = "gdx_assistant";
const HIDE = "gdx_assistant_hidden";
/** company switch (Settings → Company); on unless turned off */
export const assistantEnabled = (org) => org?.settings?.assistant_enabled !== false;
/** this user's own choice to keep the button off their pages */
export function useAssistantHidden() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE) === "1"; } catch { return false; } });
  const set = (v) => { setHidden(v); try { v ? localStorage.setItem(HIDE, "1") : localStorage.removeItem(HIDE); } catch { /* private mode */ } };
  return [hidden, set];
}
const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (m) => { try { sessionStorage.setItem(KEY, JSON.stringify(m.slice(-20))); } catch { /* private mode */ } };

/** **bold** and line breaks only — answers are short steps */
function Text({ text }) {
  return String(text).split("\n").map((line, i) => (
    <div key={i} style={{ minHeight: line ? undefined : 8 }}>
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith("**") && part.endsWith("**") ? <b key={j}>{part.slice(2, -2)}</b> : part))}
    </div>));
}

export function Assistant({ onHide }) {
  const { t, lang } = useApp();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(load);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const end = useRef(null);
  useEffect(() => { save(msgs); end.current?.scrollIntoView({ block: "end" }); }, [msgs, open]);

  const SUGGEST = [t("كيف أصدر فاتورة ضريبية؟", "How do I issue a tax invoice?"), t("كيف أسوي مستخلص لمشروع؟", "How do I prepare a progress billing?"),
                   t("كيف أضيف عمال أجير من Excel؟", "How do I import Ajeer workers from Excel?"), t("ليش ما يظهر لي زر الاعتماد؟", "Why can't I see the Approve button?")];
  async function ask(text) {
    const question = String(text ?? q).trim();
    if (!question || busy) return;
    if (question.length > 2000) { setErr(t("السؤال طويل — اختصره إلى 2000 حرف", "Keep the question under 2000 characters")); return; }
    const next = [...msgs, { role: "user", content: question }];
    setMsgs(next); setQ(""); setErr(null); setBusy(true);
    try {
      const { reply } = await api("/api/assistant", { messages: next, route, lang });
      setMsgs([...next, { role: "assistant", content: reply }]);
    } catch (e) {
      setErr(t(`تعذّر الرد: ${e.message}`, `Couldn't answer: ${e.message}`));
    }
    setBusy(false);
  }

  if (!open) return (
    <div className="assist-fab no-print">
      <button className="assist-open" onClick={() => setOpen(true)} title={t("المساعد", "Assistant")}>💬 {t("المساعد", "Help")}</button>
      <button className="assist-hide" onClick={onHide} title={t("إخفاء من صفحاتي (يرجع من زر 💬 أعلى الشاشة)", "Hide from my pages (bring it back from 💬 at the top)")} aria-label={t("إخفاء", "Hide")}>✕</button>
    </div>);
  return (
    <div className="assist no-print" role="dialog" aria-label={t("المساعد", "Assistant")}>
      <div className="assist-head">
        <b>💬 {t("المساعد", "Assistant")}</b><span className="muted" style={{ fontSize: 12 }}>{t("يشرح استخدام النظام", "Explains how to use GDXora")}</span>
        <span className="grow" />
        {msgs.length > 0 && <button className="btn ghost sm" onClick={() => { setMsgs([]); setErr(null); }}>{t("محادثة جديدة", "New chat")}</button>}
        <button className="btn ghost sm" onClick={() => setOpen(false)} aria-label="close">✕</button>
      </div>
      <div className="assist-body">
        {!msgs.length && <div className="assist-hello">
          <p>{t("أهلاً! اسألني عن أي شاشة أو خطوة في GDXora — أشرح لك أين تجدها وكيف تنفذها.", "Hi! Ask me about any screen or step in GDXora.")}</p>
          {SUGGEST.map((s) => <button key={s} className="btn sm" onClick={() => ask(s)}>{s}</button>)}
        </div>}
        {msgs.map((m, i) => <div key={i} className={`assist-msg ${m.role}`}><Text text={m.content} /></div>)}
        {busy && <div className="assist-msg assistant muted">…</div>}
        {err && <div className="alert bad" style={{ margin: 0 }}>{err}</div>}
        <div ref={end} />
      </div>
      <form className="assist-input" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea rows={2} value={q} placeholder={t("اكتب سؤالك…", "Ask a question…")} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        <button className="btn primary" disabled={busy}>{t("إرسال", "Send")}</button>
      </form>
      <div className="assist-note">{t("المساعد يشرح فقط ولا يطّلع على بيانات شركتكم ولا ينفذ أي إجراء. قد يخطئ — راجع الخطوات في الشاشة.",
        "The assistant only explains: it doesn't see your company's data or act for you. It can be wrong.")}</div>
    </div>
  );
}
