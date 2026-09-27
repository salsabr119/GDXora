import { describe, it, expect } from "vitest";
import { gosi, eosb, annuityRate } from "../src/lib/payroll.js";
import { isVatNumber, isSaIban } from "../src/lib/format.js";

// same figures as supabase/tests/10_erp_flow_test.sql — JS and SQL must agree
describe("GOSI", () => {
  it("Saudi legacy scheme", () => {
    expect(gosi({ basic: 10000, housing: 2500, isSaudi: true, onDate: "2026-09-30" }))
      .toEqual({ wage: 12500, employee: 1218.75, employer: 1468.75 });
  });
  it("non-Saudi: occupational hazards only", () => {
    expect(gosi({ basic: 4000, housing: 1000, isSaudi: false })).toEqual({ wage: 5000, employee: 0, employer: 100 });
  });
  it("new 2024 scheme follows the annuity schedule", () => {
    expect(annuityRate("new", "2025-06-30")).toBe(9.0);
    expect(annuityRate("new", "2026-09-30")).toBe(10.0);
    expect(annuityRate("new", "2030-01-01")).toBe(11.0);
    expect(gosi({ basic: 9000, housing: 0, isSaudi: true, scheme: "new", onDate: "2026-09-30" }).employee).toBe(967.5);
  });
  it("clamps the contribution wage", () => {
    expect(gosi({ basic: 800, housing: 0, isSaudi: false }).wage).toBe(1500);
    expect(gosi({ basic: 60000, housing: 10000, isSaudi: true }).wage).toBe(45000);
  });
  it("unregistered employees contribute nothing", () => {
    expect(gosi({ basic: 5000, housing: 0, isSaudi: true, registered: false }).employer).toBe(0);
  });
});

describe("End of service (art. 84/85)", () => {
  it("resignation between 2 and 5 years = one third", () => {
    expect(eosb(10000, "2021-01-01", "2023-12-31", "resignation").amount).toBe(5000);
  });
  it("resignation under 2 years = nothing", () => {
    expect(eosb(10000, "2024-01-01", "2025-06-30", "resignation").amount).toBe(0);
  });
  it("beyond five years: half month for the first five, full month after", () => {
    const r = eosb(10000, "2015-01-01", "2024-12-31", "employer_termination");
    expect(r.amount).toBe(Math.round((25000 + (3653 / 365 - 5) * 10000) * 100) / 100);
  });
  it("article 80 dismissal forfeits the award", () => {
    expect(eosb(10000, "2010-01-01", "2024-12-31", "article_80").amount).toBe(0);
  });
});

describe("validators", () => {
  it("VAT number", () => {
    expect(isVatNumber("300000000000003")).toBe(true);
    expect(isVatNumber("300000000000004")).toBe(false);
    expect(isVatNumber("30000000000003")).toBe(false);
  });
  it("Saudi IBAN", () => {
    expect(isSaIban("SA0380000000608010167519")).toBe(true);
    expect(isSaIban("SA03 8000 0000 6080 1016 7519")).toBe(true);
    expect(isSaIban("AE070331234567890123456")).toBe(false);
  });
});
