// End-to-end check of our ZATCA phase-2 signing against ZATCA's developer
// portal (sandbox): CSR → compliance CSID → the six compliance documents →
// production CSID → report a simplified invoice and clear a standard one.
//   node scripts/zatca-sandbox-check.mjs        (needs internet access, no secrets)
import crypto from "node:crypto";
import { generateKeyAndCsr, signInvoice } from "../src/lib/zatca/sign.js";

const B = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const PIH0 = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
const seller = { legal_name: "شركة جي دي اكسورا للاختبار", vat_number: "399999999900003", cr_number: "1010010000", street: "الأمير سلطان",
  building_no: "2322", district: "المربع", city: "الرياض", postal_code: "23333", country: "SA" };
const buyer = { name_ar: "شركة العميل", vat_number: "300000000000003", street: "صلاح الدين", building_no: "1111", district: "المروج",
  city: "الرياض", postal_code: "12222", country: "SA" };
const line = { description: "خدمة استشارية", quantity: 2, unit_price: 500, discount: 0, tax_category: "S", tax_rate: 15, line_net: 1000, line_vat: 150, line_total: 1150 };

async function call(path, { body, otp, auth, clearance }) {
  const headers = { "Accept-Version": "V2", "Accept-Language": "en", "Content-Type": "application/json" };
  if (otp) headers.OTP = otp;
  if (auth) headers.Authorization = "Basic " + Buffer.from(`${auth.token}:${auth.secret}`).toString("base64");
  if (clearance !== undefined) headers["Clearance-Status"] = clearance ? "1" : "0";
  const r = await fetch(B + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const msgs = (j) => [...(j.validationResults?.errorMessages || []), ...(j.validationResults?.warningMessages || [])].map((m) => `${m.type}:${m.code}`).join(", ");
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) failures += 1; };

const keys = generateKeyAndCsr({ environment: "sandbox", vatNumber: seller.vat_number, orgName: seller.legal_name, unitName: "الفرع الرئيسي",
  egsName: "GDXora-check", serial: crypto.randomUUID(), address: "2322 الأمير سلطان الرياض", industry: "خدمات" });
const c = await call("/compliance", { otp: "123345", body: { csr: keys.csrBase64 } });
check(c.status === 200 && c.json.binarySecurityToken, `compliance CSID (HTTP ${c.status})`);
const compliance = { token: c.json.binarySecurityToken, secret: c.json.secret };

const doc = (i, kind, type, cert, pih) => {
  const invoice = { number: `CHK-${i}`, zatca_uuid: crypto.randomUUID(), issue_date: "2026-10-25", issue_time: "09:30:00", invoice_kind: kind, doc_type: type,
    reason: type === "invoice" ? null : "تعديل", subtotal: 1000, taxable_amount: 1000, vat_amount: 150, total: 1150, zatca_icv: i, zatca_pih: pih };
  const s = signInvoice({ invoice, lines: [line], seller, buyer: kind === "standard" ? buyer : null, refNumber: type === "invoice" ? null : "CHK-1", paymentMeans: "bank_transfer" },
                        { privateKeyPem: keys.privateKeyPem, certificate: cert });
  return { s, body: { invoiceHash: s.hash, uuid: invoice.zatca_uuid, invoice: Buffer.from(s.xml).toString("base64") } };
};
let pih = PIH0; let i = 0;
for (const [kind, type] of [["standard", "invoice"], ["standard", "credit_note"], ["standard", "debit_note"], ["simplified", "invoice"], ["simplified", "credit_note"], ["simplified", "debit_note"]]) {
  const { s, body } = doc(++i, kind, type, Buffer.from(compliance.token, "base64").toString(), pih);
  const r = await call("/compliance/invoices", { auth: compliance, body });
  check(r.json.validationResults?.status === "PASS", `compliance ${kind}/${type}: ${r.json.validationResults?.status} ${msgs(r.json)}`);
  pih = s.hash;
}
const p = await call("/production/csids", { auth: compliance, body: { compliance_request_id: String(c.json.requestID) } });
check(p.status === 200 && p.json.binarySecurityToken, `production CSID (HTTP ${p.status})`);
const prod = { token: p.json.binarySecurityToken, secret: p.json.secret };
const pcert = Buffer.from(prod.token, "base64").toString();
const rep = doc(7, "simplified", "invoice", pcert, PIH0);
let r = await call("/invoices/reporting/single", { auth: prod, clearance: false, body: rep.body });
check(r.json.reportingStatus === "REPORTED", `reporting: ${r.json.reportingStatus} ${msgs(r.json)}`);
const clr = doc(8, "standard", "invoice", pcert, rep.s.hash);
r = await call("/invoices/clearance/single", { auth: prod, clearance: true, body: clr.body });
check(r.json.clearanceStatus === "CLEARED" && r.json.clearedInvoice, `clearance: ${r.json.clearanceStatus} ${msgs(r.json)}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall ZATCA sandbox checks passed");
process.exit(failures ? 1 : 0);
