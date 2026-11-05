import { describe, it, expect } from "vitest";
import { PAGES, SOCE_ROWS, SOCE_COLUMNS, flatten, plain, fmt } from "../src/lib/qawaem.js";

const t = (ar) => ar;
const lines = (key) => PAGES.find((p) => p.key === key).lines.map((l) => l[0]);

describe("Qawaem layout", () => {
  it("has every platform line, in order", () => {
    expect(lines("bs")).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 32]);
    expect(lines("pl")).toEqual([2, 3, 4, 6, 7, 8, 9, 12, 13, 14, 15, 18, 19, 22, 23]);
    expect(lines("cf").filter((n) => typeof n === "number")).toEqual([4, 5, 6, 7, 8, 10, 11, 12, 15, 16, 17, 20, 21, 22, 23, 24, 27, 28]);
  });

  it("marks only the lines the platform subtracts", () => {
    const red = PAGES.flatMap((p) => p.lines.filter((l) => l[3]?.red).map((l) => `${p.key}${l[0]}`));
    expect(red).toEqual(["cf16", "cf22", "cf23"]);
  });

  it("flattens a report with zeros for missing figures", () => {
    const r = { landing: { revenue: 61455, total_assets: 18224, employees: 0 }, bs: { 2: 11775, 13: 18224 }, pl: {}, oci: {}, cf: {}, soce: {} };
    const rows = flatten(r, t);
    expect(rows.find((x) => x.label.startsWith("النقد وما يعادله")).amount).toBe(11775);
    expect(rows.find((x) => x.label.startsWith("المخزون") || x.label === "مخزون").amount).toBe(0);
    expect(rows.filter((x) => x.page === "التغير في حقوق الملكية")).toHaveLength(SOCE_ROWS.length * SOCE_COLUMNS.length);
  });

  it("formats for pasting and for reading", () => {
    expect(plain(-34091)).toBe("-34091");
    expect(plain(18224.4)).toBe("18224");
    expect(fmt(-31776)).toBe("-31,776");
  });
});
