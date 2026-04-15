import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerReportTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_report_payments_collected", "Generate a payments collected report for a date range.",
    {
      start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
      end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
      currency_code: z.string().optional().describe("Filter by currency code (e.g. 'USD', 'CAD')"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ dateRange: { key: "date", min: args.start_date, max: args.end_date } });
        const data = await api.get(api.accountingUrl("reports/accounting/payments_collected"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to generate payments collected report: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_report_profit_loss", "Generate a profit and loss report for a date range.",
    {
      start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
      end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ dateRange: { key: "date", min: args.start_date, max: args.end_date } });
        const data = await api.get(api.accountingUrl("reports/accounting/profitloss"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to generate profit and loss report: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_report_tax_summary", "Generate a tax summary report for a date range.",
    {
      start_date: z.string().describe("Report start date in YYYY-MM-DD format"),
      end_date: z.string().describe("Report end date in YYYY-MM-DD format"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ dateRange: { key: "date", min: args.start_date, max: args.end_date } });
        const data = await api.get(api.accountingUrl("reports/accounting/taxsummary"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to generate tax summary report: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
