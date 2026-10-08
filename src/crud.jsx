// Config-driven list + form screen for master data (customers, vendors,
// employees, items, accounts…). Screens with workflows (invoices, payroll…)
// have their own components.
import { useMemo, useState } from "react";
import { supabase, run } from "./supabase.js";
import { useApp, useData, useAction, PageHead, Panel, Table, Modal, Field, Issues, useIssues } from "./ui.jsx";

/**
 * field: { key, label, type: text|number|money|date|select|checkbox|textarea|email|tel,
 *          required, options: [{id,label}] | (lookups) => [...], section, wide, hint,
 *          placeholder, transform(v), validate(v, record) → message | null }
 */

const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Validate a record against field definitions → [{ key, msg }] (Arabic/English via t). */
export function validateRecord(fields, value, t) {
  const out = [];
  for (const f of fields) {
    if (!f.key) continue;
    const v = value[f.key];
    if (f.required && isEmpty(v)) { out.push({ key: f.key, msg: t(`حقل «${f.label}» مطلوب`, `"${f.label}" is required`) }); continue; }
    if (!isEmpty(v) && f.validate) { const m = f.validate(v, value); if (m) out.push({ key: f.key, msg: m }); }
    if (!isEmpty(v) && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) out.push({ key: f.key, msg: t(`«${f.label}» غير صحيح`, `"${f.label}" is not a valid e-mail`) });
  }
  return out;
}

export function RecordForm({ fields, value, onChange, lookups, invalid }) {
  return (
    <div className="form">
      {fields.map((f) => {
        if (f.section) return <div key={`s-${f.section}`} className="section-title">{f.section}</div>;
        const v = value[f.key];
        const set = (x) => onChange({ ...value, [f.key]: f.transform ? f.transform(x) : x });
        let input;
        switch (f.type) {
          case "select": {
            const opts = typeof f.options === "function" ? f.options(lookups || {}, value) : f.options || [];
            input = (
              <select value={v ?? ""} onChange={(e) => set(e.target.value === "" ? null : e.target.value)}>
                <option value="">—</option>
                {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            );
            break;
          }
          case "checkbox":
            input = <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />;
            break;
          case "textarea":
            input = <textarea rows={3} value={v ?? ""} onChange={(e) => set(e.target.value)} />;
            break;
          case "number":
          case "money":
            input = <input className="num" type="number" step={f.type === "money" ? "0.01" : "any"} value={v ?? ""}
                           onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} />;
            break;
          default:
            input = <input type={f.type || "text"} value={v ?? ""} placeholder={f.placeholder}
                           onChange={(e) => set(e.target.value === "" ? null : e.target.value)}
                           dir={f.ltr ? "ltr" : undefined} />;
        }
        return <Field key={f.key} label={f.label} required={f.required} hint={f.hint} wide={f.wide} invalid={invalid?.(f.key)}>{input}</Field>;
      })}
    </div>
  );
}

/**
 * Resource screen.
 * cfg: { table, title, sub, select, order, managePerm, columns, fields, defaults,
 *        search: [keys], loadLookups: async () => ({}), onRow(row) (custom navigation),
 *        canDelete, filter(query) }
 */
export function Resource({ cfg }) {
  const { t, can } = useApp();
  const [edit, setEdit] = useState(null);     // record being edited (or {} for new)
  const [q, setQ] = useState("");
  const [act, busy] = useAction();
  const v = useIssues();

  const list = useData(async () => {
    let query = supabase.from(cfg.table).select(cfg.select || "*");
    if (cfg.filter) query = cfg.filter(query);
    const [col, dir] = (cfg.order || "created_at.desc").split(".");
    return run(query.order(col, { ascending: dir !== "desc" }).limit(cfg.limit || 1000));
  }, [cfg.table]);
  const lookups = useData(async () => (cfg.loadLookups ? cfg.loadLookups() : {}), [cfg.table]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !list.data) return list.data;
    const keys = cfg.search || ["name_ar", "name_en", "code"];
    return list.data.filter((r) => keys.some((k) => String(r[k] ?? "").toLowerCase().includes(s)));
  }, [q, list.data, cfg.search]);

  const canManage = !cfg.managePerm || can(cfg.managePerm);

  async function save(e) {
    e.preventDefault();
    if (!v.check([...validateRecord(cfg.fields, edit, t), ...(cfg.validate ? cfg.validate(edit, t) : [])])) return;
    const record = {};
    for (const f of cfg.fields) {
      if (!f.key || f.readOnly) continue;
      const v = edit[f.key] ?? null;
      // new records: leave empty fields out so the database default applies
      if (v === null && !edit.id) continue;
      record[f.key] = v;
    }
    const ok = await act(async () => {
      if (edit.id) await run(supabase.from(cfg.table).update(record).eq("id", edit.id));
      else await run(supabase.from(cfg.table).insert(record));
      return true;
    }, t("تم الحفظ", "Saved"));
    if (ok) { setEdit(null); list.reload(); }
  }

  async function remove() {
    if (!window.confirm(t("حذف هذا السجل؟", "Delete this record?"))) return;
    const ok = await act(async () => { await run(supabase.from(cfg.table).delete().eq("id", edit.id)); return true; },
      t("تم الحذف", "Deleted"));
    if (ok) { setEdit(null); list.reload(); }
  }

  return (
    <>
      <PageHead title={cfg.title} sub={cfg.sub}>
        <input style={{ width: 220 }} placeholder={t("بحث…", "Search…")} value={q} onChange={(e) => setQ(e.target.value)} />
        {canManage && <button className="btn primary" onClick={() => { v.clear(); setEdit({ ...(cfg.defaults || {}) }); }}>{t("+ جديد", "+ New")}</button>}
      </PageHead>
      <Panel pad={false}>
        <Table columns={cfg.columns} rows={rows} loading={list.loading}
               onRow={cfg.onRow || ((r) => { v.clear(); setEdit({ ...r }); })} />
      </Panel>
      {edit && (
        <Modal title={edit.id ? t("تعديل", "Edit") + " — " + (edit.code || edit.name_ar || "") : cfg.newTitle || t("إضافة جديد", "Add new")}
               onClose={() => { setEdit(null); v.clear(); }} wide={cfg.fields.length > 10}
               footer={<>
                 {edit.id && cfg.canDelete && canManage && <button className="btn danger" onClick={remove} disabled={busy}>{t("حذف", "Delete")}</button>}
                 <span style={{ flex: 1 }} />
                 <button className="btn" onClick={() => setEdit(null)}>{t("إلغاء", "Cancel")}</button>
                 {canManage && <button className="btn primary" form="rec-form" disabled={busy}>{t("حفظ", "Save")}</button>}
               </>}>
          <form id="rec-form" onSubmit={save} noValidate>
            <Issues issues={v.issues} />
            <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
              <RecordForm fields={cfg.fields} value={edit} onChange={setEdit} lookups={lookups.data} invalid={v.has} />
            </fieldset>
          </form>
        </Modal>
      )}
    </>
  );
}
