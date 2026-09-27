// ZATCA processing for an issued invoice: XML → hash → QR → final XML.
// Called right after issue_invoice(); the result is stored with zatca_attach()
// which also advances the PIH chain for the next invoice.
import { buildInvoiceXml, invoiceHash } from "./ubl.js";
import { encodeQr } from "./tlv.js";

export { encodeQr, decodeQr } from "./tlv.js";
export { buildInvoiceXml, invoiceHash, sha256Base64 } from "./ubl.js";

/** "2026-09-27" + "10:15:00" → "2026-09-27T10:15:00" (KSA local time, as issued) */
export function qrTimestamp(date, time) {
  return `${date}T${String(time || "00:00:00").slice(0, 8)}`;
}

/**
 * @param {object} d  see buildInvoiceXml()
 * @returns {Promise<{hash:string, qr:string, xml:string}>}
 */
export async function processInvoice(d) {
  const inv = d.invoice;
  if (!inv.number || !inv.zatca_icv || !inv.zatca_pih) {
    throw new Error("invoice must be issued (number, ICV and PIH assigned) before ZATCA processing");
  }
  if (!d.seller?.vat_number) throw new Error("seller VAT number is not configured (company settings)");
  const hash = await invoiceHash(d);
  const qr = encodeQr({
    sellerName: d.seller.legal_name || d.seller.name_ar,
    vatNumber: d.seller.vat_number,
    timestamp: qrTimestamp(inv.issue_date, inv.issue_time),
    total: inv.total,
    vatTotal: inv.vat_amount,
  });
  const xml = buildInvoiceXml({ ...d, qr });
  return { hash, qr, xml };
}
