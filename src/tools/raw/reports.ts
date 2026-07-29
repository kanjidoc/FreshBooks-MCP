import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import {
  rawRequest,
  renderRaw,
  unwrapEnvelope,
  decodeReportParams,
  RAW_TIER_DESC,
  type RawQueryValue,
} from "../../raw-call";
import { REPORT_PARAMS } from "../../report-params";

/**
 * The six ledger reports the frozen SDK never wrapped. Every param offered
 * here is a transcription of the REPORT_PARAMS evidence artifact
 * (downloadToken.params, probed live 2026-07-28 across every configured
 * profile) — see src/report-params.ts for the doctrine. Params the endpoints
 * parse but whose accepted values are unverified (e.g. expense_details
 * group_by) are deliberately NOT offered; the matrix records them as honored
 * so a future phase can add them once an artifact for their values exists.
 *
 * Raw responses are snake_case (no SDK transform) — the RAW_TIER_DESC marker
 * on every description says so, and test/tool-inventory.test.ts enforces the
 * marker on everything in src/tools/raw/.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const startDate = z.string().regex(DATE_RE, "must be YYYY-MM-DD").describe("Report start date (YYYY-MM-DD)");
const endDate = z.string().regex(DATE_RE, "must be YYYY-MM-DD").describe("Report end date (YYYY-MM-DD)");
const CASH_BASED_DESC =
  "Report on a cash basis (money counted when it moves) instead of the default accrual basis (counted when invoiced/billed).";
const detailParam = z
  .enum(["summary", "full"])
  .default("summary")
  .describe(
    "summary (default) prunes nested sub_accounts[] — every parent row and every total is kept, each pruned array is replaced by sub_accounts_omitted: N (a mid-size report is 60-150KB pretty-printed; summary is ~10x smaller). full returns everything.",
  );

/**
 * summary detail: replace every nested `sub_accounts` array with a count.
 * Parent rows and totals are untouched, so every figure that appears still
 * adds up; only the per-sub-account breakdown is elided.
 */
export function pruneSubAccounts(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneSubAccounts);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "sub_accounts" && Array.isArray(value)) {
      out.sub_accounts_omitted = value.length;
    } else {
      out[key] = pruneSubAccounts(value);
    }
  }
  return out;
}

/**
 * Run one raw report: GET the endpoint, unwrap its envelope, echo the decoded
 * downloadToken params claim as `params_the_server_actually_parsed` (so the
 * model can SEE whether its cash_based:true was honored or dropped), and
 * apply the summary pruning. Never throws (renderRaw catches a throwing shape).
 */
async function runRawReport(
  matrixKey: keyof typeof REPORT_PARAMS,
  query: Record<string, RawQueryValue>,
  detail: "summary" | "full",
) {
  const spec = REPORT_PARAMS[matrixKey];
  const accountId = getAccountId();
  const res = await rawRequest({
    method: "GET",
    path: `/accounting/account/${accountId}/reports/accounting/${spec.path}`,
    query,
    name: spec.tool,
  });
  return renderRaw(res, (data) => {
    const { value, result } = unwrapEnvelope<Record<string, unknown>>(data, spec.envelope_key, "object");
    // The token rides INSIDE the report payload (verified live 2026-07-29);
    // the result-level fallback covers a future move. Decode its params claim,
    // then STRIP the raw JWT from the output — the decoded echo is the useful
    // part, the token itself is auth-shaped noise. A null echo would silently
    // remove the filter-verification evidence, so the two null causes are
    // named instead.
    const rawToken = value.download_token ?? (result as { download_token?: unknown }).download_token;
    const params = decodeReportParams(rawToken);
    const { download_token: _token, ...report } = value;
    return {
      params_the_server_actually_parsed:
        params ??
        (rawToken === undefined
          ? "UNAVAILABLE: response carried no download_token"
          : "UNAVAILABLE: download_token present but undecodable"),
      report: detail === "summary" ? pruneSubAccounts(report) : report,
    };
  });
}

const rawError = (label: string, error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

export const reportBalanceSheet = tool(
  "freshbooks_report_balance_sheet",
  `Generate a balance sheet as of a date. Answers "what do we own and owe, and what is the equity?". QUIRK: this endpoint ignores start_date/end_date entirely — it is a point-in-time statement; use as_of_date (and compare_to for prior-period columns). ${RAW_TIER_DESC}`,
  {
    as_of_date: z
      .string()
      .regex(DATE_RE, "must be YYYY-MM-DD")
      .describe("The statement date (YYYY-MM-DD) — the report shows balances as of this day"),
    compare_to: z
      .array(z.string().regex(DATE_RE, "must be YYYY-MM-DD"))
      .max(3)
      .optional()
      .describe("Up to 3 additional statement dates; each adds a comparative column"),
    cash_based: z.boolean().optional().describe(CASH_BASED_DESC),
    currency_code: z.string().optional().describe("Report currency (e.g. 'USD')"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport(
        "balance_sheet",
        {
          "dates[]": [args.as_of_date, ...(args.compare_to ?? [])],
          cash_based: args.cash_based,
          currency_code: args.currency_code,
        },
        args.detail,
      );
    } catch (error) {
      return rawError("Failed to generate balance sheet", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const reportGeneralLedger = tool(
  "freshbooks_report_general_ledger",
  `Generate the general ledger for a date range. Answers "every debit and credit, account by account" — the full transaction-level ledger. Sub-account IDs here join freshbooks_list_journal_entry_accounts via subAccounts[].subAccountId. ${RAW_TIER_DESC}`,
  {
    start_date: startDate,
    end_date: endDate,
    accountid: z.number().int().optional().describe("Filter to one GL account id"),
    subaccountid: z.number().int().optional().describe("Filter to one sub-account id"),
    categoryid: z.number().int().optional().describe("Filter to one category id"),
    group_by_category_id: z.boolean().optional().describe("Group rows by category id"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport(
        "general_ledger",
        {
          start_date: args.start_date,
          end_date: args.end_date,
          accountid: args.accountid,
          subaccountid: args.subaccountid,
          categoryid: args.categoryid,
          group_by_category_id: args.group_by_category_id,
        },
        args.detail,
      );
    } catch (error) {
      return rawError("Failed to generate general ledger", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const reportCashFlow = tool(
  "freshbooks_report_cash_flow",
  `Generate a cash flow report for a date range. Answers "where did cash come from and go?". QUIRK: this endpoint ignores cash_based — cash flow is inherently cash-based, so the flag is not offered. ${RAW_TIER_DESC}`,
  {
    start_date: startDate,
    end_date: endDate,
    currency_code: z.string().optional().describe("Report currency (e.g. 'USD')"),
    group_by_category_id: z.boolean().optional().describe("Group rows by category id"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport(
        "cash_flow",
        {
          start_date: args.start_date,
          end_date: args.end_date,
          currency_code: args.currency_code,
          group_by_category_id: args.group_by_category_id,
        },
        args.detail,
      );
    } catch (error) {
      return rawError("Failed to generate cash flow report", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const reportAccountsAging = tool(
  "freshbooks_report_accounts_aging",
  `Generate the accounts-receivable aging as of a date. Answers "who owes us, and how overdue are they?" (0-30/31-60/... buckets). QUIRK: the endpoint ignores start_date and clientids[] — only end_date is honored; totals should tie to unpaid invoices from freshbooks_list_invoices. ${RAW_TIER_DESC}`,
  {
    end_date: z
      .string()
      .regex(DATE_RE, "must be YYYY-MM-DD")
      .describe("The as-of date (YYYY-MM-DD) for the aging buckets"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport("accounts_aging", { end_date: args.end_date }, args.detail);
    } catch (error) {
      return rawError("Failed to generate accounts aging report", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const reportExpenseDetails = tool(
  "freshbooks_report_expense_details",
  `Generate the expense details report for a date range. Answers "every expense, line by line, with vendor and category" — ties to freshbooks_report_profit_loss over the same range AND basis. ${RAW_TIER_DESC}`,
  {
    start_date: startDate,
    end_date: endDate,
    exclude_personal: z.boolean().optional().describe("Exclude personal (non-business) expenses"),
    include_project: z.boolean().optional().describe("Include project expense detail"),
    client_id: z.number().int().optional().describe("Filter to one client id"),
    project_id: z.number().int().optional().describe("Filter to one project id"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport(
        "expense_details",
        {
          start_date: args.start_date,
          end_date: args.end_date,
          exclude_personal: args.exclude_personal,
          include_project: args.include_project,
          client_id: args.client_id,
          project_id: args.project_id,
        },
        args.detail,
      );
    } catch (error) {
      return rawError("Failed to generate expense details report", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const reportTrialBalance = tool(
  "freshbooks_report_trial_balance",
  `Generate the trial balance for a date range. Answers "does the ledger balance?" — every account's debit and credit totals; the two columns must be equal. ${RAW_TIER_DESC}`,
  {
    start_date: startDate,
    end_date: endDate,
    currency_code: z.string().optional().describe("Report currency (e.g. 'USD')"),
    group_by_category_id: z.boolean().optional().describe("Group rows by category id"),
    detail: detailParam,
  },
  async (args) => {
    try {
      return await runRawReport(
        "trial_balance",
        {
          start_date: args.start_date,
          end_date: args.end_date,
          currency_code: args.currency_code,
          group_by_category_id: args.group_by_category_id,
        },
        args.detail,
      );
    } catch (error) {
      return rawError("Failed to generate trial balance", error);
    }
  },
  { annotations: { readOnlyHint: true } },
);
