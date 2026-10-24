import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildTemplate, readWorkbook, convertRow, matchOption } from "../src/lib/excel.js";

const t = (ar) => ar;
const fields = [
  { section: "x" },
  { key: "code", label: "الرمز", ltr: true },
  { key: "first_name_ar", label: "الاسم الأول", required: true },
  { key: "national_id", label: "رقم الهوية", ltr: true },
  { key: "department_id", label: "القسم", type: "select", options: (lk) => lk.departments },
  { key: "gender", label: "الجنس", type: "select", options: [{ id: "male", label: "ذكر" }, { id: "female", label: "أنثى" }] },
  { key: "hire_date", label: "تاريخ المباشرة", type: "date", required: true },
  { key: "basic_salary", label: "الراتب الأساسي", type: "money", required: true },
  { key: "gosi_registered", label: "مسجل في التأمينات", type: "checkbox" },
  { key: "iban", label: "الآيبان", ltr: true, transform: (v) => v.replace(/\s/g, "").toUpperCase() },
];
const lookups = { departments: [{ id: "d1", name_ar: "المالية", label: "المالية" }, { id: "d2", code: "HR", name_ar: "الموارد البشرية", label: "HR — الموارد البشرية" }] };

async function roundTrip(fill) {
  const wb = await buildTemplate({ entity: "employees", fields, lookups, t });
  fill(wb.worksheets[0]);
  const buf = await wb.xlsx.writeBuffer();
  return readWorkbook({ arrayBuffer: async () => buf }, fields);
}

describe("excel import", () => {
  it("template carries labels, required marks and hidden keys", async () => {
    const wb = await buildTemplate({ entity: "employees", fields, lookups, t });
    const ws = wb.worksheets[0];
    expect(ws.getCell(1, 2).value).toBe("الاسم الأول *");
    expect(wb.getWorksheet("_meta").getCell(2, 4).value).toBe("department_id");
    expect(wb.getWorksheet("_meta").getCell(1, 2).value).toBe("employees");
    expect(wb.getWorksheet("_lists").state).toBe("veryHidden");
  });

  it("reads rows and converts each type", async () => {
    const wb = await roundTrip((ws) => {
      ws.addRow(["E1", "أحمد", 1012345678, "الموارد البشرية", "ذكر", new Date(Date.UTC(2024, 0, 15)), "٨٬٥٠٠", "نعم", "sa03 8000 0000 6080 1016 7519"]);
      ws.addRow([]);                                                   // blank rows are skipped
      ws.addRow(["E2", "سارة", "0123", "HR", "أنثى", "01/02/2025", 9000.5, "لا", null]);
    });
    expect(wb.entity).toBe("employees");
    expect(wb.rows.map((r) => r.line)).toEqual([2, 4]);
    const a = convertRow(wb.rows[0].cells, fields.slice(1), lookups, t);
    expect(a.errors).toEqual([]);
    expect(a.record).toEqual({ code: "E1", first_name_ar: "أحمد", national_id: "1012345678", department_id: "d2", gender: "male",
                               hire_date: "2024-01-15", basic_salary: 8500, gosi_registered: true, iban: "SA0380000000608010167519" });
    const b = convertRow(wb.rows[1].cells, fields.slice(1), lookups, t);
    expect(b.record).toMatchObject({ national_id: "0123", department_id: "d2", gender: "female", hire_date: "2025-02-01", basic_salary: 9000.5, gosi_registered: false });
  });

  it("reports bad values with the column name", async () => {
    const wb = await roundTrip((ws) => ws.addRow(["E3", "خالد", null, "المبيعات", "ذكر", "2025-13-40", "abc", "ربما"]));
    const { errors } = convertRow(wb.rows[0].cells, fields.slice(1), lookups, t);
    expect(errors).toEqual([
      "«القسم»: «المبيعات» غير موجود في القائمة",
      "«تاريخ المباشرة»: «2025-13-40» ليس تاريخاً صحيحاً (استخدم YYYY-MM-DD)",
      "«الراتب الأساسي»: «abc» ليس رقماً",
      "«مسجل في التأمينات»: اكتب «نعم» أو «لا»",
    ]);
  });

  it("maps columns by header label when the hidden sheet is missing", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("بيانات");
    ws.addRow(["الراتب الأساسي *", "الاسم الأول", "غير معروف"]);
    ws.addRow([5000, "منى", "x"]);
    const buf = await wb.xlsx.writeBuffer();
    const r = await readWorkbook({ arrayBuffer: async () => buf }, fields);
    expect(r.mapped).toBe(2);
    expect(r.rows[0].cells).toEqual({ basic_salary: 5000, first_name_ar: "منى" });
  });

  it("matches options by code, name or label", () => {
    expect(matchOption(lookups.departments, "hr").id).toBe("d2");
    expect(matchOption(lookups.departments, " المالية ").id).toBe("d1");
    expect(matchOption(lookups.departments, "HR — الموارد البشرية").id).toBe("d2");
    expect(matchOption(lookups.departments, "غير موجود")).toBeNull();
  });
});
