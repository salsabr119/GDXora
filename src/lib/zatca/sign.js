// ZATCA phase 2 (integration) — server side only (node:crypto, private keys).
//
//  • generateKeyAndCsr(): secp256k1 key + CSR carrying the fields ZATCA requires
//  • signInvoice(): XAdES-BES enveloped signature in ext:UBLExtensions, the
//    cac:Signature marker and the phase-2 QR (tags 1–9)
//
// Hash conventions (ZATCA): the invoice hash and the signature are over the
// raw SHA-256 of the canonical invoice (without UBLExtensions, cac:Signature
// and the QR reference); the certificate and SignedProperties digests are
// base64 of the *hex* SHA-256 string. Our XML is emitted in canonical form, so
// the hashed text is exactly what ZATCA recomputes.
import crypto from "node:crypto";
import rs from "jsrsasign";
import { buildInvoiceXml } from "./ubl.js";
import { encodeQr } from "./tlv.js";

const { KJUR, KEYUTIL, X509 } = rs;
const NS_DS = "http://www.w3.org/2000/09/xmldsig#";
const NS_XADES = "http://uri.etsi.org/01903/v1.3.2#";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const C14N11 = "http://www.w3.org/2006/12/xml-c14n11";
const XPATH = "http://www.w3.org/TR/1999/REC-xpath-19991116";

export const TEMPLATE_NAME = { sandbox: "TSTZATCA-Code-Signing", simulation: "PREZATCA-Code-Signing", production: "ZATCA-Code-Signing" };

const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const b64hex = (data) => Buffer.from(sha256(data).toString("hex")).toString("base64");

/**
 * @param {object} p { environment, vatNumber, orgName, unitName (OU), egsName (CN), serial,
 *                     invoiceTypes ("1100" standard+simplified), address, industry }
 * @returns {{ privateKeyPem, csrPem, csrBase64 }}
 */
export function generateKeyAndCsr(p) {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = KEYUTIL.getKey(kp.publicKey.export({ type: "spki", format: "pem" }));
  const prv = KEYUTIL.getKey(privateKeyPem);
  const csr = new KJUR.asn1.csr.CertificationRequest({
    subject: { array: [[{ type: "C", value: "SA" }], [{ type: "OU", value: p.unitName }], [{ type: "O", value: p.orgName }], [{ type: "CN", value: p.egsName }]] },
    sbjpubkey: pub, sigalg: "SHA256withECDSA", sbjprvkey: prv,
    extreq: [
      { extname: "1.3.6.1.4.1.311.20.2", extn: new KJUR.asn1.DERPrintableString({ str: TEMPLATE_NAME[p.environment] || TEMPLATE_NAME.sandbox }).tohex() },
      { extname: "subjectAltName", array: [{ dn: { array: [
        [{ type: "2.5.4.4", value: `1-GDXora|2-1.0|3-${p.serial}` }],      // SN: solution | model | serial
        [{ type: "0.9.2342.19200300.100.1.1", value: p.vatNumber }],       // UID: VAT number
        [{ type: "2.5.4.12", value: p.invoiceTypes || "1100" }],           // title: invoice types (standard, simplified)
        [{ type: "2.5.4.26", value: p.address }],                          // registeredAddress
        [{ type: "2.5.4.15", value: p.industry }],                         // businessCategory
      ] } }] },
    ],
  });
  const csrPem = csr.getPEM();
  return { privateKeyPem, csrPem, csrBase64: Buffer.from(csrPem).toString("base64") };
}

/** facts needed from the CSID certificate (base64 DER, as ZATCA returns it inside binarySecurityToken) */
export function certificateInfo(certB64) {
  const der = Buffer.from(certB64, "base64");
  const x = new crypto.X509Certificate(der);
  const j = new X509(); j.readCertHex(der.toString("hex"));
  return {
    issuer: x.issuer.split("\n").reverse().join(", "),                      // RFC 2253 order: CN=…, DC=…
    serial: BigInt(`0x${x.serialNumber}`).toString(10),
    publicKeyDer: new Uint8Array(x.publicKey.export({ type: "spki", format: "der" })),
    signature: new Uint8Array(Buffer.from(j.getSignatureValueHex(), "hex")),
    validTo: new Date(x.validTo).toISOString(),
  };
}

const el = (name, attrs, body = "") => `<${name}${Object.entries(attrs || {}).map(([k, v]) => ` ${k}="${v}"`).join("")}>${body}</${name}>`;

/** SignedProperties in exclusive-canonical form (each ds:* element declares its namespace) */
function signedProperties({ signingTime, certHash, issuer, serial }, { standalone }) {
  const ds = standalone ? { "xmlns:ds": NS_DS } : {};
  return el("xades:SignedProperties", standalone ? { "xmlns:xades": NS_XADES, Id: "xadesSignedProperties" } : { Id: "xadesSignedProperties" },
    el("xades:SignedSignatureProperties", null,
      el("xades:SigningTime", null, signingTime) +
      el("xades:SigningCertificate", null, el("xades:Cert", null,
        el("xades:CertDigest", null,
          // ZATCA hashes the element as a Java serializer writes it: the empty DigestMethod self-closed
          (standalone ? `<ds:DigestMethod xmlns:ds="${NS_DS}" Algorithm="${SHA256}"/>` : el("ds:DigestMethod", { Algorithm: SHA256 })) +
          el("ds:DigestValue", ds, certHash)) +
        el("xades:IssuerSerial", null,
          el("ds:X509IssuerName", ds, issuer.replace(/&/g, "&amp;").replace(/</g, "&lt;")) + el("ds:X509SerialNumber", ds, serial))))));
}

/**
 * Sign an invoice.
 * @param {object} d   buildInvoiceXml() input (invoice must carry number, ICV, PIH)
 * @param {object} k   { privateKeyPem, certificate (base64 DER), signingTime? }
 * @returns {{ xml, hash, qr, signature }}
 */
export function signInvoice(d, k) {
  const inv = d.invoice;
  const hashInput = buildInvoiceXml(d, { forHash: true });
  const digest = sha256(hashInput);
  const hash = digest.toString("base64");
  const signature = crypto.createSign("sha256").update(digest).sign(k.privateKeyPem).toString("base64");
  const cert = certificateInfo(k.certificate);
  const certHash = b64hex(k.certificate);
  const signingTime = (k.signingTime || new Date().toISOString()).slice(0, 19);
  const props = { signingTime, certHash, issuer: cert.issuer, serial: cert.serial };
  const propsHash = b64hex(signedProperties(props, { standalone: true }));

  const ext = el("ext:UBLExtensions", null, el("ext:UBLExtension", null,
    el("ext:ExtensionURI", null, "urn:oasis:names:specification:ubl:dsig:enveloped:xades") +
    el("ext:ExtensionContent", null, el("sig:UBLDocumentSignatures", {
      "xmlns:sac": "urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2",
      "xmlns:sbc": "urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2",
      "xmlns:sig": "urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" },
      el("sac:SignatureInformation", null,
        el("cbc:ID", null, "urn:oasis:names:specification:ubl:signature:1") +
        el("sbc:ReferencedSignatureID", null, "urn:oasis:names:specification:ubl:signature:Invoice") +
        el("ds:Signature", { "xmlns:ds": NS_DS, Id: "signature" },
          el("ds:SignedInfo", null,
            el("ds:CanonicalizationMethod", { Algorithm: C14N11 }) +
            el("ds:SignatureMethod", { Algorithm: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256" }) +
            el("ds:Reference", { Id: "invoiceSignedData", URI: "" },
              el("ds:Transforms", null,
                el("ds:Transform", { Algorithm: XPATH }, el("ds:XPath", null, "not(//ancestor-or-self::ext:UBLExtensions)")) +
                el("ds:Transform", { Algorithm: XPATH }, el("ds:XPath", null, "not(//ancestor-or-self::cac:Signature)")) +
                el("ds:Transform", { Algorithm: XPATH }, el("ds:XPath", null, "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])")) +
                el("ds:Transform", { Algorithm: C14N11 })) +
              el("ds:DigestMethod", { Algorithm: SHA256 }) + el("ds:DigestValue", null, hash)) +
            el("ds:Reference", { Type: "http://www.w3.org/2000/09/xmldsig#SignatureProperties", URI: "#xadesSignedProperties" },
              el("ds:DigestMethod", { Algorithm: SHA256 }) + el("ds:DigestValue", null, propsHash))) +
          el("ds:SignatureValue", null, signature) +
          el("ds:KeyInfo", null, el("ds:X509Data", null, el("ds:X509Certificate", null, k.certificate))) +
          el("ds:Object", null, el("xades:QualifyingProperties", { "xmlns:xades": NS_XADES, Target: "signature" },
            signedProperties(props, { standalone: false })))))))));

  const qr = encodeQr({
    sellerName: d.seller.legal_name || d.seller.name_ar, vatNumber: d.seller.vat_number,
    timestamp: `${inv.issue_date}T${String(inv.issue_time || "00:00:00").slice(0, 8)}`,
    total: inv.total, vatTotal: inv.vat_amount,
    invoiceHash: hash, signature, publicKey: cert.publicKeyDer,
    certSignature: inv.invoice_kind === "simplified" ? cert.signature : undefined,
  });
  const xml = buildInvoiceXml({ ...d, qr, ublExtensions: ext });
  return { xml, hash, qr, signature };
}
