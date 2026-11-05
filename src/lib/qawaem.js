// Layout of the Qawaem filing (المركز السعودي للأعمال, MSM v1.0): the pages in
// the platform's order and each line's number and label, so the screen, the
// Excel file and the PDF read exactly like the forms being filled in.
// Figures come from report_qawaem() (supabase/migrations/0021_qawaem_report.sql).
//   calc: the platform computes the line itself (shown for checking)
//   red:  entered as a positive amount, the platform subtracts it

export const PAGES = [
  {
    key: "bs", title: ["قائمة المركز المالي (حسب السيولة)", "Statement of financial position (liquidity)"],
    lines: [
      [2, "النقد وما يعادله", "Cash and cash equivalents"],
      [3, "المبالغ المستحقة من العملاء", "Amounts due from customers"],
      [4, "دفعات مقدمة للبائعين", "Advances to suppliers"],
      [5, "مخزون", "Inventory"],
      [6, "استثمارات بالقيمة العادلة من خلال الأرباح والخسائر", "Investments at FVTPL"],
      [7, "ممتلكات ومعدات وآلات", "Property, plant & equipment"],
      [8, "موجودات غير ملموسة باستثناء الشهرة", "Intangible assets other than goodwill"],
      [9, "العقارات الاستثمارية", "Investment property"],
      [10, "الاستثمارات المحتسبة بطريقة حقوق الملكية", "Equity-accounted investments"],
      [11, "المستحقات", "Accrued income"],
      [12, "موجودات أخرى", "Other assets"],
      [13, "مجموع الموجودات", "Total assets", { calc: true }],
      [16, "سندات دين وقروض لأجل وقروض وصكوك مصدرة", "Bonds, term loans, borrowings and sukuk"],
      [17, "المبالغ المستحقة للموردين والبائعين", "Amounts due to suppliers"],
      [18, "الزكاة مستحقة الدفع", "Zakat payable"],
      [19, "الضرائب مستحقة الدفع", "Taxes payable"],
      [20, "مطلوبات أخرى", "Other liabilities"],
      [21, "التزام منافع الموظفين", "Employee benefit obligations"],
      [22, "مطلوبات ضريبية مؤجلة", "Deferred tax liabilities"],
      [23, "مجموع المطلوبات", "Total liabilities", { calc: true }],
      [25, "رأس المال", "Share capital"],
      [26, "أرباح مبقاة (خسائر متراكمة)", "Retained earnings (accumulated losses)"],
      [27, "احتياطي نظامي", "Statutory reserve"],
      [28, "عناصر أخرى لحقوق الملكية", "Other components of equity"],
      [29, "حقوق الملكية المتعلقة بمساهمي الشركة الأم", "Equity attributable to owners", { calc: true }],
      [30, "حقوق الملكية غير المسيطرة", "Non-controlling interests"],
      [31, "مجموع حقوق الملكية", "Total equity", { calc: true }],
      [32, "مجموع حقوق الملكية والمطلوبات", "Total equity and liabilities", { calc: true }],
    ],
  },
  {
    key: "pl", title: ["قائمة الأرباح أو الخسائر (حسب الوظيفة)", "Profit or loss (by function)"],
    note: ["المصاريف تُكتب بأرقام موجبة، والمنصة تطرحها.", "Expenses are entered as positive amounts; the platform subtracts them."],
    lines: [
      [2, "المبيعات / الإيرادات", "Sales / revenue"],
      [3, "إيرادات التجارة الإلكترونية", "E-commerce revenue"],
      [4, "تكلفة المبيعات", "Cost of sales"],
      [6, "أرباح استبعاد الاستثمارات", "Gain on disposal of investments"],
      [7, "أرباح استبعاد العقارات الاستثمارية", "Gain on disposal of investment property"],
      [8, "الحصة في أرباح الشركات الزميلة", "Share of profit of associates"],
      [9, "دخل آخر", "Other income"],
      [12, "مصاريف بيع وتوزيع", "Selling & distribution expenses"],
      [13, "مصاريف عمومية وإدارية", "General & administrative expenses"],
      [14, "تكلفة التمويل", "Finance cost"],
      [15, "مصاريف أخرى", "Other expenses"],
      [18, "الزكاة", "Zakat"],
      [19, "الضرائب", "Taxes"],
      [22, "المتعلق بحقوق الملكية غير المسيطرة", "Attributable to non-controlling interests"],
      [23, "المتعلق بمساهمي الشركة الأم (صافي الربح)", "Attributable to owners (net profit)", { calc: true }],
    ],
  },
  {
    key: "oci", title: ["قائمة الدخل الشامل الآخر", "Other comprehensive income"],
    lines: [
      [3, "إعادة التقييم", "Revaluation"],
      [4, "إعادة التقييم (بنود أخرى)", "Revaluation (other items)"],
      [8, "المتعلق بحقوق الملكية غير المسيطرة", "Attributable to non-controlling interests"],
      [9, "المتعلق بمساهمي الشركة الأم", "Attributable to owners", { calc: true }],
    ],
  },
  {
    key: "cf", title: ["قائمة التدفقات النقدية (الطريقة غير المباشرة)", "Cash flows (indirect method)"],
    note: ["الخانات المعلّمة 🟥 تُكتب موجبة، والمنصة تطرحها.", "Lines marked 🟥 are entered as positive amounts; the platform subtracts them."],
    lines: [
      ["profit", "صافي الربح (الخسارة)", "Net profit (loss)", { calc: true }],
      [4, "الاستهلاك", "Depreciation"],
      [5, "الانخفاض في القيمة", "Impairment"],
      [6, "الإطفاء", "Amortisation"],
      [7, "(ربح) خسارة بيع أصول", "(Gain) loss on sale of assets"],
      [8, "معاملات غير نقدية أخرى", "Other non-cash items"],
      [10, "التغير في المدينين", "Change in receivables"],
      [11, "التغير في المخزون", "Change in inventory"],
      [12, "التغير في الدائنين", "Change in payables"],
      ["operating", "صافي النقد من الأنشطة التشغيلية", "Net cash from operating activities", { calc: true }],
      [15, "متحصلات بيع أصول", "Proceeds from sale of assets"],
      [16, "شراء أصول", "Purchase of assets", { red: true }],
      [17, "أخرى استثمارية", "Other investing"],
      ["investing", "صافي النقد من الأنشطة الاستثمارية", "Net cash from investing activities", { calc: true }],
      [20, "العوائد من إصدار الأسهم (المدفوع من رأس المال)", "Proceeds from issuing shares (capital paid)"],
      [21, "متحصلات القروض", "Proceeds from borrowings"],
      [22, "سداد القروض", "Repayment of borrowings", { red: true }],
      [23, "توزيعات أرباح", "Dividends paid", { red: true }],
      [24, "أخرى تمويلية", "Other financing"],
      ["financing", "صافي النقد من الأنشطة التمويلية", "Net cash from financing activities", { calc: true }],
      [27, "النقد بداية الفترة", "Cash at the beginning of the period"],
      [28, "النقد نهاية الفترة", "Cash at the end of the period", { calc: true }],
    ],
  },
];

export const SOCE_COLUMNS = [
  ["capital", "رأس المال", "Share capital"],
  ["retained", "أرباح مبقاة", "Retained earnings"],
  ["statutory", "احتياطي نظامي", "Statutory reserve"],
  ["other", "عناصر أخرى", "Other components"],
  ["parent", "المتعلق بمساهمي الأم", "Attributable to owners", { calc: true }],
  ["nci", "غير المسيطرة", "Non-controlling interests"],
  ["total", "الإجمالي", "Total", { calc: true }],
];
export const SOCE_ROWS = [
  [1, "الرصيد بداية الفترة", "Balance at the beginning of the period"],
  [4, "ربح (خسارة) الفترة", "Profit (loss) for the period"],
  [5, "الدخل الشامل الآخر", "Other comprehensive income"],
  [7, "محول للاحتياطي النظامي", "Transfer to statutory reserve"],
  [8, "توزيعات أرباح", "Dividends"],
  [9, "زيادة (نقص) من تغيرات أخرى", "Increase (decrease) from other changes"],
  [11, "الرصيد نهاية الفترة", "Balance at the end of the period", { calc: true }],
];

export const LANDING = [
  ["revenue", "الإيرادات", "Revenue"],
  ["total_assets", "مجموع الموجودات", "Total assets"],
  ["employees", "عدد الموظفين", "Employees"],
];

export const INPUTS = (r) => [
  ["طبيعة القوائم", "Statements", r.separate ? ["منفصلة", "Separate"] : ["موحدة", "Consolidated"]],
  ["المرة الأولى منذ التأسيس", "First filing since establishment", r.first_time ? ["نعم", "Yes"] : ["لا", "No"]],
  ["عرض المركز المالي", "Financial position", ["حسب السيولة", "Liquidity order"]],
  ["الأرباح والخسائر", "Profit or loss", ["وظيفة المصاريف", "By function of expense"]],
  ["الدخل الشامل", "Comprehensive income", ["صافي بعد الضريبة", "Net of tax"]],
  ["التدفقات النقدية", "Cash flows", ["الطريقة غير المباشرة", "Indirect method"]],
  ["التجارة الإلكترونية", "E-commerce", r.ecommerce ? ["نعم", "Yes"] : ["لا", "No"]],
];

/** platform-ready text: whole riyals, minus sign, no thousands separators */
export const plain = (v) => String(Math.round(Number(v || 0)));
/** display: thousands separators, Latin digits */
export const fmt = (v) => Math.round(Number(v || 0)).toLocaleString("en-US");

/** every figure of a report as flat rows (statement, line, label, amount) — for Excel */
export function flatten(r, t) {
  const rows = [];
  for (const [k, ar, en] of LANDING) rows.push({ page: t("صفحة البداية", "Landing page"), line: "", label: t(ar, en), amount: r.landing[k] });
  for (const p of PAGES) {
    for (const [no, ar, en, o = {}] of p.lines) {
      rows.push({ page: t(...p.title), line: typeof no === "number" ? no : "", label: t(ar, en) + (o.red ? " 🟥" : "") + (o.calc ? t(" (محسوبة)", " (computed)") : ""),
                  amount: r[p.key]?.[no] ?? 0 });
    }
  }
  for (const [no, ar, en] of SOCE_ROWS) {
    for (const [c, car, cen] of SOCE_COLUMNS) {
      rows.push({ page: t("التغير في حقوق الملكية", "Changes in equity"), line: no, label: `${t(ar, en)} — ${t(car, cen)}`, amount: r.soce?.[no]?.[c] ?? 0 });
    }
  }
  return rows;
}
