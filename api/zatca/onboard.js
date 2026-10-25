// POST /api/zatca/onboard { environment, otp, unit_name, industry? }
// Onboards the company's e-invoice generation solution unit (EGS) with ZATCA:
//   key + CSR → compliance CSID (with the OTP from the Fatoora portal) →
//   compliance checks (six signed sample documents) → production CSID.
// Requires settings.manage. Secrets are stored encrypted in zatca_egs.
import crypto from "node:crypto";
import { send, readJson, requireMember, HttpError } from "../_lib.js";
import { seal, zatcaCall, messagesOf } from "../_zatca.js";
import { generateKeyAndCsr, signInvoice, certificateInfo } from "../../src/lib/zatca/sign.js";

const INITIAL_PIH = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
const SAMPLES = [["standard", "invoice"], ["standard", "credit_note"], ["standard", "debit_note"],
                 ["simplified", "invoice"], ["simplified", "credit_note"], ["simplified", "debit_note"]];

function checkOrg(org) {
  const out = [];
  if (!/^3\d{13}3$/.test(org.vat_number || "")) out.push("company VAT number (15 digits starting and ending with 3)");
  if (!/^\d{4}$/.test(org.building_no || "")) out.push("building number (4 digits)");
  if (!/^\d{5}$/.test(org.postal_code || "")) out.push("postal code (5 digits)");
  for (const k of ["street", "district", "city"]) if (!String(org[k] || "").trim()) out.push(k);
  if (!String(org.legal_name || org.name_ar || "").trim()) out.push("legal name");
  return out;
}

export default async function handler(req, res) {
  let admin, orgId, egsId;
  try {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const member = await requireMember(req, "settings.manage");
    ({ admin, orgId } = member);
    const { user } = member;
    const body = await readJson(req);
    const environment = ["sandbox", "simulation", "production"].includes(body.environment) ? body.environment : null;
    const otp = String(body.otp || "").trim();
    if (!environment) throw new HttpError(400, "environment is required");
    if (!/^\d{6}$/.test(otp)) throw new HttpError(400, "the OTP is 6 digits");
    const { data: org } = await admin.from("organizations").select("*").eq("id", orgId).single();
    const missing = checkOrg(org);
    if (missing.length) throw new HttpError(400, `complete the company details first: ${missing.join(", ")}`);

    const serial = crypto.randomUUID();
    const unitName = String(body.unit_name || "").trim() || "الفرع الرئيسي";
    const egsName = `GDXora-${serial.slice(0, 8)}`;
    const keys = generateKeyAndCsr({
      environment, vatNumber: org.vat_number, orgName: org.legal_name || org.name_ar, unitName, egsName, serial,
      address: [org.building_no, org.street, org.district, org.city].filter(Boolean).join(" "),
      industry: String(body.industry || "").trim() || "خدمات",
    });
    const { data: egs, error: insErr } = await admin.from("zatca_egs").insert({
      org_id: orgId, environment, status: "pending", egs_serial: serial, unit_name: unitName, egs_name: egsName,
      private_key_enc: seal(keys.privateKeyPem), csr: keys.csrPem, created_by: user.id }).select("id").single();
    if (insErr) throw new HttpError(500, insErr.message);
    egsId = egs.id;

    // 1. compliance CSID
    const c = await zatcaCall(environment, "/compliance", { otp, body: { csr: keys.csrBase64 } });
    if (c.status !== 200 || !c.json?.binarySecurityToken) {
      const why = c.json?.errors ? JSON.stringify(c.json.errors) : c.json?.message || c.json?.error || `HTTP ${c.status}`;
      throw new HttpError(400, `ZATCA did not issue the compliance certificate (check the OTP — it is valid for one hour): ${why}`);
    }
    const compliance = { token: c.json.binarySecurityToken, secret: c.json.secret };
    await admin.from("zatca_egs").update({ compliance_request_id: String(c.json.requestID), compliance_cert: compliance.token,
                                           compliance_secret_enc: seal(compliance.secret) }).eq("id", egsId);

    // 2. compliance checks: six signed sample documents
    const cert = Buffer.from(compliance.token, "base64").toString();
    const buyer = { name_ar: "عميل اختبار الامتثال", vat_number: "300000000000003", street: "طريق الملك فهد", building_no: "1111",
                    district: "العليا", city: "الرياض", postal_code: "12211", country: "SA" };
    const line = { description: "اختبار الامتثال", quantity: 1, unit_price: 100, discount: 0, tax_category: "S", tax_rate: 15,
                   line_net: 100, line_vat: 15, line_total: 115 };
    const now = new Date(Date.now() + 3 * 3600e3).toISOString();   // KSA time
    let pih = INITIAL_PIH; const checks = [];
    for (const [i, [kind, doc]] of SAMPLES.entries()) {
      const invoice = { number: `COMPLIANCE-${i + 1}`, zatca_uuid: crypto.randomUUID(), issue_date: now.slice(0, 10), issue_time: now.slice(11, 19),
        invoice_kind: kind, doc_type: doc, reason: doc === "invoice" ? null : "تعديل", subtotal: 100, taxable_amount: 100,
        vat_amount: 15, total: 115, zatca_icv: i + 1, zatca_pih: pih };
      const s = signInvoice({ invoice, lines: [line], seller: org, buyer: kind === "standard" ? buyer : null,
                              refNumber: doc === "invoice" ? null : "COMPLIANCE-1", paymentMeans: "bank_transfer" },
                            { privateKeyPem: keys.privateKeyPem, certificate: cert });
      const r = await zatcaCall(environment, "/compliance/invoices", { auth: compliance,
        body: { invoiceHash: s.hash, uuid: invoice.zatca_uuid, invoice: Buffer.from(s.xml).toString("base64") } });
      const v = r.json?.validationResults?.status;
      checks.push({ kind, doc, http: r.status, status: v || "ERROR", messages: messagesOf(r.json) });
      pih = s.hash;
    }
    await admin.from("zatca_egs").update({ checks }).eq("id", egsId);
    const failed = checks.filter((x) => x.status !== "PASS" && x.status !== "WARNING");
    if (failed.length) {
      throw new HttpError(400, `compliance checks failed: ${failed.map((f) => `${f.kind}/${f.doc}: ${f.messages.map((m) => m.code).join(", ") || `HTTP ${f.http}`}`).join(" · ")}`);
    }

    // 3. production CSID
    const p = await zatcaCall(environment, "/production/csids", { auth: compliance, body: { compliance_request_id: String(c.json.requestID) } });
    if (p.status !== 200 || !p.json?.binarySecurityToken) {
      throw new HttpError(400, `ZATCA did not issue the production certificate: ${p.json?.errors ? JSON.stringify(p.json.errors) : `HTTP ${p.status}`}`);
    }
    const info = certificateInfo(Buffer.from(p.json.binarySecurityToken, "base64").toString());
    await admin.from("zatca_egs").update({ status: "replaced" }).eq("org_id", orgId).eq("status", "active");
    await admin.from("zatca_egs").update({ status: "active", production_cert: p.json.binarySecurityToken,
      production_secret_enc: seal(p.json.secret), cert_expires_at: info.validTo, activated_at: new Date().toISOString(), error: null }).eq("id", egsId);
    // a new EGS starts its own hash chain: the next invoice's PIH is the initial value
    await admin.from("zatca_state").update({ environment, csid_certificate: p.json.binarySecurityToken, csid_expires_at: info.validTo,
                                             last_hash: INITIAL_PIH }).eq("org_id", orgId);
    send(res, 200, { ok: true, environment, egs_name: egsName, cert_expires_at: info.validTo, checks });
  } catch (e) {
    if (egsId && admin) await admin.from("zatca_egs").update({ status: "failed", error: String(e.message || e).slice(0, 1000) }).eq("id", egsId);
    send(res, e.status || 500, { error: e.status ? e.message : "server error" });
  }
}
