// Shared UI: app context, hash router, and small building blocks.
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { friendlyError } from "./errors.js";
import { money as fmtMoney, date as fmtDate } from "./lib/format.js";

/* ── app context ─────────────────────────────────────────────────────── */
export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

/* ── hash router: #/sales/invoices/123 ───────────────────────────────── */
function currentPath() {
  const h = window.location.hash.replace(/^#/, "");
  return h.startsWith("/") ? h : "/";
}
export function useRoute() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return path;
}
export const go = (path) => { window.location.hash = path; };

/** match "/sales/invoices/:id" against a path → params or null */
export function match(pattern, path) {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("?")[0].split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/* ── data hook ───────────────────────────────────────────────────────── */
export function useData(loader, deps = []) {
  const { notifyError } = useApp();
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader();
      if (n === seq.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (n === seq.current) setState({ data: null, loading: false, error: e });
      notifyError(e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/** wrap an async action: busy flag + error toast + optional success toast */
export function useAction() {
  const { notifyError, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) notify(okMsg, "ok");
      return r;
    } catch (e) {
      notifyError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [notify, notifyError]);
  return [run, busy];
}

/* ── toasts ──────────────────────────────────────────────────────────── */
export function useToasts(lang) {
  const [items, setItems] = useState([]);
  const notify = useCallback((text, kind = "") => {
    const id = Math.random();
    setItems((x) => [...x.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === "bad" ? 7000 : 3500);
  }, []);
  const notifyError = useCallback((e) => notify(friendlyError(e, lang), "bad"), [notify, lang]);
  const view = (
    <div className="toasts">{items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>)}</div>
  );
  return { notify, notifyError, view };
}

/* ── building blocks ─────────────────────────────────────────────────── */
export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div className="grow"><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      {children}
    </div>
  );
}

export function Panel({ title, actions, children, pad = true }) {
  return (
    <div className="panel">
      {(title || actions) && <div className="panel-head"><h2 className="grow">{title}</h2>{actions}</div>}
      {pad ? <div className="panel-body">{children}</div> : children}
    </div>
  );
}

export function Money({ v, currency }) {
  const { lang } = useApp();
  const n = Number(v || 0);
  return <span className={n < 0 ? "neg" : ""}>{fmtMoney(n, lang, currency === null ? null : currency || "SAR")}</span>;
}
export function DateText({ v }) {
  const { lang } = useApp();
  return <>{fmtDate(v, lang)}</>;
}

export function Badge({ kind = "", children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Field({ label, required, hint, children, wide }) {
  return (
    <div className={`field ${wide ? "wide" : ""}`}>
      {label && <label>{label}{required && <span className="req"> *</span>}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Table with typed columns.
 * columns: [{ key, label, type: 'money'|'date'|'num'|'badge', render(row), n }]
 */
export function Table({ columns, rows, onRow, empty, footer, loading }) {
  const { t } = useApp();
  if (loading && !rows) return <div className="empty">{t("جارِ التحميل…", "Loading…")}</div>;
  if (!rows || rows.length === 0) return <div className="empty">{empty || t("لا توجد بيانات بعد", "Nothing here yet")}</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr>{columns.map((c) => <th key={c.key || c.label} className={c.type === "money" || c.type === "num" || c.n ? "n" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i} className={onRow ? "click" : ""} onClick={onRow ? () => onRow(r) : undefined}>
              {columns.map((c) => (
                <td key={c.key || c.label} className={c.type === "money" || c.type === "num" || c.n ? "n" : ""}>
                  {c.render ? c.render(r) : c.type === "money" ? <Money v={r[c.key]} currency={null} />
                    : c.type === "date" ? <DateText v={r[c.key]} />
                    : c.type === "num" ? Number(r[c.key] || 0).toLocaleString("en")
                    : r[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot><tr>{footer}</tr></tfoot>}
      </table>
    </div>
  );
}

/** loading placeholder; after a while offers a retry (a failed load also shows an error toast) */
export function Loading() {
  const { t } = useApp();
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(id); }, []);
  return (
    <div className="empty">
      {slow ? <>{t("تعذّر تحميل البيانات.", "Could not load the data.")} <button className="btn sm" onClick={() => window.location.reload()}>{t("إعادة المحاولة", "Retry")}</button></>
            : t("جارِ التحميل…", "Loading…")}
    </div>
  );
}

/** keeps one broken screen from blanking the whole app */
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const ar = document.documentElement.lang !== "en";
    return (
      <div className="alert bad">
        {ar ? "حدث خطأ غير متوقع في هذه الشاشة." : "Something went wrong on this screen."}{" "}
        <button className="btn sm" onClick={() => window.location.reload()}>{ar ? "إعادة التحميل" : "Reload"}</button>
        <div className="mono" style={{ marginTop: 6 }}>{String(this.state.error.message || this.state.error)}</div>
      </div>
    );
  }
}

/** status → badge */
export function StatusBadge({ status }) {
  const { t } = useApp();
  const map = {
    draft: ["", t("مسودة", "Draft")], posted: ["ok", t("مُرحّل", "Posted")], issued: ["ok", t("مُصدرة", "Issued")],
    reversed: ["warn", t("معكوس", "Reversed")], approved: ["info", t("معتمد", "Approved")],
    pending: ["warn", t("قيد الانتظار", "Pending")], rejected: ["bad", t("مرفوض", "Rejected")],
    cancelled: ["bad", t("ملغى", "Cancelled")], invoiced: ["ok", t("مفوتر", "Invoiced")],
    active: ["ok", t("نشط", "Active")], planned: ["", t("مخطط", "Planned")], on_hold: ["warn", t("متوقف", "On hold")],
    completed: ["info", t("مكتمل", "Completed")], closed: ["", t("مغلق", "Closed")], terminated: ["bad", t("منتهي", "Terminated")],
    on_leave: ["warn", t("في إجازة", "On leave")], open: ["ok", t("مفتوحة", "Open")],
    paid: ["ok", t("مدفوعة", "Paid")], partial: ["warn", t("مدفوعة جزئياً", "Partially paid")], unpaid: ["", t("غير مدفوعة", "Unpaid")],
    not_submitted: ["", t("لم تُرسل", "Not submitted")], reported: ["ok", t("مُبلّغ عنها", "Reported")],
    cleared: ["ok", t("معتمدة", "Cleared")], warning: ["warn", t("تحذير", "Warning")],
  };
  const [k, label] = map[status] || ["", status];
  return <Badge kind={k}>{label}</Badge>;
}

/** select bound to a list of {id, label} */
export function Select({ value, onChange, options, placeholder, required, disabled }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} required={required} disabled={disabled}>
      <option value="">{placeholder || "—"}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map(([k, label]) => <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{label}</button>)}
    </div>
  );
}

/** bilingual name helper */
export function useName() {
  const { lang } = useApp();
  return useMemo(() => (r, ar = "name_ar", en = "name_en") => (r ? (lang === "en" && r[en]) || r[ar] || "—" : "—"), [lang]);
}
