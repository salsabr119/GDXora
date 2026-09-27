// Formatting & small validators shared across screens.

export function money(n, lang = "ar", currency = "SAR") {
  const v = Number(n || 0);
  return new Intl.NumberFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-SA", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(v) + (currency ? ` ${currency === "SAR" ? (lang === "ar" ? "ر.س" : "SAR") : currency}` : "");
}

export const num = (n, d = 2) => Number(n || 0).toFixed(d);

export function date(d, lang = "ar") {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB",
      { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
  } catch { return String(d); }
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Saudi VAT number: 15 digits, starts and ends with 3 */
export const isVatNumber = (v) => /^3\d{13}3$/.test(String(v || ""));
/** Saudi IBAN: SA + 22 digits */
export const isSaIban = (v) => /^SA\d{22}$/.test(String(v || "").replace(/\s/g, ""));

/** CSV with UTF-8 BOM so Excel opens Arabic correctly */
export function downloadCsv(filename, rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === "function" ? c.value(r) : r[c.key])).join(",")).join("\n");
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
