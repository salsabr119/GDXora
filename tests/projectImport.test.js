import { describe, it, expect } from "vitest";
import fs from "fs";
import ExcelJS from "exceljs";
import { parseProjectWorkbook } from "../src/lib/projectImport.js";

const t = (ar) => ar;
const customers = [{ id: "c1", code: "CUS-001", name_ar: "شركة العميل", vat_number: "300000000000003", label: "CUS-001 — شركة العميل" }];

async function fill(edit) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("public/templates/project-import.xlsx");
  const ps = wb.getWorksheet("المشروع"), bs = wb.getWorksheet("جدول الكميات"), cs = wb.getWorksheet("العميل");
  const set = (key, v) => ps.eachRow((row) => { if (row.getCell(5).value === key) row.getCell(3).value = v; });
  for (let r = 3; r <= 5; r++) for (const c of [1, 2, 3, 4, 5, 7]) bs.getCell(r, c).value = null;   // drop the example rows
  edit({ set, bs, cs, setCust: (key, v) => cs.eachRow((row) => { if (row.getCell(3).value === key) row.getCell(2).value = v; }) });
  return (await wb.xlsx.writeBuffer());
}

describe("project template import", () => {
  it("the shipped template exists", () => expect(fs.existsSync("public/templates/project-import.xlsx")).toBe(true));

  it("reads a running project with an existing customer", async () => {
    const buf = await fill(({ set, bs }) => {
      set("name_ar", "برج الرياض"); set("customer", "شركة العميل"); set("contract_value", 150000); set("retention_pct", 10);
      set("advance_amount", 30000); set("advance_recovery_pct", 20); set("opening_advance_recovered", 4000); set("opening_billing_count", 1);
      set("start_date", new Date(Date.UTC(2026, 0, 1)));
      bs.getRow(3).values = ["1", "حفر", "م3", 1000, 100, null, 200];
      bs.getRow(4).values = ["2", "ردم", "م3", 500, 100];
    });
    const r = await parseProjectWorkbook(buf, { customers, t });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.payload.customer_id).toBe("c1");
    expect(r.payload.project).toMatchObject({ name_ar: "برج الرياض", status: "active", contract_value: 150000, opening_billing_count: 1,
                                              opening_advance_recovered: 4000, start_date: "2026-01-01" });
    expect(r.payload.boq).toEqual([
      { item_no: "1", description: "حفر", unit: "م3", quantity: 1000, unit_price: 100, opening_billed_qty: 200 },
      { item_no: "2", description: "ردم", unit: "م3", quantity: 500, unit_price: 100 }]);
    expect(r.summary).toMatchObject({ items: 2, total: 150000, billed: 20000 });
  });

  it("creates a new customer from the customer sheet", async () => {
    const buf = await fill(({ set, bs, setCust }) => {
      set("name_ar", "مشروع"); set("contract_value", 1000);
      setCust("name_ar", "عميل جديد"); setCust("vat_number", "311111111111113"); setCust("postal_code", "12345");
      bs.getRow(3).values = ["1", "بند", "عدد", 10, 100];
    });
    const r = await parseProjectWorkbook(buf, { customers, t });
    expect(r.errors).toEqual([]);
    expect(r.payload.customer_id).toBeNull();
    expect(r.payload.new_customer).toMatchObject({ name_ar: "عميل جديد", vat_number: "311111111111113", postal_code: "12345" });
  });

  it("lists every problem with its sheet and row", async () => {
    const buf = await fill(({ set, bs }) => {
      set("name_ar", null); set("customer", "عميل غير موجود"); set("contract_value", 5000); set("retention_pct", 150);
      set("advance_amount", 100); set("opening_advance_recovered", 500);
      bs.getRow(3).values = ["1", "أعمال الحفر والردم (مثال — احذفه)", "م3", 1, 1];
      bs.getRow(4).values = ["2", null, "م3", 10, "abc", null, 20];
    });
    const r = await parseProjectWorkbook(buf, { customers, projects: [], t });
    expect(r.errors).toEqual([
      "ورقة المشروع: حقل «اسم المشروع (عربي)» مطلوب",
      "ورقة المشروع: النسبة «150» يجب أن تكون بين 0 و 100",
      "ورقة المشروع: الدفعة المستردة سابقاً أكبر من الدفعة المقدمة",
      "ورقة المشروع: العميل «عميل غير موجود» غير موجود في النظام — اكتب الاسم كما هو مسجّل أو عبّئ ورقة «العميل» لإضافته",
      "جدول الكميات سطر 3: سطر مثال — احذفه قبل الرفع",
      "جدول الكميات سطر 4: «سعر الوحدة»: «abc» ليس رقماً",
      "جدول الكميات سطر 4: «الوصف» مطلوب",
      "جدول الكميات سطر 4: الكمية المفوترة سابقاً (20) أكبر من كمية العقد (10)",
    ]);
  });

  it("rejects a file that is not the template", async () => {
    const wb = new ExcelJS.Workbook(); wb.addWorksheet("x").addRow(["a"]);
    const r = await parseProjectWorkbook(await wb.xlsx.writeBuffer(), { customers, t });
    expect(r.errors[0]).toContain("ليس قالب رفع المشروع");
  });
});
