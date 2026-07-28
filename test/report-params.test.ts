import { describe, it, expect } from "vitest";
import { buildQueryBuilders } from "../src/query-helpers";
import {
  reportSearch,
  reportPaymentsCollected,
  reportProfitLoss,
  reportTaxSummary,
} from "../src/tools/reports";

/** Serialize a search object exactly as the reports endpoints receive it. */
function qs(search: Record<string, string | number | boolean>): string {
  const builders = buildQueryBuilders({ search });
  return (builders[0] as { build: (rt: string) => string }).build("AccountingReportsResource");
}

const schemaKeys = (t: unknown) => Object.keys((t as { inputSchema: object }).inputSchema);

// Which params each report endpoint actually honors was verified on the wire by
// decoding each response's `downloadToken` JWT, whose `params` claim echoes the
// server-side set. Unsupported params are SILENTLY DROPPED (no error, ok:true),
// so offering one on the wrong tool would yield quietly wrong financial numbers.
describe("report parameter support matrix", () => {
  it("profit & loss offers both cash_based and fiscal_year_view", () => {
    const keys = schemaKeys(reportProfitLoss);
    expect(keys).toContain("cash_based");
    expect(keys).toContain("fiscal_year_view");
  });

  it("tax summary offers cash_based", () => {
    expect(schemaKeys(reportTaxSummary)).toContain("cash_based");
  });

  it("tax summary does NOT offer fiscal_year_view (endpoint silently ignores it)", () => {
    expect(schemaKeys(reportTaxSummary)).not.toContain("fiscal_year_view");
  });

  it("payments collected offers neither flag (endpoint supports neither)", () => {
    const keys = schemaKeys(reportPaymentsCollected);
    expect(keys).not.toContain("cash_based");
    expect(keys).not.toContain("fiscal_year_view");
  });
});

describe("reportSearch", () => {
  const base = { start_date: "2026-01-01", end_date: "2026-07-28" };

  it("passes the date range through", () => {
    expect(reportSearch(base)).toEqual(base);
  });

  it("omits a flag that was not set, rather than sending it as false", () => {
    // Sending `cash_based=false` explicitly would silently pin the report to
    // accrual even if FreshBooks changed its server-side default. Omit means omit.
    expect(reportSearch(base, { cash_based: undefined })).toEqual(base);
  });

  it("includes a flag that was set", () => {
    expect(reportSearch(base, { cash_based: true })).toEqual({ ...base, cash_based: true });
  });

  it("includes a flag explicitly set to false", () => {
    expect(reportSearch(base, { cash_based: false })).toEqual({ ...base, cash_based: false });
  });
});

describe("report flag serialization", () => {
  const base = { start_date: "2026-01-01", end_date: "2026-07-28" };

  it("serializes booleans flat, not wrapped in search[]", () => {
    const out = qs(reportSearch(base, { cash_based: true, fiscal_year_view: true }));
    expect(out).toContain("cash_based=true");
    expect(out).toContain("fiscal_year_view=true");
    expect(out).not.toContain("search[");
  });

  it("emits no cash_based key at all when the flag is unset", () => {
    expect(qs(reportSearch(base))).not.toContain("cash_based");
  });
});

// Verified on the wire: `currency_codes[]=USD` -> ["USD"], while both
// `currency_code=USD` and the SDK's own `.in()` output (`search[currency_codes][]=USD`)
// leave the server-side value null — i.e. the filter is silently ignored.
describe("payments collected currency filter", () => {
  const base = { start_date: "2026-01-01", end_date: "2026-07-28" };

  it("serializes the currency filter as the array param the endpoint parses", () => {
    const out = qs(reportSearch(base, { "currency_codes[]": "USD" }));
    expect(out).toContain("currency_codes[]=USD");
  });

  it("does not emit the singular currency_code key the endpoint ignores", () => {
    const out = qs(reportSearch(base, { "currency_codes[]": "USD" }));
    expect(out).not.toMatch(/(^|&)currency_code=/);
  });
});
