import { describe, it, expect } from "vitest";
import { parseLocalDate } from "../src/date-helpers";

describe("parseLocalDate", () => {
  it("parses a YYYY-MM-DD string to local midnight", () => {
    const d = parseLocalDate("2026-05-20");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May is month index 4
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("does not shift the calendar day (guards the UTC off-by-one bug)", () => {
    // `new Date("2026-01-01")` parses as UTC midnight — which is Dec 31 in any
    // negative-UTC-offset timezone. parseLocalDate must keep the typed date.
    const d = parseLocalDate("2026-01-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});
