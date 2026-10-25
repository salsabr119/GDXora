// Excel (.xlsx) export, import templates and parsing. exceljs is loaded on
// demand so it never weighs on the initial page load.
//
// Import model: a template has one data sheet whose header row holds the field
// labels (required ones end with " *") plus a hidden "_meta" sheet listing the
// field keys in column order, so a user can rename a header without breaking
// the mapping. Cell values are converted per field type and then validated by
// the same rules as the on-screen form.

const load = () => import("exceljs").then((m) => m.default || m);

const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } };
const REQ_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF8B1A1A" } };
const HEAD_FONT = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };

export function downloadBuffer(buf, filename) {
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** file-system-safe name: keeps Arabic, drops characters Windows refuses */
export const safeName = (s) => String(s || "export").replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 80) || "export";

/**
 * Export rows to an .xlsx file.
 * columns: [{ label, value(row) → string|number|null, type: 'money'|'num'|'date'|'text' }]
 */
export async function exportXlsx({ filename, sheet = "Sheet1", columns, rows, rtl = true, title }) {
  const ExcelJS = await load();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeName(sheet).slice(0, 31), { views: [{ rightToLeft: rtl, state: "frozen", ySplit: title ? 2 : 1 }] });
  let r0 = 1;
  if (title) {
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 13, name: "Arial" };
    r0 = 2;
  }
  columns.forEach((c, j) => {
    const cell = ws.getCell(r0, j + 1);
    cell.value = c.label;
    cell.font = HEAD_FONT; cell.fill = HEAD_FILL;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  rows.forEach((row, i) => {
    columns.forEach((c, j) => {
      const cell = ws.getCell(r0 + 1 + i, j + 1);
      const v = c.value(row);
      if (v === null || v === undefined || v === "") return;
      if (c.type === "money" || c.type === "num") {
        const n = Number(v);
        cell.value = Number.isFinite(n) ? n : v;
        if (c.type === "money" || !Number.isInteger(n)) cell.numFmt = "#,##0.00";
      } else if (c.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(String(v))) {
        const [y, m, d] = String(v).slice(0, 10).split("-").map(Number);
        cell.value = new Date(Date.UTC(y, m - 1, d)); cell.numFmt = "yyyy-mm-dd";
      } else cell.value = String(v);
    });
  });
  columns.forEach((c, j) => {
    let w = String(c.label || "").length;
    for (const row of rows.slice(0, 300)) w = Math.max(w, String(c.value(row) ?? "").length);
    ws.getColumn(j + 1).width = Math.min(Math.max(w + 2, 10), 60);
  });
  downloadBuffer(await wb.xlsx.writeBuffer(), `${safeName(filename)}.xlsx`);
}

/* ── import ──────────────────────────────────────────────────────────── */

const importable = (fields) => fields.filter((f) => f.key && !f.section && !f.readOnly && f.import !== false);
const optionsOf = (f, lookups, record) => (typeof f.options === "function" ? f.options(lookups || {}, record || {}) : f.options || []);
const YES = ["نعم", "yes", "y", "true", "1", "✓", "✔", "x"];
const NO = ["لا", "no", "n", "false", "0"];

/** Build and download an import template for the given form fields. */
export async function downloadTemplate({ name, ...opts }) {
  const wb = await buildTemplate(opts);
  downloadBuffer(await wb.xlsx.writeBuffer(), `${safeName(name)}.xlsx`);
}

export async function buildTemplate({ entity, fields, lookups, t, rtl = true, rows = [] }) {
  const ExcelJS = await load();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("البيانات", "Data"), { views: [{ rightToLeft: rtl, state: "frozen", ySplit: 1 }] });
  const lists = wb.addWorksheet("_lists", { state: "veryHidden" });
  const meta = wb.addWorksheet("_meta", { state: "veryHidden" });
  const cols = importable(fields);
  meta.getCell(1, 1).value = "gdxora-import"; meta.getCell(1, 2).value = entity;
  let listCol = 0;
  cols.forEach((f, j) => {
    const c = j + 1;
    meta.getCell(2, c).value = f.key;
    const head = ws.getCell(1, c);
    head.value = f.label + (f.required ? " *" : "");
    head.font = HEAD_FONT; head.fill = f.required ? REQ_FILL : HEAD_FILL;
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    if (f.hint) head.note = f.hint;
    ws.getColumn(c).width = Math.min(Math.max(String(head.value).length + 4, 14), 40);
    const range = `${ws.getColumn(c).letter}2:${ws.getColumn(c).letter}2000`;
    let validation = null;
    if (f.type === "select") {
      const opts = optionsOf(f, lookups);
      if (opts.length) {
        listCol += 1;
        opts.forEach((o, i) => { lists.getCell(i + 1, listCol).value = o.label; });
        const L = lists.getColumn(listCol).letter;
        validation = { type: "list", allowBlank: !f.required, formulae: [`_lists!$${L}$1:$${L}$${opts.length}`],
                       showErrorMessage: false };   // a typed code/name is still accepted by the importer
      }
    } else if (f.type === "checkbox") {
      validation = { type: "list", allowBlank: true, formulae: ['"نعم,لا"'] };
    } else if (f.type === "date") {
      ws.getColumn(c).numFmt = "yyyy-mm-dd";
    } else if (f.type === "money") {
      ws.getColumn(c).numFmt = "#,##0.00";
    } else {
      ws.getColumn(c).numFmt = "@";          // text: keeps leading zeros (IDs, IBAN, phone)
    }
    if (validation) ws.dataValidations.add(range, validation);
  });
  // prefilled rows (current data to edit and upload back)
  rows.forEach((rec, i) => {
    cols.forEach((f, j) => {
      const v = rec[f.key];
      if (v === null || v === undefined || v === "") return;
      const cell = ws.getCell(i + 2, j + 1);
      if (f.type === "select") cell.value = optionsOf(f, lookups, rec).find((o) => o.id === v)?.label ?? String(v);
      else if (f.type === "checkbox") cell.value = v ? "نعم" : "لا";
      else if (f.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(String(v))) { const [y, m, d] = String(v).slice(0, 10).split("-").map(Number); cell.value = new Date(Date.UTC(y, m - 1, d)); }
      else if (f.type === "money" || f.type === "number") cell.value = Number(v);
      else cell.value = String(v);
    });
  });
  return wb;
}

/** exceljs cell value → plain JS (string | number | Date | boolean | null) */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join("");
  if ("result" in v) return plain(v.result);            // formula
  if ("text" in v) return v.text;                       // hyperlink
  if ("error" in v) return null;
  return String(v);
}

const AR_DIGITS = /[٠-٩۰-۹]/g;
const toLatin = (s) => s.replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - (d >= "۰" ? 0x6f0 : 0x660)));
const norm = (s) => toLatin(String(s ?? "")).trim().replace(/\s+/g, " ").toLowerCase();

function toDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);   // exceljs dates are UTC midnight
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = toLatin(String(v)).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);          // dd/mm/yyyy (Saudi usage)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return undefined;
}
const validDate = (s) => s && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);

/** find the option a cell refers to, by label, code, Arabic/English name, VAT number or id */
export function matchOption(opts, raw) {
  const s = norm(raw);
  if (!s) return null;
  const keys = (o) => [o.id, o.label, o.code, o.name_ar, o.name_en, o.vat_number,
                       ...(String(o.label || "").split(" — "))].filter(Boolean).map(norm);
  return opts.find((o) => keys(o).includes(s)) || null;
}

/**
 * Convert one sheet row to a record. Returns { record, errors: [msg] }.
 * Empty cells are left out so database defaults apply.
 */
export function convertRow(cells, fields, lookups, t) {
  const record = {}; const errors = []; const failed = new Set();
  for (const f of fields) {
    let v = plain(cells[f.key]);
    if (typeof v === "string") v = v.trim();
    if (v === null || v === "") continue;
    switch (f.type) {
      case "number": case "money": {
        const n = typeof v === "number" ? v : Number(toLatin(String(v)).replace(/[,\s٬]/g, "").replace("٫", "."));
        if (!Number.isFinite(n)) { failed.add(f.key); errors.push(t(`«${f.label}»: «${v}» ليس رقماً`, `"${f.label}": "${v}" is not a number`)); continue; }
        record[f.key] = n; break;
      }
      case "date": {
        const d = toDate(v);
        if (!validDate(d)) { failed.add(f.key); errors.push(t(`«${f.label}»: «${v}» ليس تاريخاً صحيحاً (استخدم YYYY-MM-DD)`, `"${f.label}": "${v}" is not a valid date (use YYYY-MM-DD)`)); continue; }
        record[f.key] = d; break;
      }
      case "checkbox": {
        const s = norm(v === true ? "1" : v === false ? "0" : v);
        if (YES.includes(s)) record[f.key] = true;
        else if (NO.includes(s)) record[f.key] = false;
        else { failed.add(f.key); errors.push(t(`«${f.label}»: اكتب «نعم» أو «لا»`, `"${f.label}": use yes or no`)); }
        break;
      }
      case "select": {
        const o = matchOption(optionsOf(f, lookups, record), v);
        if (!o) { failed.add(f.key); errors.push(t(`«${f.label}»: «${v}» غير موجود في القائمة`, `"${f.label}": "${v}" is not in the list`)); continue; }
        record[f.key] = o.id; break;
      }
      default: {
        let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
        if (typeof v === "number" && Number.isInteger(v)) s = String(v);     // 1010000011 not 1010000011.0
        record[f.key] = f.ltr ? toLatin(s) : s;
      }
    }
    if (f.transform && record[f.key] !== undefined) record[f.key] = f.transform(record[f.key]);
  }
  return { record, errors, failed };
}

/** Read the first data sheet of a workbook → { entity, rows: [{ line, cells: {key: value} }] } */
export async function readWorkbook(file, fields) {
  const ExcelJS = await load();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets.find((w) => !w.name.startsWith("_") && w.state === "visible") || wb.worksheets[0];
  const meta = wb.getWorksheet("_meta");
  const cols = importable(fields);
  // column → key: from the hidden meta row, else by matching header labels
  const keyAt = {};
  const header = ws.getRow(1);
  const byLabel = new Map(cols.map((f) => [norm(f.label), f.key]));
  const width = Math.max(ws.columnCount, header.cellCount);
  for (let c = 1; c <= width; c++) {
    const metaKey = meta ? plain(meta.getCell(2, c).value) : null;
    const label = norm(String(plain(header.getCell(c).value) ?? "").replace(/\s*\*\s*$/, ""));
    const key = (metaKey && cols.some((f) => f.key === metaKey)) ? metaKey : byLabel.get(label) || cols.find((f) => norm(f.key) === label)?.key;
    if (key) keyAt[c] = key;
  }
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, line) => {
    if (line === 1) return;
    const cells = {};
    let any = false;
    for (const [c, key] of Object.entries(keyAt)) {
      const v = plain(row.getCell(Number(c)).value);
      if (v !== null && String(v).trim() !== "") { cells[key] = v; any = true; }
    }
    if (any) rows.push({ line, cells });
  });
  return { entity: meta ? plain(meta.getCell(1, 2).value) : null, mapped: Object.keys(keyAt).length, rows };
}
