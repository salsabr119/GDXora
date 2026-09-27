// Saudi payroll formulas used by the UI (previews, EOSB calculator).
// The database is authoritative (generate_payroll / eosb_amount); these
// mirror it exactly and are covered by the same numbers in tests.

export const GOSI_DEFAULTS = {
  minWage: 1500, maxWage: 45000,
  legacyAnnuity: 9.0, saned: 0.75, hazards: 2.0,
  // annuity % each side for employees under the 2024 Social Insurance Law
  newSchedule: [["2024-07-03", 9.0], ["2025-07-01", 9.5], ["2026-07-01", 10.0], ["2027-07-01", 10.5], ["2028-07-01", 11.0]],
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function annuityRate(scheme, onDate, s = GOSI_DEFAULTS) {
  if (scheme !== "new") return s.legacyAnnuity;
  let rate = s.legacyAnnuity;
  for (const [from, r] of s.newSchedule) if (from <= onDate) rate = r;
  return rate;
}

/** GOSI contributions for one month. */
export function gosi({ basic, housing, isSaudi, registered = true, scheme = "legacy", onDate }, s = GOSI_DEFAULTS) {
  if (!registered) return { wage: 0, employee: 0, employer: 0 };
  const wage = Math.min(Math.max(Number(basic) + Number(housing), s.minWage), s.maxWage);
  const ann = annuityRate(scheme, onDate || new Date().toISOString().slice(0, 10), s);
  return isSaudi
    ? { wage, employee: r2(wage * (ann + s.saned) / 100), employer: r2(wage * (ann + s.saned + s.hazards) / 100) }
    : { wage, employee: 0, employer: r2(wage * s.hazards / 100) };
}

const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;

/**
 * End-of-service award — Labour Law art. 84/85.
 * @param {number} wage  last monthly wage (basic + fixed allowances)
 * @param {string} start hire date (YYYY-MM-DD)
 * @param {string} end   last working day
 * @param {string} reason resignation | employer_termination | contract_end | article_80 | …
 */
export function eosb(wage, start, end, reason) {
  const d = days(start, end);
  if (d <= 0) return { years: 0, full: 0, factor: 0, amount: 0 };
  const years = d / 365;
  const full = years <= 5 ? years * wage / 2 : 5 * wage / 2 + (years - 5) * wage;
  let factor = 1;
  if (reason === "resignation") factor = years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
  else if (reason === "article_80") factor = 0;
  return { years: Math.round(years * 1000) / 1000, full: r2(full), factor, amount: r2(full * factor) };
}
