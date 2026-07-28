import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

/**
 * Build the search params for a report request: the date range, plus any
 * optional flags the caller actually set.
 *
 * A flag left `undefined` is omitted entirely rather than sent as `false`.
 * The report endpoints silently drop unknown/unsupported params — they return
 * `ok: true` with no error — so an explicit `false` is indistinguishable from
 * an omission today, but would pin the report to a stale default if FreshBooks
 * ever changes the server-side one. Omit means omit.
 *
 * Exported for tests: it is the single place the wire-level param names live.
 */
export function reportSearch(
  base: { start_date: string; end_date: string },
  flags: Record<string, string | number | boolean | undefined> = {},
): Record<string, string | number | boolean> {
  const search: Record<string, string | number | boolean> = { ...base };
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) search[key] = value;
  }
  return search;
}

/**
 * Which optional params each report honors, verified on the wire by decoding
 * each response's `downloadToken` JWT (its `params` claim echoes the set the
 * server actually parsed):
 *
 *   profitloss          start_date end_date cash_based fiscal_year_view
 *                       currency_code resolution group_by_account
 *                       group_by_category_id report_mode
 *   taxsummary          start_date end_date cash_based currency_code
 *   payments_collected  start_date end_date currency_codes[] clientids[]
 *                       payment_methods[] payment_for
 *
 * Do not offer a param on a report that does not list it — the endpoint will
 * accept the request and quietly ignore the filter, producing wrong numbers
 * with no error.
 */

const CASH_BASED_DESC =
  "Report on a cash basis (income/expenses counted when money moves) instead of the default accrual basis (counted when invoiced/billed). Affects which transactions are included.";

export const reportPaymentsCollected = tool(
  "freshbooks_report_payments_collected",
  "Generate a payments collected report for a given date range. Returns totals of payments received by currency and payment method.",
  {
    start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
    end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
    currency_code: z.string().optional().describe("Filter by currency code (e.g. 'USD', 'CAD')"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      // The endpoint parses this filter as the array param `currency_codes[]`.
      // The singular `currency_code` is silently ignored (verified on the wire),
      // so the tool's own arg name is kept while the wire key is corrected.
      const queryBuilders = buildQueryBuilders({
        search: reportSearch(
          { start_date: args.start_date, end_date: args.end_date },
          { "currency_codes[]": args.currency_code },
        ),
      });

      const response = await client.reports.paymentsCollected(accountId, queryBuilders);

      if (!response.ok) {
        return {
          content: [{ type: "text" as const, text: `FreshBooks error: ${response.error?.message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to generate payments collected report: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const reportProfitLoss = tool(
  "freshbooks_report_profit_loss",
  "Generate a profit and loss report for a given date range. Returns income, expenses, and net profit/loss totals. Supports cash-basis and fiscal-year reporting.",
  {
    start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
    end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
    cash_based: z.boolean().optional().describe(CASH_BASED_DESC),
    fiscal_year_view: z
      .boolean()
      .optional()
      .describe(
        "Align the report to the account's configured fiscal year instead of the calendar year.",
      ),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        search: reportSearch(
          { start_date: args.start_date, end_date: args.end_date },
          { cash_based: args.cash_based, fiscal_year_view: args.fiscal_year_view },
        ),
      });

      const response = await client.reports.profitLoss(accountId, queryBuilders);

      if (!response.ok) {
        return {
          content: [{ type: "text" as const, text: `FreshBooks error: ${response.error?.message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to generate profit and loss report: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const reportTaxSummary = tool(
  "freshbooks_report_tax_summary",
  "Generate a tax summary report for a given date range. Returns tax collected and paid totals by tax name. Supports cash-basis reporting.",
  {
    start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
    end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
    // No fiscal_year_view here: the taxsummary endpoint does not parse it and
    // would silently ignore it, implying a filter that never applied.
    cash_based: z.boolean().optional().describe(CASH_BASED_DESC),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        search: reportSearch(
          { start_date: args.start_date, end_date: args.end_date },
          { cash_based: args.cash_based },
        ),
      });

      const response = await client.reports.taxSummary(accountId, queryBuilders);

      if (!response.ok) {
        return {
          content: [{ type: "text" as const, text: `FreshBooks error: ${response.error?.message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to generate tax summary report: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);
