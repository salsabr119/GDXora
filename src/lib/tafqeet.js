// Amount in Arabic words for documents: «فقط ألف ومائة وخمسون ريالاً سعودياً لا غير».
const ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const TEENS = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
// [singular, dual, plural (3–10)]
const SCALES = [null, ["ألف", "ألفان", "آلاف"], ["مليون", "مليونان", "ملايين"], ["مليار", "ملياران", "مليارات"]];

function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100, parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r >= 20) parts.push(r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)]);
  else if (r >= 10) parts.push(TEENS[r - 10]);
  else if (r) parts.push(ONES[r]);
  return parts.join(" و");
}

export function numberToArabicWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return "صفر";
  const groups = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (!g) continue;
    if (i === 0) { groups.unshift(below1000(g)); continue; }
    const [one, two, many] = SCALES[i];
    groups.unshift(g === 1 ? one : g === 2 ? two : g <= 10 ? `${below1000(g)} ${many}` : `${below1000(g)} ${one}`);
  }
  return groups.join(" و");
}

/** «فقط … ريال سعودي و… هللة لا غير» */
export function amountInArabicWords(amount, currency = "ريال سعودي", sub = "هللة") {
  const v = Math.round(Math.abs(Number(amount) || 0) * 100);
  const whole = Math.floor(v / 100), frac = v % 100;
  let s = `فقط ${numberToArabicWords(whole)} ${currency}`;
  if (frac) s += ` و${numberToArabicWords(frac)} ${sub}`;
  return `${s} لا غير`;
}
