import { describe, it, expect } from "vitest";
import { buildQueryBuilders } from "../src/query-helpers";

describe("buildQueryBuilders", () => {
  it("returns an empty array when given no options", () => {
    expect(buildQueryBuilders({})).toEqual([]);
  });

  it("builds a pagination builder from page/perPage", () => {
    expect(buildQueryBuilders({ page: 2, perPage: 10 })).toHaveLength(1);
  });

  it("emits flat search params (guards the reports date-range fix)", () => {
    // The reports fix relies on `search` equals-params serializing to plain
    // `&key=value` on non-accounting resource types — not `search[key]=value`.
    const builders = buildQueryBuilders({
      search: { start_date: "2024-01-01", end_date: "2026-05-21" },
    });
    expect(builders).toHaveLength(1);

    const queryString = (builders[0] as { build: (rt: string) => string }).build(
      "AccountingReportsResource",
    );
    expect(queryString).toContain("start_date=2024-01-01");
    expect(queryString).toContain("end_date=2026-05-21");
    expect(queryString).not.toContain("search[");
  });
});
