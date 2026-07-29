import { describe, it, expect } from "vitest";
import { buildQueryBuilders } from "../src/query-helpers";
import {
  reportSearch,
  reportPaymentsCollected,
  reportProfitLoss,
  reportTaxSummary,
  REPORT_PARAMS,
} from "../src/tools/reports";
import { allTools } from "../src/tool-registry";

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
// REPORT_PARAMS (src/report-params.ts) is that matrix as data; this suite locks
// every report tool's schema inside its entry.
describe("REPORT_PARAMS conformance — schema ⊆ honored, schema ∩ ignored = ∅", () => {
  // Args every report tool carries that are not wire params of the report
  // endpoint itself.
  const NON_WIRE_ARGS = new Set(["account", "detail"]);

  for (const [key, spec] of Object.entries(REPORT_PARAMS)) {
    it(`${spec.tool} stays inside the ${key} matrix entry`, () => {
      const registered = allTools.find((t) => t.name === spec.tool);
      expect(registered, `${spec.tool} is in REPORT_PARAMS but not registered`).toBeDefined();
      const args = Object.keys(
        (registered as unknown as { inputSchema: Record<string, unknown> }).inputSchema,
      ).filter((a) => !NON_WIRE_ARGS.has(a));
      for (const arg of args) {
        const wire = spec.argToWire[arg] ?? arg;
        expect(spec.honored, `${spec.tool} offers "${arg}" → wire "${wire}" not in honored`).toContain(wire);
        expect(spec.ignored, `${spec.tool} offers "${arg}" → wire "${wire}" is proven-ignored`).not.toContain(
          wire,
        );
      }
    });
    it(`${key} honored/ignored are disjoint and artifact-backed`, () => {
      expect(spec.honored.filter((h) => spec.ignored.includes(h))).toEqual([]);
      expect(spec.artifact).toBe("downloadToken.params");
      expect(spec.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  }

  it("every registered report tool has a REPORT_PARAMS entry", () => {
    const inMatrix = new Set(Object.values(REPORT_PARAMS).map((s) => s.tool));
    const reportTools = allTools.map((t) => t.name).filter((n) => n.startsWith("freshbooks_report_"));
    expect(reportTools.filter((n) => !inMatrix.has(n))).toEqual([]);
  });
});

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
