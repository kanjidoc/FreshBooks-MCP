import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

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

      const queryBuilders = buildQueryBuilders({
        dateRange: { key: "date", min: args.start_date, max: args.end_date },
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
  "Generate a profit and loss report for a given date range. Returns income, expenses, and net profit/loss totals.",
  {
    start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
    end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        dateRange: { key: "date", min: args.start_date, max: args.end_date },
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
  "Generate a tax summary report for a given date range. Returns tax collected and paid totals by tax name.",
  {
    start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
    end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        dateRange: { key: "date", min: args.start_date, max: args.end_date },
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
