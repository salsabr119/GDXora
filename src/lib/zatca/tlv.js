// ZATCA QR code payload — TLV (tag · length · value) encoded, then Base64.
//
// Phase 1 (generation) requires tags 1–5. Phase 2 (integration) adds 6–9
// (invoice hash, ECDSA signature, public key, and for simplified invoices the
// certificate signature). Lengths are BYTE lengths of the UTF-8 value — an
// Arabic seller name is longer in bytes than in characters (a classic bug).

export const TAGS = {
  sellerName: 1,
  vatNumber: 2,
  timestamp: 3,      // ISO 8601, e.g. 2026-09-27T10:15:00Z
  total: 4,          // invoice total incl. VAT, 2 decimals
  vatTotal: 5,       // VAT total, 2 decimals
  invoiceHash: 6,
  signature: 7,
  publicKey: 8,
  certSignature: 9,
};

const enc = new TextEncoder();

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  return enc.encode(String(v));
}

// one TLV record; values over 255 bytes use the BER long form (0x81/0x82)
function record(tag, value) {
  const bytes = toBytes(value);
  const len = bytes.length;
  let lenBytes;
  if (len < 0x80) lenBytes = [len];
  else if (len <= 0xff) lenBytes = [0x81, len];
  else if (len <= 0xffff) lenBytes = [0x82, len >> 8, len & 0xff];
  else throw new Error(`TLV value too long for tag ${tag}`);
  const out = new Uint8Array(1 + lenBytes.length + len);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(bytes, 1 + lenBytes.length);
  return out;
}

export function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

export function fromBase64(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Build the QR payload.
 * @param {object} f  { sellerName, vatNumber, timestamp, total, vatTotal,
 *                      invoiceHash?, signature?, publicKey?, certSignature? }
 * @returns {string} Base64 TLV
 */
export function encodeQr(f) {
  for (const k of ["sellerName", "vatNumber", "timestamp", "total", "vatTotal"]) {
    if (f[k] === undefined || f[k] === null || f[k] === "") throw new Error(`QR field "${k}" is required`);
  }
  const parts = [
    record(TAGS.sellerName, f.sellerName),
    record(TAGS.vatNumber, f.vatNumber),
    record(TAGS.timestamp, f.timestamp),
    record(TAGS.total, Number(f.total).toFixed(2)),
    record(TAGS.vatTotal, Number(f.vatTotal).toFixed(2)),
  ];
  if (f.invoiceHash) parts.push(record(TAGS.invoiceHash, f.invoiceHash));
  if (f.signature) parts.push(record(TAGS.signature, f.signature));
  if (f.publicKey) parts.push(record(TAGS.publicKey, f.publicKey));
  if (f.certSignature) parts.push(record(TAGS.certSignature, f.certSignature));

  const size = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return toBase64(all);
}

/** Decode a Base64 TLV payload back to { tag: string } (tags 6–9 stay raw strings). */
export function decodeQr(b64) {
  const bytes = fromBase64(b64);
  const dec = new TextDecoder();
  const out = {};
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    let len = bytes[i++];
    if (len === 0x81) len = bytes[i++];
    else if (len === 0x82) { len = (bytes[i] << 8) | bytes[i + 1]; i += 2; }
    out[tag] = dec.decode(bytes.slice(i, i + len));
    i += len;
  }
  return out;
}
