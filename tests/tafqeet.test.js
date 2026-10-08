import { describe, it, expect } from "vitest";
import { numberToArabicWords as w, amountInArabicWords } from "../src/lib/tafqeet.js";

describe("Arabic amount in words", () => {
  it.each([
    [1, "واحد"], [11, "أحد عشر"], [12, "اثنا عشر"], [21, "واحد وعشرون"], [100, "مائة"], [150, "مائة وخمسون"],
    [200, "مائتان"], [1000, "ألف"], [2000, "ألفان"], [3000, "ثلاثة آلاف"], [11000, "أحد عشر ألف"],
    [1150, "ألف ومائة وخمسون"], [39100, "تسعة وثلاثون ألف ومائة"], [1000000, "مليون"], [2500000, "مليونان وخمسمائة ألف"],
  ])("%i → %s", (n, s) => expect(w(n)).toBe(s));

  it("formats SAR with halalas", () => {
    expect(amountInArabicWords(1150)).toBe("فقط ألف ومائة وخمسون ريال سعودي لا غير");
    expect(amountInArabicWords(227700.5)).toBe("فقط مائتان وسبعة وعشرون ألف وسبعمائة ريال سعودي وخمسون هللة لا غير");
    expect(amountInArabicWords(0.25)).toBe("فقط صفر ريال سعودي وخمسة وعشرون هللة لا غير");
  });
});
