// Reads the project Excel template (public/templates/project-import.xlsx,
// built by scripts/make-project-template.py) into the payload of the
// import_project() database function, collecting every problem with the
// sheet and row it comes from.
import { convertRow, matchOption } from "./excel.js";

const STATUS = [
  { id: "planned", label: "مخطط", name_en: "Planned" }, { id: "active", label: "قائم", name_ar: "نشط", name_en: "Active" },
  { id: "on_hold", label: "متوقف مؤقتاً", name_ar: "متوقف", name_en: "On hold" }, { id: "completed", label: "مكتمل", name_en: "Completed" },
  { id: "closed", label: "مغلق", name_en: "Closed" },
];
const EXAMPLE = "مثال — احذفه";

const projectFields = (t) => [
  { key: "code", label: t("كود المشروع", "Project code"), ltr: true },
  { key: "name_ar", label: t("اسم المشروع (عربي)", "Project name (AR)"), required: true },
  { key: "name_en", label: t("اسم المشروع (إنجليزي)", "Project name (EN)") },
  { key: "contract_no", label: t("رقم العقد", "Contract no."), ltr: true },
  { key: "contract_value", label: t("قيمة العقد", "Contract value"), type: "money", required: true },
  { key: "retention_pct", label: t("نسبة المحتجزات", "Retention %"), type: "number" },
  { key: "advance_amount", label: t("الدفعة المقدمة", "Advance payment"), type: "money" },
  { key: "advance_recovery_pct", label: t("نسبة استرداد الدفعة المقدمة", "Advance recovery %"), type: "number" },
  { key: "opening_advance_recovered", label: t("الدفعة المقدمة المستردة سابقاً", "Advance already recovered"), type: "money" },
  { key: "opening_billing_count", label: t("عدد المستخلصات السابقة", "Previous billings"), type: "number" },
  { key: "start_date", label: t("تاريخ البداية", "Start date"), type: "date" },
  { key: "end_date", label: t("تاريخ النهاية", "End date"), type: "date" },
  { key: "status", label: t("الحالة", "Status"), type: "select", options: STATUS },
  { key: "manager_name", label: t("مدير المشروع", "Project manager") },
  { key: "location", label: t("الموقع", "Location") },
  { key: "notes", label: t("ملاحظات", "Notes") },
];
const boqFields = (t) => [
  { key: "item_no", label: t("رقم البند", "Item no.") },
  { key: "description", label: t("الوصف", "Description"), required: true },
  { key: "unit", label: t("الوحدة", "Unit") },
  { key: "quantity", label: t("الكمية", "Quantity"), type: "number", required: true },
  { key: "unit_price", label: t("سعر الوحدة", "Unit price"), type: "money", required: true },
  { key: "opening_billed_qty", label: t("الكمية المفوترة سابقاً", "Previously billed qty"), type: "number" },
];
const BOQ_COLS = { item_no: 1, description: 2, unit: 3, quantity: 4, unit_price: 5, opening_billed_qty: 7 };
const customerFields = (t) => [
  { key: "name_ar", label: t("اسم العميل", "Customer name"), required: true },
  { key: "name_en", label: t("اسم العميل (إنجليزي)", "Customer name (EN)") },
  { key: "vat_number", label: t("الرقم الضريبي", "VAT number"), ltr: true },
  { key: "cr_number", label: t("السجل التجاري", "CR number"), ltr: true },
  { key: "building_no", label: t("رقم المبنى", "Building no."), ltr: true },
  { key: "street", label: t("الشارع", "Street") }, { key: "district", label: t("الحي", "District") },
  { key: "city", label: t("المدينة", "City") }, { key: "postal_code", label: t("الرمز البريدي", "Postal code"), ltr: true },
  { key: "email", label: t("البريد الإلكتروني", "E-mail"), ltr: true }, { key: "phone", label: t("الجوال", "Phone"), ltr: true },
];

function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join("");
  if ("result" in v) return plain(v.result);
  if ("text" in v) return v.text;
  return null;
}
const blank = (v) => v === null || v === undefined || String(v).trim() === "";

/** key/value sheet: keys in a (hidden) key column, values in valueCol */
function readPairs(ws, keyCol, valueCol) {
  const out = {};
  ws.eachRow({ includeEmpty: false }, (row) => {
    const k = plain(row.getCell(keyCol).value);
    if (typeof k === "string" && /^[a-z_]+$/.test(k)) {
      const v = plain(row.getCell(valueCol).value);
      if (!blank(v)) out[k] = v;
    }
  });
  return out;
}
const hasKey = (ws, col, key) => { let f = false; ws.eachRow((row) => { if (plain(row.getCell(col).value) === key) f = true; }); return f; };

/**
 * @param buffer ArrayBuffer of the uploaded .xlsx
 * @param ctx { customers: [{id,label,...}], projects: [{code}], t }
 * @returns { payload, summary, errors: [msg], warnings: [msg] }
 */
export async function parseProjectWorkbook(buffer, { customers = [], projects = [], t }) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const errors = []; const warnings = [];
  const sheetP = wb.worksheets.find((w) => hasKey(w, 5, "name_ar"));
  const sheetB = wb.getWorksheet("جدول الكميات") || wb.worksheets.find((w) => String(plain(w.getCell(1, 2).value) || "").startsWith("الوصف"));
  const sheetC = wb.worksheets.find((w) => w !== sheetP && hasKey(w, 3, "vat_number"));
  if (!sheetP || !sheetB) {
    return { errors: [t("هذا الملف ليس قالب رفع المشروع. نزّل القالب من هذه الشاشة وعبّئه بدون تغيير أسماء الأوراق.", "This is not the project template. Download the template from this screen and keep the sheet names.")], warnings };
  }

  // ── project
  const pc = readPairs(sheetP, 5, 3);
  if (pc.advance_recovered !== undefined && pc.opening_advance_recovered === undefined) pc.opening_advance_recovered = pc.advance_recovered;  // first template version
  const P = t("ورقة المشروع", "Project sheet");
  const { record: project, errors: pErr } = convertRow(pc, projectFields(t), {}, t);
  pErr.forEach((e) => errors.push(`${P}: ${e}`));
  for (const f of projectFields(t)) if (f.required && blank(pc[f.key])) errors.push(t(`${P}: حقل «${f.label}» مطلوب`, `${P}: "${f.label}" is required`));
  for (const k of ["retention_pct", "advance_recovery_pct"]) {
    if (project[k] !== undefined && (project[k] < 0 || project[k] > 100)) errors.push(t(`${P}: النسبة «${project[k]}» يجب أن تكون بين 0 و 100`, `${P}: percentage ${project[k]} must be between 0 and 100`));
  }
  for (const k of ["contract_value", "advance_amount", "opening_advance_recovered", "opening_billing_count"]) {
    if (project[k] !== undefined && project[k] < 0) errors.push(t(`${P}: القيمة لا تكون سالبة (${project[k]})`, `${P}: value cannot be negative (${project[k]})`));
  }
  if (project.opening_billing_count !== undefined && !Number.isInteger(project.opening_billing_count)) errors.push(t(`${P}: عدد المستخلصات السابقة يجب أن يكون رقماً صحيحاً`, `${P}: number of previous billings must be a whole number`));
  if ((project.opening_advance_recovered || 0) > (project.advance_amount || 0)) errors.push(t(`${P}: الدفعة المستردة سابقاً أكبر من الدفعة المقدمة`, `${P}: advance already recovered exceeds the advance`));
  if (project.start_date && project.end_date && project.end_date < project.start_date) errors.push(t(`${P}: تاريخ النهاية قبل تاريخ البداية`, `${P}: end date is before the start date`));
  if (project.code && projects.some((x) => String(x.code || "").toLowerCase() === String(project.code).toLowerCase())) errors.push(t(`${P}: كود المشروع «${project.code}» مستخدم لمشروع آخر`, `${P}: project code "${project.code}" is already used`));

  // ── customer: an existing one named on the project sheet, or the new one on the customer sheet
  let customer_id = null; let new_customer = null; let customerLabel = null;
  const cc = sheetC ? readPairs(sheetC, 3, 2) : {};
  if (!blank(pc.customer)) {
    const m = matchOption(customers, pc.customer);
    if (m) { customer_id = m.id; customerLabel = m.label; }
  }
  if (!customer_id && !blank(cc.name_ar)) {
    const C = t("ورقة العميل", "Customer sheet");
    const { record, errors: cErr } = convertRow(cc, customerFields(t), {}, t);
    cErr.forEach((e) => errors.push(`${C}: ${e}`));
    if (record.vat_number && !/^3\d{13}3$/.test(record.vat_number)) errors.push(t(`${C}: الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3`, `${C}: VAT number must be 15 digits starting and ending with 3`));
    if (record.cr_number && !/^\d{10}$/.test(record.cr_number)) errors.push(t(`${C}: السجل التجاري 10 أرقام`, `${C}: CR number is 10 digits`));
    if (record.postal_code && !/^\d{5}$/.test(record.postal_code)) errors.push(t(`${C}: الرمز البريدي 5 أرقام`, `${C}: postal code is 5 digits`));
    if (record.building_no && !/^\d{4}$/.test(record.building_no)) errors.push(t(`${C}: رقم المبنى 4 أرقام`, `${C}: building number is 4 digits`));
    const dup = record.vat_number && customers.find((c) => c.vat_number === record.vat_number);
    if (dup) { customer_id = dup.id; customerLabel = dup.label; warnings.push(t(`العميل برقم ضريبي ${record.vat_number} موجود مسبقاً («${dup.name_ar}») وسيُربط به المشروع`, `A customer with VAT ${record.vat_number} already exists ("${dup.name_ar}") — the project will be linked to it`)); }
    else { new_customer = record; customerLabel = record.name_ar; }
  }
  if (!customer_id && !new_customer) {
    errors.push(blank(pc.customer)
      ? t(`${P}: حقل «العميل» مطلوب — اكتب اسم عميل موجود أو عبّئ ورقة «العميل»`, `${P}: "Customer" is required — name an existing customer or fill the customer sheet`)
      : t(`${P}: العميل «${pc.customer}» غير موجود في النظام — اكتب الاسم كما هو مسجّل أو عبّئ ورقة «العميل» لإضافته`, `${P}: customer "${pc.customer}" was not found — use the registered name or fill the customer sheet`));
  }

  // ── BOQ
  const B = t("جدول الكميات", "BOQ");
  const boq = [];
  sheetB.eachRow({ includeEmpty: false }, (row, line) => {
    if (line < 3) return;
    const cells = {};
    for (const [k, c] of Object.entries(BOQ_COLS)) { const v = plain(row.getCell(c).value); if (!blank(v)) cells[k] = v; }
    if (!Object.keys(cells).length) return;
    const where = t(`${B} سطر ${line}`, `${B} row ${line}`);
    if (String(cells.description || "").includes(EXAMPLE)) { errors.push(t(`${where}: سطر مثال — احذفه قبل الرفع`, `${where}: example row — delete it before uploading`)); return; }
    const { record, errors: e } = convertRow(cells, boqFields(t), {}, t);
    e.forEach((m) => errors.push(`${where}: ${m}`));
    for (const f of boqFields(t)) if (f.required && blank(cells[f.key])) errors.push(t(`${where}: «${f.label}» مطلوب`, `${where}: "${f.label}" is required`));
    if (record.quantity !== undefined && !(record.quantity > 0)) errors.push(t(`${where}: الكمية يجب أن تكون أكبر من صفر`, `${where}: quantity must be above zero`));
    if (record.unit_price !== undefined && record.unit_price < 0) errors.push(t(`${where}: سعر الوحدة لا يكون سالباً`, `${where}: unit price cannot be negative`));
    if (record.opening_billed_qty !== undefined && record.quantity !== undefined && record.opening_billed_qty > record.quantity)
      errors.push(t(`${where}: الكمية المفوترة سابقاً (${record.opening_billed_qty}) أكبر من كمية العقد (${record.quantity})`, `${where}: previously billed qty exceeds the contract qty`));
    if (record.opening_billed_qty !== undefined && record.opening_billed_qty < 0) errors.push(t(`${where}: الكمية المفوترة سابقاً لا تكون سالبة`, `${where}: previously billed qty cannot be negative`));
    boq.push({ line, ...record });
  });
  if (!boq.length && !errors.some((e) => e.startsWith(B))) errors.push(t(`${B}: لا توجد بنود — أضف بنداً واحداً على الأقل`, `${B}: no items — add at least one`));

  const total = boq.reduce((n, b) => n + Math.round((b.quantity || 0) * (b.unit_price || 0) * 100) / 100, 0);
  const billed = boq.reduce((n, b) => n + Math.round((b.opening_billed_qty || 0) * (b.unit_price || 0) * 100) / 100, 0);
  if (project.contract_value !== undefined && boq.length && Math.abs(total - project.contract_value) >= 0.01) {
    warnings.push(t(`قيمة العقد (${project.contract_value.toLocaleString("en")}) لا تساوي إجمالي جدول الكميات (${total.toLocaleString("en", { maximumFractionDigits: 2 })})`,
                    `Contract value (${project.contract_value}) differs from the BOQ total (${total.toFixed(2)})`));
  }
  if (billed > 0 && !project.opening_billing_count) warnings.push(t("يوجد كميات مفوترة سابقاً لكن «عدد المستخلصات السابقة» فارغ — المستخلص القادم سيأخذ رقم 1", "Previously billed quantities exist but the number of previous billings is empty — the next billing will be no. 1"));

  return {
    errors, warnings,
    payload: { project, customer_id, new_customer, boq: boq.map(({ line, ...b }) => b) },
    summary: { name: project.name_ar, customer: customerLabel, newCustomer: !!new_customer, items: boq.length, total, billed,
               previewBoq: boq.slice(0, 200) },
  };
}
