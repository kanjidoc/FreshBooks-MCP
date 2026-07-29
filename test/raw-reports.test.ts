import { describe, it, expect } from "vitest";
import type { Client } from "@freshbooks/api";
import { runInProfile, type ProfileState } from "../src/profiles";
import { pruneSubAccounts, reportBalanceSheet, reportAccountsAging, reportTrialBalance } from "../src/tools/raw/reports";

/** T2 fake: capture the URL, serve a canned raw report envelope. The download
 * token rides INSIDE the report payload, as the live API does (verified
 * 2026-07-29). */
function reportProfile(envelopeKey: string, report: unknown, urls: string[], downloadToken?: string): ProfileState {
  const call = async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
    urls.push(url);
    return {
      ok: true,
      data: {
        response: {
          result: {
            [envelopeKey]: {
              ...(report as Record<string, unknown>),
              ...(downloadToken ? { download_token: downloadToken } : {}),
            },
          },
        },
      },
    };
  };
  return {
    name: "test",
    filePath: "/nonexistent/test.env",
    config: { accessToken: "a", refreshToken: "r", accountId: "ACC123", businessId: "" },
    client: { call } as unknown as Client,
    refreshInFlight: null,
  };
}

const token = (params: unknown) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ params })).toString("base64url")}.s`;

const textOf = (res: { content: Array<{ type: string }> }): string => {
  const c = res.content[0] as { text?: string };
  if (typeof c.text !== "string") throw new Error("no text content");
  return c.text;
};

describe("pruneSubAccounts", () => {
  it("replaces every nested sub_accounts array with a count, keeps parents and totals", () => {
    const input = {
      total: { amount: "100.00", code: "USD" },
      accounts: [
        { name: "Equity", sub_accounts: [{ a: 1 }, { a: 2 }], balance: "50.00" },
        { name: "Cash", sub_accounts: [], nested: { sub_accounts: [{ b: 1 }] } },
      ],
    };
    expect(pruneSubAccounts(input)).toEqual({
      total: { amount: "100.00", code: "USD" },
      accounts: [
        { name: "Equity", sub_accounts_omitted: 2, balance: "50.00" },
        { name: "Cash", sub_accounts_omitted: 0, nested: { sub_accounts_omitted: 1 } },
      ],
    });
  });
  it("passes primitives and non-matching shapes through untouched", () => {
    expect(pruneSubAccounts(null)).toBeNull();
    expect(pruneSubAccounts([1, "x"])).toEqual([1, "x"]);
    expect(pruneSubAccounts({ sub_accounts: "not-an-array" })).toEqual({ sub_accounts: "not-an-array" });
  });
});

describe("raw report wire format (T1 — the historically shipped bug class)", () => {
  it("balance sheet: as_of_date + compare_to emit as REPEATED dates[] keys; range params never sent", async () => {
    const urls: string[] = [];
    const res = await runInProfile(reportProfile("balance_sheet", { assets: [] }, urls), () =>
      reportBalanceSheet.handler(
        { as_of_date: "2026-06-30", compare_to: ["2025-06-30"], cash_based: true, detail: "full" } as any,
        {},
      ),
    );
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(urls).toHaveLength(1);
    const url = urls[0];
    expect(url).toContain("/accounting/account/ACC123/reports/accounting/balance_sheet?");
    expect(url).toContain("dates%5B%5D=2026-06-30");
    expect(url).toContain("dates%5B%5D=2025-06-30");
    expect(url).toContain("cash_based=true");
    expect(url).not.toContain("start_date");
    expect(url).not.toContain("end_date");
  });

  it("accounts aging sends ONLY end_date (start_date/clientids are proven-ignored)", async () => {
    const urls: string[] = [];
    await runInProfile(reportProfile("accounts_aging", {}, urls), () =>
      reportAccountsAging.handler({ end_date: "2026-06-30", detail: "full" } as any, {}),
    );
    expect(urls[0]).toBe("/accounting/account/ACC123/reports/accounting/accounts_aging?end_date=2026-06-30");
  });

  it("an unset optional flag is omitted from the query entirely, never sent as false", async () => {
    const urls: string[] = [];
    await runInProfile(reportProfile("trial_balance", {}, urls), () =>
      reportTrialBalance.handler({ start_date: "2026-01-01", end_date: "2026-06-30", detail: "full" } as any, {}),
    );
    expect(urls[0]).not.toContain("group_by_category_id");
    expect(urls[0]).not.toContain("currency_code");
  });
});

describe("raw report output shaping", () => {
  it("echoes params_the_server_actually_parsed from the download token, and strips the raw JWT", async () => {
    const urls: string[] = [];
    const res = await runInProfile(
      reportProfile("trial_balance", { rows: [] }, urls, token({ start_date: "2026-01-01", cash_based: null })),
      () => reportTrialBalance.handler({ start_date: "2026-01-01", end_date: "2026-06-30", detail: "full" } as any, {}),
    );
    const parsed = JSON.parse(textOf(res as any));
    expect(parsed.params_the_server_actually_parsed).toEqual({ start_date: "2026-01-01", cash_based: null });
    expect(parsed.report).toEqual({ rows: [] }); // download_token stripped, not rendered
  });

  it("detail=summary prunes sub_accounts; detail=full keeps them", async () => {
    const report = { accounts: [{ name: "Equity", sub_accounts: [{ id: 1 }, { id: 2 }] }] };
    const run = (detail: string) =>
      runInProfile(reportProfile("balance_sheet", report, []), () =>
        reportBalanceSheet.handler({ as_of_date: "2026-06-30", detail } as any, {}),
      );
    const summary = JSON.parse(textOf((await run("summary")) as any));
    expect(summary.report.accounts[0].sub_accounts_omitted).toBe(2);
    const full = JSON.parse(textOf((await run("full")) as any));
    expect(full.report.accounts[0].sub_accounts).toHaveLength(2);
  });

  it("a drifted envelope (wrong key) renders as isError drift, never a throw", async () => {
    const res = await runInProfile(reportProfile("wrong_key", {}, []), () =>
      reportBalanceSheet.handler({ as_of_date: "2026-06-30", detail: "summary" } as any, {}),
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as any)).toMatch(/Envelope drift/);
  });
});
