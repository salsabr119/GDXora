import { describe, it, expect } from "vitest";
import { encodeQr, decodeQr, buildInvoiceXml, invoiceHash, processInvoice, sha256Base64 } from "../src/lib/zatca/index.js";

const seller = {
  name_ar: "شركة ألف للمقاولات", legal_name: "شركة ألف للمقاولات المحدودة", vat_number: "300000000000003",
  cr_number: "1010101010", street: "طريق الملك فهد", building_no: "1234", district: "العليا",
  city: "الرياض", postal_code: "12211", country: "SA",
};
const buyer = {
  name_ar: "شركة الرياض القابضة", vat_number: "310000000000003", street: "شارع العليا",
  building_no: "4321", district: "الملز", city: "الرياض", postal_code: "12611",
};
const invoice = {
  number: "INV-00001", zatca_uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be", issue_date: "2026-09-27",
  issue_time: "10:15:00", supply_date: "2026-09-27", invoice_kind: "standard", doc_type: "invoice",
  currency: "SAR", subtotal: 1000, advance_deduction: 0, taxable_amount: 1000, vat_amount: 150,
  total: 1150, retention_amount: 0, zatca_icv: 1,
  zatca_pih: "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
};
const lines = [{ description: "أعمال صيانة", quantity: 2, unit_price: 600, discount: 200, tax_category: "S",
                 tax_rate: 15, line_net: 1000, line_vat: 150, line_total: 1150 }];

describe("ZATCA QR (TLV)", () => {
  it("matches the reference encoding for an ASCII seller", () => {
    const qr = encodeQr({ sellerName: "Bobs Records", vatNumber: "310122393500003",
                          timestamp: "2022-04-25T15:30:00Z", total: "1000.00", vatTotal: "150.00" });
    expect(qr).toBe("AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==");
  });

  it("uses UTF-8 byte length for Arabic values and round-trips", () => {
    const qr = encodeQr({ sellerName: seller.name_ar, vatNumber: seller.vat_number,
                          timestamp: "2026-09-27T10:15:00", total: 1150, vatTotal: 150 });
    const raw = Buffer.from(qr, "base64");
    expect(raw[0]).toBe(1);
    expect(raw[1]).toBe(Buffer.byteLength(seller.name_ar, "utf8"));   // bytes, not characters
    expect(raw[1]).toBeGreaterThan(seller.name_ar.length);
    expect(decodeQr(qr)).toEqual({ 1: seller.name_ar, 2: seller.vat_number, 3: "2026-09-27T10:15:00", 4: "1150.00", 5: "150.00" });
  });

  it("rejects missing mandatory fields", () => {
    expect(() => encodeQr({ sellerName: "x", vatNumber: "", timestamp: "t", total: 1, vatTotal: 0 })).toThrow(/vatNumber/);
  });

  it("encodes long values with the BER long-form length", () => {
    const long = "x".repeat(300);
    const qr = encodeQr({ sellerName: long, vatNumber: "3", timestamp: "t", total: 1, vatTotal: 0 });
    expect(decodeQr(qr)[1]).toBe(long);
  });
});

describe("ZATCA UBL XML", () => {
  it("builds canonical XML with the required ZATCA elements", () => {
    const xml = buildInvoiceXml({ invoice, lines, seller, buyer, qr: "QRDATA" });
    expect(xml.startsWith('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac=')).toBe(true);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain("<cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID>");
    expect(xml).toContain(invoice.zatca_pih);
    expect(xml).toContain('<cbc:CompanyID>310000000000003</cbc:CompanyID>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">1000.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">1150.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:Amount currencyID="SAR">200.00</cbc:Amount>');   // line discount
    expect(xml).toContain("QRDATA");
    expect(xml).not.toMatch(/\/>/);           // C14N: no self-closing tags
    expect(xml).not.toMatch(/>\s+</);          // no whitespace between elements
  });

  it("escapes XML special characters", () => {
    const xml = buildInvoiceXml({ invoice, lines: [{ ...lines[0], description: 'A & B <"C">' }], seller, buyer });
    expect(xml).toContain("<cbc:Name>A &amp; B &lt;\"C\"&gt;</cbc:Name>");
  });

  it("marks credit notes and references the original invoice", () => {
    const xml = buildInvoiceXml({ invoice: { ...invoice, doc_type: "credit_note", number: "CN-00001", reason: "خصم" },
                                  lines, seller, buyer, refNumber: "INV-00001" });
    expect(xml).toContain('name="0100000">381<');
    expect(xml).toContain("<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-00001</cbc:ID>");
    expect(xml).toContain("<cbc:InstructionNote>خصم</cbc:InstructionNote>");
  });

  it("applies advance recovery as a document allowance that reduces the VAT base", () => {
    const inv = { ...invoice, subtotal: 220000, advance_deduction: 22000, taxable_amount: 198000,
                  vat_amount: 29700, total: 227700, retention_amount: 22000 };
    const ls = [{ description: "خرسانة", quantity: 200, unit_price: 600, discount: 0, tax_category: "S", tax_rate: 15,
                  line_net: 120000, line_vat: 18000, line_total: 138000 },
                { description: "تشطيب", quantity: 1000, unit_price: 100, discount: 0, tax_category: "S", tax_rate: 15,
                  line_net: 100000, line_vat: 15000, line_total: 115000 }];
    const xml = buildInvoiceXml({ invoice: inv, lines: ls, seller, buyer });
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">198000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">29700.00</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">22000.00</cbc:AllowanceTotalAmount>');
    expect(xml).toContain("محتجزات ضمان");
  });

  it("simplified invoices carry the 0200000 code and no buyer VAT", () => {
    const xml = buildInvoiceXml({ invoice: { ...invoice, invoice_kind: "simplified" }, lines, seller, buyer: null });
    expect(xml).toContain('name="0200000">388<');
  });
});

describe("ZATCA hash & processing", () => {
  it("computes the initial PIH constant (base64 of hex sha256('0'))", async () => {
    const hex = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0"))).toString("hex");
    expect(Buffer.from(hex).toString("base64")).toBe(invoice.zatca_pih);
  });

  it("hash ignores the QR block and is deterministic", async () => {
    const h1 = await invoiceHash({ invoice, lines, seller, buyer, qr: "A" });
    const h2 = await invoiceHash({ invoice, lines, seller, buyer, qr: "B" });
    expect(h1).toBe(h2);
    expect(h1).toBe(await sha256Base64(buildInvoiceXml({ invoice, lines, seller, buyer }, { forHash: true })));
    expect(Buffer.from(h1, "base64")).toHaveLength(32);
  });

  it("hash changes when any invoice data changes (chain integrity)", async () => {
    const h1 = await invoiceHash({ invoice, lines, seller, buyer });
    const h2 = await invoiceHash({ invoice: { ...invoice, total: 1150.01 }, lines, seller, buyer });
    const h3 = await invoiceHash({ invoice: { ...invoice, zatca_pih: "other" }, lines, seller, buyer });
    expect(new Set([h1, h2, h3]).size).toBe(3);
  });

  it("processInvoice returns hash, QR and final XML containing the QR", async () => {
    const r = await processInvoice({ invoice, lines, seller, buyer });
    expect(decodeQr(r.qr)[4]).toBe("1150.00");
    expect(r.xml).toContain(r.qr);
    expect(r.hash).toBe(await invoiceHash({ invoice, lines, seller, buyer }));
  });

  it("refuses to process a draft or when the seller VAT is missing", async () => {
    await expect(processInvoice({ invoice: { ...invoice, number: null }, lines, seller, buyer })).rejects.toThrow(/issued/);
    await expect(processInvoice({ invoice, lines, seller: { ...seller, vat_number: null }, buyer })).rejects.toThrow(/VAT/);
  });
});
