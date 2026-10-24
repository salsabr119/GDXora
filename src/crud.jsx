// Config-driven list + form screen for master data (customers, vendors,
// employees, items, accounts…). Screens with workflows (invoices, payroll…)
// have their own components.
import { useMemo, useRef, useState } from "react";
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
 *        canDelete, filter(query), importable, importer (custom import dialog),
 *        toForm(row) (row → form value), saveRecords([records]) (custom persistence for form + import) }
 */
export function Resource({ cfg }) {
  const { t, can } = useApp();
  const [edit, setEdit] = useState(null);     // record being edited (or {} for new)
  const [importing, setImporting] = useState(false);
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
      if (cfg.saveRecords) await cfg.saveRecords([edit.id ? { ...record, id: edit.id } : record]);
      else if (edit.id) await run(supabase.from(cfg.table).update(record).eq("id", edit.id));
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
        {canManage && cfg.importable !== false && <button className="btn" onClick={() => setImporting(true)}>⬆ {t("استيراد Excel", "Import Excel")}</button>}
        {canManage && <button className="btn primary" onClick={() => { v.clear(); setEdit({ ...(cfg.defaults || {}) }); }}>{t("+ جديد", "+ New")}</button>}
      </PageHead>
      {importing && (() => {
        const Dialog = cfg.importer || ImportDialog;
        return <Dialog cfg={cfg} lookups={lookups.data} existing={list.data || []}
                       onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.reload(); }} />;
      })()}
      <Panel pad={false}>
        <Table columns={cfg.columns} rows={rows} loading={list.loading} ctx={lookups.data}
               onRow={cfg.onRow || ((r) => { v.clear(); setEdit(cfg.toForm ? cfg.toForm(r) : { ...r }); })} />
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

/**
 * Excel import for a Resource: download a template built from the form
 * fields, upload it, review a preview where every problem is listed in red
 * with its row number, then insert all rows in one request (all or nothing).
 */
export function ImportDialog({ cfg, lookups, existing, onClose, onDone }) {
  const { t } = useApp();
  const [act, busy] = useAction();
  const v = useIssues();
  const [result, setResult] = useState(null);   // { file, rows: [{ line, record, errors }] }
  const fileRef = useRef(null);
  const fields = cfg.fields.filter((f) => f.key && !f.section && !f.readOnly && f.import !== false);
  // form defaults fill only optional, non-date fields: a missing hire date or nationality must be reported, not guessed
  const defaults = Object.fromEntries(Object.entries(cfg.defaults || {}).filter(([k]) => {
    const f = fields.find((x) => x.key === k);
    return f && !f.required && f.type !== "date";
  }));

  async function template() {
    const { downloadTemplate } = await import("./lib/excel.js");
    await act(() => downloadTemplate({ name: `${cfg.title} - ${t("قالب الاستيراد", "import template")}`, entity: cfg.table, fields, lookups, t,
                                       rtl: document.documentElement.dir !== "ltr" }).then(() => true));
  }

  async function read(file) {
    v.clear(); setResult(null);
    if (!file) return;
    const { readWorkbook, convertRow } = await import("./lib/excel.js");
    const ok = await act(async () => {
      const wb = await readWorkbook(file, fields);
      const problems = [];
      if (wb.entity && wb.entity !== cfg.table) problems.push(t("هذا الملف قالب لقسم آخر. نزّل قالب هذه الشاشة واستخدمه.", "This file is a template for another screen. Download this screen's template."));
      else if (!wb.mapped) problems.push(t("لم نتعرف على أعمدة الملف. استخدم القالب المنزّل من هذه الشاشة بدون تغيير صف العناوين.", "The file's columns were not recognised. Use the template from this screen without changing the header row."));
      else if (!wb.rows.length) problems.push(t("الملف لا يحتوي على بيانات تحت صف العناوين.", "The file has no data under the header row."));
      if (problems.length) { v.check(problems); return true; }
      const codes = new Map();
      const taken = new Set(existing.map((r) => String(r.code ?? "").trim().toLowerCase()).filter(Boolean));
      const rows = wb.rows.map(({ line, cells }) => {
        const { record, errors, failed } = convertRow(cells, fields, lookups, t);
        const full = { ...defaults, ...record };
        // a value that could not be read was already reported — don't also call it "required"
        errors.push(...validateRecord(fields.filter((f) => !failed.has(f.key)), full, t).map((e) => e.msg));
        if (cfg.validate) errors.push(...cfg.validate(full, t).map((e) => (typeof e === "string" ? e : e.msg)));
        const code = String(full.code ?? "").trim().toLowerCase();
        if (code) {
          if (taken.has(code)) errors.push(t(`الرمز «${full.code}» موجود مسبقاً في النظام`, `Code "${full.code}" already exists`));
          else if (codes.has(code)) errors.push(t(`الرمز «${full.code}» مكرر في الملف (سطر ${codes.get(code)})`, `Code "${full.code}" is repeated in the file (row ${codes.get(code)})`));
          else codes.set(code, line);
        }
        return { line, record: full, errors: [...new Set(errors)] };
      });
      setResult({ file: file.name, rows });
      return true;
    });
    if (!ok && fileRef.current) fileRef.current.value = "";
  }

  const bad = result?.rows.filter((r) => r.errors.length) || [];
  const good = (result?.rows.length || 0) - bad.length;

  async function commit() {
    if (!result) { v.check([t("اختر ملف Excel أولاً", "Choose an Excel file first")]); return; }
    if (!v.check(bad.slice(0, 200).flatMap((r) => r.errors.map((e) => t(`سطر ${r.line}: ${e}`, `Row ${r.line}: ${e}`))))) return;
    const ok = await act(async () => {
      // one request → one statement: either every row is saved or none is
      const records = result.rows.map((r) => r.record);
      if (cfg.saveRecords) await cfg.saveRecords(records);
      else await run(supabase.from(cfg.table).insert(records, { defaultToNull: false }));
      return true;
    }, t(`تم استيراد ${result.rows.length} سجل`, `Imported ${result.rows.length} records`));
    if (ok) onDone();
  }

  const preview = fields.slice(0, 5);
  const show = (f, r) => {
    const x = r.record[f.key];
    if (x === undefined || x === null) return "";
    if (f.type === "select") { const opts = typeof f.options === "function" ? f.options(lookups || {}, r.record) : f.options || []; return opts.find((o) => o.id === x)?.label ?? x; }
    if (f.type === "checkbox") return x ? t("نعم", "Yes") : t("لا", "No");
    return String(x);
  };

  return (
    <Modal title={`${t("استيراد من Excel", "Import from Excel")} — ${cfg.title}`} onClose={onClose} wide
           footer={<>
             <span style={{ flex: 1 }} />
             <button className="btn" onClick={onClose}>{t("إلغاء", "Cancel")}</button>
             <button className="btn primary" onClick={commit} disabled={busy}>
               {result ? t(`تأكيد استيراد ${result.rows.length} سجل`, `Import ${result.rows.length} records`) : t("تأكيد الاستيراد", "Import")}</button>
           </>}>
      <ol className="steps">
        <li>{t("نزّل القالب — الأعمدة المعلّمة بـ * إلزامية، والقوائم المنسدلة جاهزة.", "Download the template — columns marked * are required; dropdowns are ready.")}
          {" "}<button className="btn sm" onClick={template} disabled={busy}>⬇ {t("تنزيل القالب", "Download template")}</button></li>
        <li>{t("عبّئ البيانات (سطر لكل سجل) واحفظ الملف.", "Fill one row per record and save the file.")}</li>
        <li>{t("ارفع الملف وراجع المعاينة. لن يُحفظ أي شيء حتى تكون كل الأسطر سليمة.", "Upload it and review the preview. Nothing is saved until every row is valid.")}
          <div style={{ marginTop: 6 }}><input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                               onChange={(e) => read(e.target.files?.[0])} /></div></li>
      </ol>
      <Issues issues={v.issues} title={result ? t("الرجاء تصحيح الأخطاء التالية في الملف ثم رفعه مرة أخرى:", "Please fix these rows in the file and upload it again:") : undefined} />
      {result && (
        <>
          <div className={`alert ${bad.length ? "bad" : "ok"}`}>
            {t(`${result.file}: ${result.rows.length} سطر — ${good} سليم`, `${result.file}: ${result.rows.length} rows — ${good} valid`)}
            {bad.length > 0 && t(`، ${bad.length} فيه أخطاء (موضّحة بالأحمر)`, `, ${bad.length} with errors (in red)`)}
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 360 }}>
            <table className="tbl">
              <thead><tr><th>{t("سطر", "Row")}</th>{preview.map((f) => <th key={f.key}>{f.label}</th>)}<th>{t("الحالة", "Status")}</th></tr></thead>
              <tbody>{result.rows.slice(0, 300).map((r) => (
                <tr key={r.line} className={r.errors.length ? "invalid" : ""}>
                  <td className="mono">{r.line}</td>
                  {preview.map((f) => <td key={f.key}>{show(f, r)}</td>)}
                  <td>{r.errors.length ? <span className="neg">{r.errors.join(" · ")}</span> : "✓"}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
