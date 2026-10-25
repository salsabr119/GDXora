// POST /api/zatca/submit { invoice_id } — sign, then clear (standard) or report
// (simplified) an issued invoice through the company's ZATCA EGS.
// Returns { phase: 1 } when the company is not onboarded (the browser then
// generates the phase-1 XML / QR itself).
import { send, readJson, requireMember } from "../_lib.js";
import { submitInvoice } from "../_zatca.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const { orgId } = await requireMember(req, "sales.issue");
    const { invoice_id } = await readJson(req);
    if (!/^[0-9a-f-]{36}$/i.test(String(invoice_id || ""))) return send(res, 400, { error: "invoice_id is required" });
    send(res, 200, await submitInvoice(orgId, invoice_id));
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : "server error" });
  }
}
