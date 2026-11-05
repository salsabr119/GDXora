// «جاهز للإيداع في قوائم»: every figure the Qawaem platform asks for, page by
// page in the platform's order, with a copy button per figure, the
// before-filing checks, and the Arabic PDF / Excel to attach.
import { forwardRef, useEffect, useRef, useState } from "react";
import { rpc } from "../supabase.js";
import { useApp, useData, PageHead, Panel, Tabs, Loading, Badge, go } from "../ui.jsx";
import { PAGES, SOCE_COLUMNS, SOCE_ROWS, LANDING, INPUTS, flatten, plain, fmt } from "../lib/qawaem.js";
import { A4Viewer } from "./InvoiceDocument.jsx";
import { useLetterhead, letterheadStyle } from "../lib/letterhead.js";

const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => thisYear - i);
const acc = (v) => (Number(v) < 0 ? `(${fmt(-v)})` : fmt(v));   // accounting style for the PDF

export function Qawaem() {
  const { t, notifyError, org } = useApp();
  const [year, setYear] = useState(thisYear - 1);
  const [exporting, setExporting] = useState(false);
  const docs = useRef(null);
  const d = useData(() => rpc("report_qawaem", { p_year: year }), [year]);
  const r = d.data;

  async function exportExcel() {
    const { exportXlsx } = await import("../lib/excel.js");
    await exportXlsx({
      filename: `${t("قوائم", "Qawaem")} ${year}`, sheet: t("قوائم", "Qawaem"),
      title: `${org.legal_name || org.name_ar} — ${t("أرقام منصة قوائم لسنة", "Qawaem figures for")} ${year}`,
      columns: [{ label: t("الصفحة", "Page"), value: (x) => x.page }, { label: t("الخانة", "Line"), type: "num", value: (x) => x.line },
                { label: t("البند", "Item"), value: (x) => x.label }, { label: t("المبلغ", "Amount"), type: "num", value: (x) => Math.round(Number(x.amount || 0)) }],
      rows: flatten(r, t),
    }).catch(notifyError);
  }
  // render the document off-screen, then turn its pages into one PDF
  useEffect(() => {
    if (!exporting) return;
    (async () => {
      try {
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const { nodesToPdf, downloadBlob } = await import("../lib/pdf.js");
        const blob = await nodesToPdf([...docs.current.querySelectorAll(".a4")]);
        downloadBlob(blob, `${t("القوائم المالية", "Financial statements")} ${year}.pdf`);
      } catch (e) { notifyError(e); }
      setExporting(false);
    })();
  }, [exporting, year, t, notifyError]);

  return (
    <>
      <PageHead title={t("جاهز للإيداع في قوائم", "Ready to file in Qawaem")}
                sub={t("أرقام منصة «قوائم» (المركز السعودي للأعمال) بنفس أرقام خاناتها، مع فحص قبل التقديم", "Qawaem (Saudi Business Center) figures by platform line, checked before filing")}>
        <select value={year} style={{ width: 110 }} onChange={(e) => setYear(Number(e.target.value))}>
          {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        <button className="btn" onClick={() => go("/reports")}>{t("كل التقارير", "All reports")}</button>
        <button className="btn" onClick={exportExcel} disabled={!r}>⬇ Excel</button>
        <button className="btn primary" onClick={() => setExporting(true)} disabled={!r || exporting}>{exporting ? "…" : "⬇ PDF"}</button>
      </PageHead>
      {!r ? <Loading /> : <QawaemBody r={r} />}
      {r && exporting && <div className="q-offscreen" ref={docs} dir="rtl"><QawaemDocument r={r} org={org} /></div>}
    </>
  );
}

/** the figures of one year: checks, the platform's pages, and a PDF preview */
export function QawaemBody({ r }) {
  const { t, notify, org } = useApp();
  const [tab, setTab] = useState("landing");
  async function copy(v) {
    const text = plain(v);
    try { await navigator.clipboard.writeText(text); notify(t(`نُسخ: ${text}`, `Copied: ${text}`), "ok"); }
    catch { notify(t(`انسخ يدوياً: ${text}`, `Copy manually: ${text}`)); }
  }
  const errors = (r?.checks || []).filter((c) => !c.ok && c.severity === "error");
  const warnings = (r?.checks || []).filter((c) => !c.ok && c.severity === "warning");
  const Lines = ({ page }) => (
    <Panel pad={false}>
      {page.note && <div className="alert" style={{ margin: 12 }}>{t(...page.note)}</div>}
      <table className="tbl q-lines"><tbody>
        {page.lines.map(([no, ar, en, o = {}]) => {
          const v = r[page.key]?.[no] ?? 0;
          return (
            <tr key={no} className={o.calc ? "q-calc" : ""}>
              <td className="q-no mono">{typeof no === "number" ? no : ""}</td>
              <td>{t(ar, en)}{o.red && <span title={t("تُكتب موجبة والمنصة تطرحها", "Enter positive; the platform subtracts it")}> 🟥</span>}
                {o.calc && <span className="muted" style={{ fontSize: 12 }}> — {t("تحسبها المنصة", "computed by the platform")}</span>}</td>
              <td className={`n mono ${Number(v) < 0 ? "neg" : ""}`}>{fmt(v)}</td>
              <td className="q-copy"><button className="btn ghost sm" onClick={() => copy(v)} title={t("نسخ", "Copy")}>⧉</button></td>
            </tr>);
        })}
      </tbody></table>
    </Panel>
  );

  return (
    <>
        <Checks checks={r.checks} rounding={r.rounding} />
        <Tabs value={tab} onChange={setTab} tabs={[
          ["landing", t("صفحة البداية", "Landing page")], ["inputs", t("بيانات الإدخال", "Inputs")],
          ["bs", t("المركز المالي", "Financial position")], ["pl", t("الأرباح والخسائر", "Profit or loss")],
          ["oci", t("الدخل الشامل", "Comprehensive income")], ["cf", t("التدفقات النقدية", "Cash flows")],
          ["soce", t("التغير في حقوق الملكية", "Changes in equity")]]} />
        {tab === "landing" && <Panel pad={false}><table className="tbl q-lines"><tbody>
          {LANDING.map(([k, ar, en]) => (
            <tr key={k}><td>{t(ar, en)}{k === "total_assets" && <div className="muted" style={{ fontSize: 12 }}>{t("يقفل خانة 13 في الميزانية — لازم يساويها بالضبط", "Locks balance-sheet line 13 — must match exactly")}</div>}</td>
              <td className="n mono">{fmt(r.landing[k])}</td>
              <td className="q-copy"><button className="btn ghost sm" onClick={() => copy(r.landing[k])}>⧉</button></td></tr>))}
        </tbody></table></Panel>}
        {tab === "inputs" && <Panel pad={false}><table className="tbl"><tbody>
          {INPUTS(r.inputs).map(([ar, en, v]) => <tr key={ar}><td>{t(ar, en)}</td><td style={{ fontWeight: 600 }}>{t(...v)}</td></tr>)}
        </tbody></table></Panel>}
        {PAGES.map((p) => tab === p.key && <Lines key={p.key} page={p} />)}
        {tab === "soce" && <Panel pad={false}>
          <div className="alert" style={{ margin: 12 }}>{t("اكتب 0 في كل خانة بيضاء فاضية — الخانات الفارغة تخلّي المنصة تحتفظ بقيم قديمة وتظهر «Duplicate combination found».",
            "Enter 0 in every empty white cell — blank cells keep old values and cause “Duplicate combination found”.")}</div>
          <div className="tbl-wrap"><table className="tbl q-lines">
            <thead><tr><th className="q-no" /><th />{SOCE_COLUMNS.map(([c, ar, en, o = {}]) => <th key={c} className={`n ${o.calc ? "q-calc" : ""}`}>{t(ar, en)}</th>)}</tr></thead>
            <tbody>{SOCE_ROWS.map(([no, ar, en, o = {}]) => (
              <tr key={no} className={o.calc ? "q-calc" : ""}><td className="q-no mono">{no}</td><td>{t(ar, en)}</td>
                {SOCE_COLUMNS.map(([c, , , co = {}]) => {
                  const v = r.soce[no]?.[c] ?? 0;
                  return <td key={c} className={`n mono ${Number(v) < 0 ? "neg" : ""}`}>
                    {fmt(v)}{!co.calc && !o.calc && <button className="btn ghost sm" onClick={() => copy(v)} title={t("نسخ", "Copy")}>⧉</button>}</td>;
                })}</tr>))}</tbody>
          </table></div>
        </Panel>}
        {(errors.length > 0 || warnings.length > 0) && <div className="muted no-print" style={{ fontSize: 12, marginTop: 8 }}>
          {t("راجع الفحوصات أعلاه قبل التقديم.", "Review the checks above before filing.")}</div>}
        <details className="no-print" style={{ marginTop: 16 }}>
          <summary className="muted">{t("معاينة PDF", "PDF preview")}</summary>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, marginTop: 12 }}><QawaemDocument r={r} org={org} viewer /></div>
        </details>
    </>
  );
}

function Checks({ checks, rounding }) {
  const { t } = useApp();
  const failed = checks.filter((c) => !c.ok);
  const errors = failed.filter((c) => c.severity === "error");
  return (
    <Panel title={<>{t("الفحوصات قبل التقديم", "Before-filing checks")} {errors.length
      ? <Badge kind="bad">{t(`${errors.length} خطأ`, `${errors.length} error(s)`)}</Badge>
      : <Badge kind="ok">{t("الأرقام متطابقة", "Figures agree")}</Badge>}</>}>
      <ul className="q-checks">
        {checks.map((c) => (
          <li key={c.key} className={c.ok ? "ok" : c.severity}>
            <span>{c.ok ? "✓" : c.severity === "error" ? "✕" : c.severity === "warning" ? "⚠" : "ℹ"}</span>
            {t(c.ar, c.en)}{c.key === "rounding" && !c.ok && <b className="mono"> ({fmt(rounding)})</b>}
          </li>))}
      </ul>
      {failed.length === 0 && <div className="muted">{t("كل الفحوصات ناجحة.", "Every check passed.")}</div>}
    </Panel>
  );
}

/* ── the Arabic statements to attach (A4 pages) ──────────────────────── */
export const QawaemDocument = forwardRef(function QawaemDocument({ r, org, viewer }, ref) {
  const name = org.legal_name || org.name_ar;
  const end = `${r.year}-12-31`;
  const lh = useLetterhead();
  const Page = ({ title, children }) => {
    const page = (
      <div className={`a4 qd ${lh ? "lh" : ""}`} dir="rtl" style={letterheadStyle(lh)}>
        <header className="qd-head">
          {!lh && <div className="a4-org-name">{name}</div>}
          {!lh && org.cr_number && <div className="a4-meta">سجل تجاري رقم <b className="ltr">{org.cr_number}</b></div>}
          <div className="qd-title">{title}</div>
          <div className="muted">للسنة المنتهية في <span className="ltr">{end}</span> — المبالغ بالريال السعودي</div>
        </header>
        {children}
        {!lh && <footer className="a4-foot"><div className="a4-gen">GDXora · Global Drive IT Solutions</div></footer>}
      </div>);
    return viewer ? <A4Viewer>{page}</A4Viewer> : page;
  };
  const Rows = ({ pageKey }) => {
    const p = PAGES.find((x) => x.key === pageKey);
    return (
      <table className="qd-table"><tbody>
        {p.lines.filter(([no, , , o = {}]) => o.calc || Number(r[pageKey]?.[no] || 0) !== 0).map(([no, ar, , o = {}]) => (
          <tr key={no} className={o.calc ? "qd-total" : ""}><td>{ar}</td><td className="n">{acc(r[pageKey]?.[no])}</td></tr>))}
      </tbody></table>);
  };
  const going = Number(r.bs[31]) < 0 || r.checks.some((c) => c.key === "half_capital" && !c.ok);
  return (
    <div ref={ref}>
      <Page title="قائمة المركز المالي"><Rows pageKey="bs" /></Page>
      <Page title="قائمة الأرباح أو الخسائر والدخل الشامل الآخر">
        <Rows pageKey="pl" />
        <h3 className="qd-sub">الدخل الشامل الآخر</h3>
        <Rows pageKey="oci" />
      </Page>
      <Page title="قائمة التدفقات النقدية"><Rows pageKey="cf" /></Page>
      <Page title="قائمة التغير في حقوق الملكية">
        <table className="qd-table qd-soce">
          <thead><tr><th />{SOCE_COLUMNS.map(([c, ar]) => <th key={c} className="n">{ar}</th>)}</tr></thead>
          <tbody>{SOCE_ROWS.map(([no, ar, , o = {}]) => (
            <tr key={no} className={o.calc ? "qd-total" : ""}><td>{ar}</td>
              {SOCE_COLUMNS.map(([c]) => <td key={c} className="n">{acc(r.soce[no]?.[c])}</td>)}</tr>))}</tbody>
        </table>
      </Page>
      <Page title="إيضاحات حول القوائم المالية">
        <ol className="qd-notes">
          <li><b>التنظيم والنشاط:</b> {name}{org.cr_number ? ` مسجلة بالسجل التجاري رقم ${org.cr_number}` : ""}، وتمارس نشاطها في المملكة العربية السعودية.</li>
          <li><b>أسس الإعداد:</b> أُعدّت القوائم المالية وفق المعايير المحاسبية المعتمدة في المملكة العربية السعودية، على أساس الاستحقاق ومبدأ التكلفة التاريخية، وتُعرض بالريال السعودي مقرّبة لأقرب ريال.</li>
          <li><b>النقد وما يعادله:</b> يبلغ رصيد النقد لدى البنوك وفي الصندوق {acc(r.bs[2])} ريال في <span className="ltr">{end}</span>.</li>
          <li><b>الممتلكات والمعدات:</b> تُثبت بالتكلفة ناقصاً الاستهلاك المتراكم. صافي القيمة الدفترية {acc(r.bs[7])} ريال، واستهلاك السنة {acc(r.cf[4])} ريال.</li>
          <li><b>القروض:</b> رصيد القروض {acc(r.bs[16])} ريال.</li>
          <li><b>رأس المال:</b> رأس المال المدفوع الظاهر في قائمة المركز المالي {acc(r.bs[25])} ريال.</li>
          <li><b>الزكاة:</b> مصروف الزكاة للسنة {acc(r.pl[18])} ريال، والزكاة المستحقة {acc(r.bs[18])} ريال.</li>
          {going && <li><b>الاستمرارية:</b> بلغت حقوق الملكية {acc(r.bs[31])} ريال والخسائر المتراكمة {acc(-Number(r.bs[26]))} ريال. أُعدّت القوائم المالية على أساس الاستمرارية اعتماداً على دعم الشركاء وتمويلهم لأنشطة الشركة، والتزامهم باتخاذ ما يلزم وفق نظام الشركات.</li>}
        </ol>
        <div className="qd-sign">
          <div>المدير: ............................</div><div>التوقيع: ............................</div><div>التاريخ: ............................</div>
        </div>
      </Page>
      <Page title="إقرار الإعفاء من تعيين مراجع حسابات">
        <p className="qd-p">
          نقر نحن {name}{org.cr_number ? `، سجل تجاري رقم ${org.cr_number}` : ""}، بأن الشركة تستوفي شروط الإعفاء من تعيين مراجع حسابات وفق نظام الشركات ولائحته التنفيذية،
          وأن القوائم المالية المرفقة للسنة المنتهية في <span className="ltr">{end}</span> أُعدّت من واقع السجلات المحاسبية للشركة، وتعبّر بصورة عادلة عن مركزها المالي ونتائج أعمالها وتدفقاتها النقدية،
          ونتحمل المسؤولية الكاملة عن صحتها.
        </p>
        <p className="qd-p muted">مجموع الموجودات {acc(r.bs[13])} ريال · الإيرادات {acc(r.landing.revenue)} ريال · عدد الموظفين {r.landing.employees}</p>
        <div className="qd-sign">
          <div>الاسم: ............................</div><div>الصفة: ............................</div><div>التوقيع: ............................</div><div>التاريخ: ............................</div>
        </div>
        <p className="qd-p muted" style={{ fontSize: 10 }}>نموذج للمراجعة — تأكد من انطباق شروط الإعفاء على الشركة قبل التوقيع.</p>
      </Page>
    </div>
  );
});
