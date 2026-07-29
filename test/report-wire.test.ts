import { describe, it, expect } from "vitest";
import type { Client } from "@freshbooks/api";
import { runInProfile, type ProfileState } from "../src/profiles";
import { REPORT_PARAMS } from "../src/report-params";
import {
  reportBalanceSheet,
  reportGeneralLedger,
  reportCashFlow,
  reportAccountsAging,
  reportExpenseDetails,
  reportTrialBalance,
} from "../src/tools/raw/reports";
import { reportPaymentsCollected, reportProfitLoss, reportTaxSummary } from "../src/tools/reports";

/**
 * WIRE-EMISSION sweep — the schema-vs-matrix conformance suite checks what a
 * tool OFFERS; this one checks what its handler actually SENDS. The repo's
 * #1 shipped bug class is a handler emitting a key the endpoint silently
 * drops (ok:true, unfiltered numbers), and a handler-level respelling leaves
 * every schema test green. Every report tool is invoked with EVERY schema
 * arg populated; each emitted query key must be in its REPORT_PARAMS
 * `honored` list.
 */

type HandlerTool = { name: string; handler: (a: any, e: any) => Promise<any> };

/** Args that exercise every schema field of each raw report tool. */
const RAW_FIXTURES: Record<string, { tool: HandlerTool; args: Record<string, unknown> }> = {
  balance_sheet: {
    tool: reportBalanceSheet,
    args: {
      as_of_date: "2026-06-30",
      compare_to: ["2025-06-30"],
      cash_based: true,
      currency_code: "USD",
      detail: "full",
    },
  },
  general_ledger: {
    tool: reportGeneralLedger,
    args: {
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      accountid: 5,
      subaccountid: 6,
      categoryid: 7,
      group_by_category_id: true,
      detail: "full",
    },
  },
  cash_flow: {
    tool: reportCashFlow,
    args: {
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      currency_code: "USD",
      group_by_category_id: true,
      detail: "full",
    },
  },
  accounts_aging: {
    tool: reportAccountsAging,
    args: { end_date: "2026-06-30", detail: "full" },
  },
  expense_details: {
    tool: reportExpenseDetails,
    args: {
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      exclude_personal: true,
      include_project: true,
      client_id: 8,
      project_id: 9,
      detail: "full",
    },
  },
  trial_balance: {
    tool: reportTrialBalance,
    args: {
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      currency_code: "USD",
      group_by_category_id: true,
      detail: "full",
    },
  },
};

function urlCapturingProfile(envelopeKey: string, urls: string[]): ProfileState {
  const call = async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
    urls.push(url);
    return { ok: true, data: { response: { result: { [envelopeKey]: {} } } } };
  };
  return {
    name: "test",
    filePath: "/nonexistent/test.env",
    config: { accessToken: "a", refreshToken: "r", accountId: "ACC123", businessId: "" },
    client: { call } as unknown as Client,
    refreshInFlight: null,
  };
}

describe("raw report handlers emit ONLY honored wire keys", () => {
  for (const [matrixKey, { tool, args }] of Object.entries(RAW_FIXTURES)) {
    const spec = REPORT_PARAMS[matrixKey];
    it(`${spec.tool} (all args populated)`, async () => {
      const urls: string[] = [];
      const res = await runInProfile(urlCapturingProfile(spec.envelope_key, urls), () =>
        tool.handler(args, {}),
      );
      expect((res as { isError?: boolean }).isError, JSON.stringify(res)).toBeUndefined();
      expect(urls).toHaveLength(1);
      const url = new URL(`http://x${urls[0]}`);
      expect(url.pathname).toBe(`/accounting/account/ACC123/reports/accounting/${spec.path}`);
      const emittedKeys = [...new Set([...url.searchParams.keys()])];
      for (const key of emittedKeys) {
        expect(spec.honored, `${spec.tool} emitted "${key}" which is not honored`).toContain(key);
        expect(spec.ignored, `${spec.tool} emitted proven-ignored "${key}"`).not.toContain(key);
      }
      // every non-detail schema arg must actually reach the wire under its mapped key
      for (const arg of Object.keys(args)) {
        if (arg === "detail") continue;
        const wire = spec.argToWire[arg] ?? arg;
        expect(emittedKeys, `${spec.tool} arg "${arg}" never emitted as "${wire}"`).toContain(wire);
      }
    });
  }
});

describe("SDK-backed report handlers emit only honored wire keys", () => {
  /** Fake the SDK reports resource; serialize builders the way the SDK does. */
  function sdkReportProfile(captured: string[]): ProfileState {
    const serialize = (builders?: Array<{ build: (rt: string) => string }>) =>
      captured.push((builders ?? []).map((b) => b.build("AccountingReportsResource")).join("&"));
    const client = {
      reports: {
        paymentsCollected: async (_a: string, qb?: any[]) => (serialize(qb), { ok: true, data: {} }),
        profitLoss: async (_a: string, qb?: any[]) => (serialize(qb), { ok: true, data: {} }),
        taxSummary: async (_a: string, qb?: any[]) => (serialize(qb), { ok: true, data: {} }),
      },
    };
    return {
      name: "test",
      filePath: "/nonexistent/test.env",
      config: { accessToken: "a", refreshToken: "r", accountId: "ACC123", businessId: "" },
      client: client as unknown as Client,
      refreshInFlight: null,
    };
  }

  const CASES: Array<[string, HandlerTool, Record<string, unknown>]> = [
    [
      "payments_collected",
      reportPaymentsCollected,
      { start_date: "2026-01-01", end_date: "2026-06-30", currency_code: "USD" },
    ],
    [
      "profitloss",
      reportProfitLoss,
      { start_date: "2026-01-01", end_date: "2026-06-30", cash_based: true, fiscal_year_view: true },
    ],
    ["taxsummary", reportTaxSummary, { start_date: "2026-01-01", end_date: "2026-06-30", cash_based: true }],
  ];

  for (const [matrixKey, tool, args] of CASES) {
    const spec = REPORT_PARAMS[matrixKey];
    it(`${spec.tool} (all args populated)`, async () => {
      const captured: string[] = [];
      const res = await runInProfile(sdkReportProfile(captured), () => tool.handler(args, {}));
      expect((res as { isError?: boolean }).isError).toBeUndefined();
      expect(captured).toHaveLength(1);
      const emittedKeys = captured[0]
        .replace(/^&|&$/g, "")
        .split("&")
        .filter(Boolean)
        .map((kv) => decodeURIComponent(kv.split("=")[0]));
      for (const key of new Set(emittedKeys)) {
        expect(spec.honored, `${spec.tool} emitted "${key}" which is not honored`).toContain(key);
        expect(spec.ignored, `${spec.tool} emitted proven-ignored "${key}"`).not.toContain(key);
      }
      // the historically-shipped bug: currency_code must reach the wire as currency_codes[]
      for (const arg of Object.keys(args)) {
        const wire = spec.argToWire[arg] ?? arg;
        expect(emittedKeys, `${spec.tool} arg "${arg}" never emitted as "${wire}"`).toContain(wire);
      }
    });
  }
});
