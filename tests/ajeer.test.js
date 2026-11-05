import { describe, it, expect } from "vitest";
import { ajeerState, daysLeft, addYears } from "../src/lib/ajeer.js";

const now = "2026-11-06";
describe("Ajeer contract status", () => {
  it("follows the dates", () => {
    expect(ajeerState({ start_date: "2026-12-01", end_date: "2027-03-01" }, now)).toBe("upcoming");
    expect(ajeerState({ start_date: "2026-10-01", end_date: "2027-03-01" }, now)).toBe("active");
    expect(ajeerState({ start_date: "2026-10-01", end_date: "2026-12-06" }, now)).toBe("ending");
    expect(ajeerState({ start_date: "2026-10-01", end_date: "2026-11-06" }, now)).toBe("ending");   // last day still counts
    expect(ajeerState({ start_date: "2026-10-01", end_date: "2026-11-05" }, now)).toBe("ended");
  });
  it("counts days and years on calendar dates", () => {
    expect(daysLeft("2026-11-16", now)).toBe(10);
    expect(addYears("2026-01-01", 3)).toBe("2029-01-01");
    expect(addYears("2028-02-29", 1)).toBe("2029-03-01");
  });
});
