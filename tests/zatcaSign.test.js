import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import rs from "jsrsasign";
import { generateKeyAndCsr, signInvoice, certificateInfo } from "../src/lib/zatca/sign.js";
import { buildInvoiceXml } from "../src/lib/zatca/ubl.js";
import { decodeQr, fromBase64 } from "../src/lib/zatca/tlv.js";

const { KJUR, KEYUTIL } = rs;

// a self-signed certificate for the generated key stands in for a ZATCA CSID
function selfSigned(privateKeyPem) {
  const prv = KEYUTIL.getKey(privateKeyPem);
  const pub = KEYUTIL.getKey(crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }));
  const c = new KJUR.asn1.x509.Certificate({
    version: 3, serial: { hex: "0a1b2c3d" }, issuer: { str: "/CN=eInvoicing" }, subject: { str: "/C=SA/O=Test/CN=EGS" },
    notbefore: "260101000000Z", notafter: "310101000000Z", sbjpubkey: pub, sigalg: "SHA256withECDSA", cakey: prv,
  });
  return Buffer.from(c.getPEM().replace(/-----[^-]+-----|\s/g, ""), "base64").toString("base64");
}

const seller = { legal_name: "شركة الاختبار & الشركاء", vat_number: "399999999900003", cr_number: "1010010000", street: "الأمير سلطان",
  building_no: "2322", district: "المربع", city: "الرياض", postal_code: "23333" };
const invoice = { number: "INV-9", zatca_uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be", issue_date: "2026-10-25", issue_time: "10:00:00",
  invoice_kind: "simplified", doc_type: "invoice", subtotal: 100, taxable_amount: 100, vat_amount: 15, total: 115, zatca_icv: 7,
  zatca_pih: "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" };
const lines = [{ description: "خدمة", quantity: 1, unit_price: 100, discount: 0, tax_category: "S", tax_rate: 15, line_net: 100, line_vat: 15, line_total: 115 }];

describe("ZATCA phase 2 signing", () => {
  const keys = generateKeyAndCsr({ environment: "sandbox", vatNumber: "399999999900003", orgName: "شركة الاختبار", unitName: "الفرع الرئيسي",
    egsName: "GDXora-1", serial: "11111111-2222-3333-4444-555555555555", address: "2322 الأمير سلطان الرياض", industry: "خدمات" });
  const cert = selfSigned(keys.privateKeyPem);

  it("builds a CSR with the ZATCA fields", () => {
    const p = KJUR.asn1.csr.CSRUtil.getParam(keys.csrPem);
    expect(p.subject.str).toContain("/C=SA");
    expect(p.subject.str).toContain("/CN=GDXora-1");
    const san = JSON.stringify(p.extreq);
    expect(san).toContain("399999999900003");
    expect(san).toContain("1-GDXora|2-1.0|3-11111111-2222-3333-4444-555555555555");
    expect(san).toContain("1.3.6.1.4.1.311.20.2");
  });

  const s = signInvoice({ invoice, lines, seller, buyer: null, paymentMeans: "cash" }, { privateKeyPem: keys.privateKeyPem, certificate: cert, signingTime: "2026-10-25T10:00:05" });

  it("hashes the invoice without signature, extensions and QR", () => {
    const expected = crypto.createHash("sha256").update(buildInvoiceXml({ invoice, lines, seller, buyer: null, paymentMeans: "cash" }, { forHash: true })).digest("base64");
    expect(s.hash).toBe(expected);
    // removing the three excluded parts from the signed XML gives back the hashed text
    const stripped = s.xml.replace(/<ext:UBLExtensions>.*<\/ext:UBLExtensions>/, "").replace(/<cac:Signature>.*?<\/cac:Signature>/, "")
      .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/, "");
    expect(crypto.createHash("sha256").update(stripped).digest("base64")).toBe(s.hash);
  });

  it("signs the hash with the EGS key (verifiable with the certificate)", () => {
    const pub = new crypto.X509Certificate(Buffer.from(cert, "base64")).publicKey;
    expect(crypto.createVerify("sha256").update(Buffer.from(s.hash, "base64")).verify(pub, Buffer.from(s.signature, "base64"))).toBe(true);
  });

  it("embeds the XAdES block and the signature marker in the right places", () => {
    expect(s.xml.indexOf("<ext:UBLExtensions>")).toBe(s.xml.indexOf(">") + 1);       // first child of Invoice
    expect(s.xml).toContain("<ds:DigestValue>" + s.hash + "</ds:DigestValue>");
    expect(s.xml).toContain("<ds:X509SerialNumber>" + BigInt("0x0a1b2c3d").toString() + "</ds:X509SerialNumber>");
    expect(s.xml).toContain("<ds:X509IssuerName>CN=eInvoicing</ds:X509IssuerName>");
    expect(s.xml.indexOf("<cac:Signature>")).toBeGreaterThan(s.xml.indexOf("<cbc:ID>QR</cbc:ID>"));
    expect(s.xml.indexOf("<cac:Signature>")).toBeLessThan(s.xml.indexOf("<cac:AccountingSupplierParty>"));
    // signed-properties digest: base64(hex(sha256(exclusive form, DigestMethod self-closed)))
    const certHash = Buffer.from(crypto.createHash("sha256").update(cert).digest("hex")).toString("base64");
    const props = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>2026-10-25T10:00:05</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certHash}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">CN=eInvoicing</ds:X509IssuerName><ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${BigInt("0x0a1b2c3d")}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
    expect(s.xml).toContain(`<ds:DigestValue>${Buffer.from(crypto.createHash("sha256").update(props).digest("hex")).toString("base64")}</ds:DigestValue>`);
  });

  it("puts tags 1–9 in the QR of a simplified invoice", () => {
    const q = decodeQr(s.qr);
    expect(q[1]).toBe(seller.legal_name);
    expect(q[2]).toBe("399999999900003");
    expect(q[3]).toBe("2026-10-25T10:00:00");
    expect(q[4]).toBe("115.00");
    expect(q[5]).toBe("15.00");
    expect(q[6]).toBe(s.hash);
    expect(q[7]).toBe(s.signature);
    expect(Object.keys(q).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const info = certificateInfo(cert);
    expect(info.issuer).toBe("CN=eInvoicing");
    // tag 8 carries the DER public key
    const bytes = fromBase64(s.qr);
    expect(Buffer.from(bytes).includes(Buffer.from(info.publicKeyDer))).toBe(true);
  });
});
