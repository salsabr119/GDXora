// ZATCA e-invoice — UBL 2.1 XML builder + invoice hash.
//
// The XML is emitted directly in canonical form (C14N: no XML declaration,
// explicit end tags, namespaces on the root in sorted order, no whitespace
// between elements). That lets us hash exactly what ZATCA hashes:
//   hash = base64( sha256( invoice XML without ext:UBLExtensions,
//                          cac:Signature and the QR AdditionalDocumentReference ) )
// Phase 1 (generation) uses the XML + QR tags 1–5. Phase 2 (integration) adds
// the XAdES signature and CSID certificate — see docs/ZATCA.md. Validate
// output with the ZATCA SDK (fatoora -validate) before production onboarding.

const NS = {
  "": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};

export const DOC_TYPE_CODE = { invoice: "388", credit_note: "381", debit_note: "383" };
export const KIND_CODE = { standard: "0100000", simplified: "0200000" };
export const PAYMENT_MEANS = { cash: "10", bank_transfer: "42", cheque: "20", card: "48", credit: "30" };

const escText = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const escAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  .replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");

// element: el("cbc:ID", {schemeID:"CRN"}, "123") — children may be strings (already XML) or arrays
function el(name, attrs, ...children) {
  let a = "";
  if (attrs) {
    for (const k of Object.keys(attrs).sort()) {
      if (attrs[k] !== undefined && attrs[k] !== null) a += ` ${k}="${escAttr(attrs[k])}"`;
    }
  }
  const body = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).join("");
  return `<${name}${a}>${body}</${name}>`;
}
// text element (escaped); omitted entirely when the value is empty
function t(name, value, attrs) {
  if (value === undefined || value === null || value === "") return "";
  return el(name, attrs, escText(value));
}
const amt = (n) => Number(n || 0).toFixed(2);
const cur = (c) => ({ currencyID: c || "SAR" });

function address(p) {
  return el("cac:PostalAddress", null,
    t("cbc:StreetName", p.street),
    t("cbc:BuildingNumber", p.building_no),
    t("cbc:CitySubdivisionName", p.district),
    t("cbc:CityName", p.city),
    t("cbc:PostalZone", p.postal_code),
    el("cac:Country", null, t("cbc:IdentificationCode", p.country || "SA")));
}

function party(tag, p, { isSeller }) {
  if (!p) return el(tag, null, el("cac:Party", null, ""));
  const idScheme = isSeller ? "CRN" : (p.vat_number ? null : p.cr_number ? "CRN" : p.national_id ? "NAT" : null);
  const idValue = isSeller ? p.cr_number : (p.vat_number ? null : p.cr_number || p.national_id);
  return el(tag, null, el("cac:Party", null,
    idScheme && idValue ? el("cac:PartyIdentification", null, t("cbc:ID", idValue, { schemeID: idScheme })) : "",
    address(p),
    p.vat_number ? el("cac:PartyTaxScheme", null, t("cbc:CompanyID", p.vat_number),
                      el("cac:TaxScheme", null, t("cbc:ID", "VAT"))) : "",
    el("cac:PartyLegalEntity", null, t("cbc:RegistrationName", p.legal_name || p.name_ar))));
}

function taxCategory(tag, cat, rate, exemptionCode, exemptionReason) {
  return el(tag, null,
    t("cbc:ID", cat),
    t("cbc:Percent", Number(rate).toFixed(2)),
    cat !== "S" ? t("cbc:TaxExemptionReasonCode", exemptionCode) : "",
    cat !== "S" ? t("cbc:TaxExemptionReason", exemptionReason) : "",
    el("cac:TaxScheme", null, t("cbc:ID", "VAT")));
}

/**
 * Build the invoice XML.
 * @param {object} d
 *   d.invoice  – invoices row (number, zatca_uuid, issue_date, issue_time, supply_date,
 *                invoice_kind, doc_type, currency, reason, subtotal, advance_deduction,
 *                taxable_amount, vat_amount, total, retention_amount, zatca_icv, zatca_pih, notes)
 *   d.lines    – invoice_lines rows (description, quantity, unit_price, discount, unit,
 *                tax_category, tax_rate, line_net, line_vat, line_total, exemption_code?, exemption_reason?)
 *   d.seller   – organizations row
 *   d.buyer    – customers row or null (simplified)
 *   d.refNumber – original invoice number for credit/debit notes
 *   d.qr       – Base64 QR payload (omit when building the hash input)
 *   d.paymentMeans – key of PAYMENT_MEANS (default credit)
 */
export function buildInvoiceXml(d, { forHash = false } = {}) {
  const inv = d.invoice;
  const c = inv.currency || "SAR";
  const lines = d.lines || [];

  // tax subtotals by category/rate; the advance recovery allowance reduces the standard-rated base
  const groups = new Map();
  for (const l of lines) {
    const k = `${l.tax_category}|${Number(l.tax_rate).toFixed(2)}`;
    const g = groups.get(k) || { cat: l.tax_category, rate: Number(l.tax_rate), taxable: 0, vat: 0,
                                 code: l.exemption_code, reason: l.exemption_reason };
    g.taxable += Number(l.line_net); g.vat += Number(l.line_vat);
    groups.set(k, g);
  }
  const adv = Number(inv.advance_deduction || 0);
  if (adv > 0) {
    const std = [...groups.values()].filter((g) => g.cat === "S").sort((a, b) => b.rate - a.rate)[0];
    if (std) {
      std.taxable -= adv;
      std.vat -= Math.round(adv * std.rate) / 100;
    }
  }
  // the header VAT is authoritative (it is what was booked); absorb per-line rounding into the largest group
  const sumVat = [...groups.values()].reduce((n, g) => n + g.vat, 0);
  const diff = Math.round((Number(inv.vat_amount) - sumVat) * 100) / 100;
  if (diff !== 0 && groups.size) {
    const big = [...groups.values()].sort((a, b) => b.taxable - a.taxable)[0];
    big.vat += diff;
  }
  const stdRate = [...groups.values()].find((g) => g.cat === "S")?.rate ?? 15;

  const notes = [
    inv.notes,
    Number(inv.retention_amount) > 0 ? `محتجزات ضمان: ${amt(inv.retention_amount)} ${c} — صافي المستحق ${amt(Number(inv.total) - Number(inv.retention_amount))} ${c}` : null,
  ].filter(Boolean);

  const root = {
    xmlns: NS[""], "xmlns:cac": NS.cac, "xmlns:cbc": NS.cbc, "xmlns:ext": NS.ext,
  };
  // attributes are sorted by el(); xmlns < xmlns:cac < xmlns:cbc < xmlns:ext — already C14N order

  return el("Invoice", root,
    t("cbc:ProfileID", "reporting:1.0"),
    t("cbc:ID", inv.number),
    t("cbc:UUID", inv.zatca_uuid),
    t("cbc:IssueDate", inv.issue_date),
    t("cbc:IssueTime", String(inv.issue_time || "").slice(0, 8)),
    t("cbc:InvoiceTypeCode", DOC_TYPE_CODE[inv.doc_type || "invoice"], { name: KIND_CODE[inv.invoice_kind || "standard"] }),
    notes.map((n) => t("cbc:Note", n, { languageID: "ar" })),
    t("cbc:DocumentCurrencyCode", c),
    t("cbc:TaxCurrencyCode", "SAR"),
    inv.doc_type && inv.doc_type !== "invoice" && d.refNumber
      ? el("cac:BillingReference", null, el("cac:InvoiceDocumentReference", null, t("cbc:ID", d.refNumber)))
      : "",
    el("cac:AdditionalDocumentReference", null, t("cbc:ID", "ICV"), t("cbc:UUID", inv.zatca_icv)),
    el("cac:AdditionalDocumentReference", null, t("cbc:ID", "PIH"),
      el("cac:Attachment", null, t("cbc:EmbeddedDocumentBinaryObject", inv.zatca_pih, { mimeCode: "text/plain" }))),
    !forHash && d.qr
      ? el("cac:AdditionalDocumentReference", null, t("cbc:ID", "QR"),
          el("cac:Attachment", null, t("cbc:EmbeddedDocumentBinaryObject", d.qr, { mimeCode: "text/plain" })))
      : "",
    party("cac:AccountingSupplierParty", d.seller, { isSeller: true }),
    party("cac:AccountingCustomerParty", d.buyer, { isSeller: false }),
    el("cac:Delivery", null, t("cbc:ActualDeliveryDate", inv.supply_date || inv.issue_date)),
    el("cac:PaymentMeans", null,
      t("cbc:PaymentMeansCode", PAYMENT_MEANS[d.paymentMeans || "credit"]),
      inv.doc_type && inv.doc_type !== "invoice" ? t("cbc:InstructionNote", inv.reason) : ""),
    adv > 0
      ? el("cac:AllowanceCharge", null,
          t("cbc:ChargeIndicator", "false"),
          t("cbc:AllowanceChargeReason", "استرداد دفعة مقدمة"),
          t("cbc:Amount", amt(adv), cur(c)),
          taxCategory("cac:TaxCategory", "S", stdRate))
      : "",
    el("cac:TaxTotal", null, t("cbc:TaxAmount", amt(inv.vat_amount), cur("SAR"))),
    el("cac:TaxTotal", null,
      t("cbc:TaxAmount", amt(inv.vat_amount), cur(c)),
      [...groups.values()].map((g) => el("cac:TaxSubtotal", null,
        t("cbc:TaxableAmount", amt(g.taxable), cur(c)),
        t("cbc:TaxAmount", amt(g.vat), cur(c)),
        taxCategory("cac:TaxCategory", g.cat, g.rate, g.code, g.reason)))),
    el("cac:LegalMonetaryTotal", null,
      t("cbc:LineExtensionAmount", amt(inv.subtotal), cur(c)),
      t("cbc:TaxExclusiveAmount", amt(inv.taxable_amount), cur(c)),
      t("cbc:TaxInclusiveAmount", amt(inv.total), cur(c)),
      t("cbc:AllowanceTotalAmount", amt(adv), cur(c)),
      t("cbc:PrepaidAmount", amt(0), cur(c)),
      t("cbc:PayableAmount", amt(inv.total), cur(c))),
    lines.map((l, i) => el("cac:InvoiceLine", null,
      t("cbc:ID", i + 1),
      t("cbc:InvoicedQuantity", Number(l.quantity).toFixed(3).replace(/\.?0+$/, "") || "0", { unitCode: "PCE" }),
      t("cbc:LineExtensionAmount", amt(l.line_net), cur(c)),
      Number(l.discount) > 0
        ? el("cac:AllowanceCharge", null,
            t("cbc:ChargeIndicator", "false"),
            t("cbc:AllowanceChargeReason", "خصم"),
            t("cbc:Amount", amt(l.discount), cur(c)))
        : "",
      el("cac:TaxTotal", null,
        t("cbc:TaxAmount", amt(l.line_vat), cur(c)),
        t("cbc:RoundingAmount", amt(l.line_total), cur(c))),
      el("cac:Item", null,
        t("cbc:Name", l.description),
        taxCategory("cac:ClassifiedTaxCategory", l.tax_category, l.tax_rate)),
      el("cac:Price", null, t("cbc:PriceAmount", amt(l.unit_price), cur(c))))));
}

/** base64( SHA-256( bytes ) ) using WebCrypto (browser and Node ≥ 18). */
export async function sha256Base64(text) {
  const data = new TextEncoder().encode(text);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  if (typeof Buffer !== "undefined") return Buffer.from(digest).toString("base64");
  let s = ""; digest.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

/** ZATCA invoice hash of the invoice (computed over the hash-input form of the XML). */
export async function invoiceHash(d) {
  return sha256Base64(buildInvoiceXml(d, { forHash: true }));
}
