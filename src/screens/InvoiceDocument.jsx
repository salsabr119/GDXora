// Printable A4 tax invoice (Arabic-first, bilingual labels as is customary in
// Saudi Arabia). Rendered at a fixed A4 width so screen, print and PDF match;
// scaled down on narrow screens.
import { forwardRef, useEffect, useRef, useState } from "react";
import { amountInArabicWords } from "../lib/tafqeet.js";

const L = ({ ar, en }) => <span className="bi"><span>{ar}</span><small dir="ltr">{en}</small></span>;
// document amounts: always Latin digits with thousands separators
const num = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addr = (p) => [p?.building_no, p?.street, p?.district, p?.city, p?.postal_code].filter(Boolean).join("، ");
const d = (v) => (v ? String(v).slice(0, 10) : "—");

export const TITLES = {
  standard: { ar: "فاتورة ضريبية", en: "Tax Invoice" },
  simplified: { ar: "فاتورة ضريبية مبسطة", en: "Simplified Tax Invoice" },
  credit_note: { ar: "إشعار دائن", en: "Credit Note" },
  debit_note: { ar: "إشعار مدين", en: "Debit Note" },
};
export const docTitle = (inv) => (inv.doc_type === "invoice" ? TITLES[inv.invoice_kind] : TITLES[inv.doc_type]);

export const InvoiceDocument = forwardRef(function InvoiceDocument({ inv, org, qrImg }, ref) {
  const c = inv.customers;
  const title = docTitle(inv);
  const cur = inv.currency === "SAR" || !inv.currency ? "ر.س" : inv.currency;
  return (
    <div className="a4" ref={ref} dir="rtl">
      <header className="a4-head">
        <div className="a4-org">
          {org.logo_data && <img className="a4-logo" src={org.logo_data} alt="" />}
          <div>
            <div className="a4-org-name">{org.legal_name || org.name_ar}</div>
            {org.name_en && <div className="a4-org-en">{org.name_en}</div>}
            <div className="a4-meta">
              {org.vat_number && <span>الرقم الضريبي VAT: <b className="ltr">{org.vat_number}</b></span>}
              {org.cr_number && <span>س.ت CR: <b className="ltr">{org.cr_number}</b></span>}
            </div>
            {addr(org) && <div className="a4-meta">{addr(org)}</div>}
          </div>
        </div>
        <div className="a4-title-box">
          <div className="a4-title">{title.ar}</div>
          <div className="a4-title-en">{title.en}</div>
          {qrImg && <img className="a4-qr" src={qrImg} alt="ZATCA QR" />}
        </div>
      </header>

      <section className="a4-grid">
        <div className="a4-box">
          <div className="a4-box-h"><L ar="بيانات الفاتورة" en="Invoice details" /></div>
          <table className="a4-kv"><tbody>
            <tr><th><L ar="رقم الفاتورة" en="Invoice no." /></th><td className="ltr"><b>{inv.number || "—"}</b></td></tr>
            <tr><th><L ar="تاريخ الإصدار" en="Issue date" /></th><td className="ltr">{d(inv.issue_date)} {String(inv.issue_time || "").slice(0, 5)}</td></tr>
            <tr><th><L ar="تاريخ التوريد" en="Supply date" /></th><td className="ltr">{d(inv.supply_date || inv.issue_date)}</td></tr>
            {inv.due_date && <tr><th><L ar="تاريخ الاستحقاق" en="Due date" /></th><td className="ltr">{d(inv.due_date)}</td></tr>}
            {inv.projects && <tr><th><L ar="المشروع" en="Project" /></th><td>{inv.projects.name_ar}</td></tr>}
            {inv.ref?.number && <tr><th><L ar="الفاتورة الأصلية" en="Original invoice" /></th><td><span className="ltr">{inv.ref.number}</span> — {inv.reason}</td></tr>}
          </tbody></table>
        </div>
        <div className="a4-box">
          <div className="a4-box-h"><L ar="العميل" en="Bill to" /></div>
          {c ? (
            <table className="a4-kv"><tbody>
              <tr><th><L ar="الاسم" en="Name" /></th><td><b>{c.name_ar}</b>{c.name_en && <div className="ltr muted">{c.name_en}</div>}</td></tr>
              {c.vat_number && <tr><th><L ar="الرقم الضريبي" en="VAT no." /></th><td className="ltr">{c.vat_number}</td></tr>}
              {c.cr_number && <tr><th><L ar="السجل التجاري" en="CR no." /></th><td className="ltr">{c.cr_number}</td></tr>}
              {addr(c) && <tr><th><L ar="العنوان" en="Address" /></th><td>{addr(c)}</td></tr>}
            </tbody></table>
          ) : <div className="muted" style={{ padding: "6px 10px" }}>عميل نقدي · Cash customer</div>}
        </div>
      </section>

      <table className="a4-lines">
        <thead><tr>
          <th style={{ width: 28 }}>#</th>
          <th className="desc"><L ar="الوصف" en="Description" /></th>
          <th><L ar="الكمية" en="Qty" /></th>
          <th><L ar="سعر الوحدة" en="Unit price" /></th>
          <th><L ar="الخصم" en="Discount" /></th>
          <th><L ar="المبلغ الخاضع" en="Taxable" /></th>
          <th><L ar="الضريبة" en="VAT" /></th>
          <th><L ar="الإجمالي" en="Total" /></th>
        </tr></thead>
        <tbody>{inv.lines.map((l, k) => (
          <tr key={l.id || k}>
            <td>{k + 1}</td>
            <td className="desc">{l.description}</td>
            <td className="n">{Number(l.quantity)}{l.unit ? <small> {l.unit}</small> : null}</td>
            <td className="n">{num(l.unit_price)}</td>
            <td className="n">{Number(l.discount) ? num(l.discount) : "—"}</td>
            <td className="n">{num(l.line_net)}</td>
            <td className="n">{num(l.line_vat)}<small> ({Number(l.tax_rate)}%)</small></td>
            <td className="n"><b>{num(l.line_total)}</b></td>
          </tr>))}
        </tbody>
      </table>

      <section className="a4-bottom">
        <div className="a4-words">
          <div className="a4-box-h"><L ar="المبلغ كتابةً" en="Amount in words" /></div>
          <p>{amountInArabicWords(Number(inv.retention_amount) > 0 ? inv.net_payable : inv.total)}</p>
          {(org.bank_name || org.iban) && <>
            <div className="a4-box-h"><L ar="بيانات التحويل" en="Bank details" /></div>
            <p>{org.bank_name}{org.bank_name && org.iban ? " · " : ""}<span className="ltr">{org.iban}</span></p>
          </>}
          {inv.notes && <><div className="a4-box-h"><L ar="ملاحظات" en="Notes" /></div><p>{inv.notes}</p></>}
        </div>
        <table className="a4-totals"><tbody>
          <tr><th><L ar="الإجمالي قبل الضريبة" en="Subtotal" /></th><td>{num(inv.subtotal)} {cur}</td></tr>
          {Number(inv.advance_deduction) > 0 && <tr><th><L ar="استرداد دفعة مقدمة" en="Advance recovery" /></th><td>-{num(inv.advance_deduction)} {cur}</td></tr>}
          <tr><th><L ar="المبلغ الخاضع للضريبة" en="Taxable amount" /></th><td>{num(inv.taxable_amount)} {cur}</td></tr>
          <tr><th><L ar="ضريبة القيمة المضافة" en="VAT" /></th><td>{num(inv.vat_amount)} {cur}</td></tr>
          <tr className="grand"><th><L ar="الإجمالي شامل الضريبة" en="Total incl. VAT" /></th><td>{num(inv.total)} {cur}</td></tr>
          {Number(inv.retention_amount) > 0 && <>
            <tr><th><L ar="محتجزات ضمان" en="Retention" /></th><td>-{num(inv.retention_amount)} {cur}</td></tr>
            <tr className="grand"><th><L ar="صافي المستحق" en="Net payable" /></th><td>{num(inv.net_payable)} {cur}</td></tr>
          </>}
        </tbody></table>
      </section>

      <footer className="a4-foot">
        {org.invoice_footer && <div className="a4-foot-note">{org.invoice_footer}</div>}
        <div className="a4-contact">
          {[org.phone, org.email, org.website].filter(Boolean).map((x) => <span key={x} className="ltr">{x}</span>)}
        </div>
        <div className="a4-gen">GDXora · Global Drive IT Solutions</div>
      </footer>
    </div>
  );
});

/** Fits the fixed-width A4 page into its container (scales down on phones/tablets). */
export function A4Viewer({ children }) {
  const wrap = useRef(null);
  const [scale, setScale] = useState(1);
  const [h, setH] = useState(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const fit = () => {
      const page = el.firstElementChild;
      const s = Math.min(1, el.clientWidth / 794);
      setScale(s);
      if (page) setH(page.offsetHeight * s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="a4-viewer" dir="rtl" ref={wrap} style={{ height: h || undefined }}>
      <div className="a4-scale" style={{ transform: `scale(${scale})`, transformOrigin: "top right", width: 794 }}>{children}</div>
    </div>
  );
}
