// ZATCA phase 2 — server helpers: secret encryption, the Fatoora API, and the
// sign → attach → clear / report flow shared by api/zatca/* and the cron job.
import crypto from "node:crypto";
import { serviceClient, HttpError } from "./_lib.js";
import { signInvoice } from "../src/lib/zatca/sign.js";

export const ZATCA_BASE = {
  sandbox: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  production: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

/* ── secrets at rest: AES-256-GCM ───────────────────────────────────────
   Key: ZATCA_ENCRYPTION_KEY (32 bytes, base64) — set it before production.
   Fallback: derived (HKDF) from the service-role key, which never leaves the
   server either; rotating that key then requires re-onboarding. */
function encKey() {
  const k = process.env.ZATCA_ENCRYPTION_KEY;
  if (k) {
    const b = Buffer.from(k, "base64");
    if (b.length !== 32) throw new HttpError(500, "ZATCA_ENCRYPTION_KEY must be 32 bytes, base64");
    return b;
  }
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!base) throw new HttpError(500, "server is not configured for ZATCA secrets");
  return Buffer.from(crypto.hkdfSync("sha256", base, "gdxora-zatca", "egs-secrets", 32));
}
export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const body = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}
export function unseal(sealed) {
  const [v, iv, tag, body] = String(sealed || "").split(".");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

/* ── Fatoora API ───────────────────────────────────────────────────────── */
export async function zatcaCall(env, path, { body, otp, auth, clearance } = {}) {
  const headers = { "Accept-Version": "V2", "Accept-Language": "en", "Content-Type": "application/json", Accept: "application/json" };
  if (otp) headers.OTP = otp;
  if (auth) headers.Authorization = "Basic " + Buffer.from(`${auth.token}:${auth.secret}`).toString("base64");
  if (clearance !== undefined) headers["Clearance-Status"] = clearance ? "1" : "0";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(ZATCA_BASE[env] + path, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: { error: e.name === "AbortError" ? "timeout" : String(e.message || e) } };
  } finally { clearTimeout(timer); }
}
/** validation messages of a ZATCA response → [{ type, code, message }] */
export const messagesOf = (j) => [...(j?.validationResults?.errorMessages || []), ...(j?.validationResults?.warningMessages || [])]
  .map((m) => ({ type: m.type, code: m.code, message: m.message }));

/* ── invoice data for signing (same shape as the browser's phase-1 flow) ── */
export async function loadInvoiceData(db, orgId, invoiceId) {
  const one = async (q) => { const { data, error } = await q; if (error) throw new HttpError(400, error.message); return data; };
  const inv = await one(db.from("invoices").select("*").eq("id", invoiceId).eq("org_id", orgId).maybeSingle());
  if (!inv) throw new HttpError(404, "invoice not found");
  const lines = await one(db.from("invoice_lines").select("*, tax_codes(exemption_code, exemption_reason)").eq("invoice_id", invoiceId).order("line_no"));
  const seller = await one(db.from("organizations").select("*").eq("id", orgId).single());
  const buyer = inv.customer_id ? await one(db.from("customers").select("*").eq("id", inv.customer_id).single()) : null;
  const ref = inv.ref_invoice_id ? await one(db.from("invoices").select("number").eq("id", inv.ref_invoice_id).single()) : null;
  return { invoice: inv, seller, buyer, refNumber: ref?.number,
           lines: lines.map((l) => ({ ...l, exemption_code: l.tax_codes?.exemption_code, exemption_reason: l.tax_codes?.exemption_reason })) };
}

export async function activeEgs(admin, orgId) {
  const { data } = await admin.from("zatca_egs").select("*").eq("org_id", orgId).eq("status", "active").maybeSingle();
  return data || null;
}

/**
 * Sign (if not yet), then clear (standard) or report (simplified) an issued invoice.
 * @returns {{ phase: 1 } | { phase: 2, status, messages, retry }}
 */
export async function submitInvoice(orgId, invoiceId) {
  const admin = serviceClient();
  const egs = await activeEgs(admin, orgId);
  if (!egs) return { phase: 1 };
  const db = serviceClient(orgId);                  // service context with the company → same DB rules as the app
  const d = await loadInvoiceData(admin, orgId, invoiceId);
  let inv = d.invoice;
  if (inv.status !== "issued") throw new HttpError(400, "invoice is not issued");
  if (["cleared", "reported"].includes(inv.zatca_status)) return { phase: 2, status: inv.zatca_status, messages: [], retry: false };
  // issued before the company was onboarded: phase-1 XML (unsigned) — not sent to ZATCA
  if (inv.zatca_hash && !String(inv.zatca_xml || "").includes("<ext:UBLExtensions>")) return { phase: 1, legacy: true };

  const cert = Buffer.from(egs.production_cert, "base64").toString();
  if (!inv.zatca_hash) {
    const s = signInvoice(d, { privateKeyPem: unseal(egs.private_key_enc), certificate: cert });
    const { error } = await db.rpc("zatca_attach", { p_invoice: inv.id, p_hash: s.hash, p_qr: s.qr, p_xml: s.xml });
    if (error) throw new HttpError(409, error.message);
    inv = { ...inv, zatca_hash: s.hash, zatca_qr: s.qr, zatca_xml: s.xml };
  }

  const standard = inv.invoice_kind === "standard";
  const r = await zatcaCall(egs.environment, standard ? "/invoices/clearance/single" : "/invoices/reporting/single", {
    auth: { token: egs.production_cert, secret: unseal(egs.production_secret_enc) }, clearance: standard,
    body: { invoiceHash: inv.zatca_hash, uuid: inv.zatca_uuid, invoice: Buffer.from(inv.zatca_xml).toString("base64") },
  });
  const messages = messagesOf(r.json);
  let status = "not_submitted"; let xml = null; let qr = null; let retry = false;
  const accepted = (r.json?.clearanceStatus === "CLEARED" || r.json?.reportingStatus === "REPORTED");
  if ((r.status === 200 || r.status === 202) && accepted) {
    status = messages.some((m) => m.type === "WARNING") ? "warning" : standard ? "cleared" : "reported";
    if (standard && r.json.clearedInvoice) {
      xml = Buffer.from(r.json.clearedInvoice, "base64").toString("utf8");
      qr = xml.match(/<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</)?.[1] || null;
    }
  } else if (r.status === 400 || (r.status === 200 && !accepted)) {
    status = "rejected";
  } else {
    retry = true;                                  // network / auth / ZATCA down: keep not_submitted, retry later
  }
  const response = { http: r.status, at: new Date().toISOString(), environment: egs.environment, messages,
                     clearanceStatus: r.json?.clearanceStatus, reportingStatus: r.json?.reportingStatus, error: r.json?.error };
  const { error } = await db.rpc("zatca_set_result", { p_invoice: inv.id, p_status: status, p_response: response, p_xml: xml, p_qr: qr });
  if (error) throw new HttpError(409, error.message);
  return { phase: 2, status, messages, retry, http: r.status };
}
