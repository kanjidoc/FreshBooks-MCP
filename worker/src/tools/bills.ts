import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerBillTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_bills", "List bills. Supports pagination, sorting, and includes.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'due_date', 'amount', 'bill_number')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
      includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['lines', 'vendor'])"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order, includes: args.includes });
        const data = await api.get(api.accountingUrl("bills/bills"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list bills: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_bill", "Get a single bill by ID.",
    { bill_id: z.string().describe("The bill ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`bills/bills/${args.bill_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get bill: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_bill", "Create a new bill. Requires a vendor ID and line items.",
    {
      vendor_id: z.number().int().describe("The bill vendor ID"),
      lines: z.array(z.object({
        description: z.string().describe("Line item description"),
        amount: z.string().describe("Line item amount as a string, e.g. '100.00'"),
        category: z.string().optional().describe("Expense category"),
        quantity: z.number().default(1).describe("Quantity"),
      })).describe("Bill line items"),
      due_date: z.string().describe("Bill due date in YYYY-MM-DD format"),
      currency_code: z.string().default("USD").describe("Currency code"),
    },
    async (args) => {
      try {
        const bill = {
          vendorid: args.vendor_id,
          lines: args.lines.map((l) => ({
            description: l.description, amount: { amount: l.amount, code: args.currency_code },
            category: l.category, quantity: l.quantity,
          })),
          due_date: args.due_date, currency_code: args.currency_code,
        };
        const data = await api.post(api.accountingUrl("bills/bills"), { bill });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create bill: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_bill", "Delete a bill by ID.",
    { bill_id: z.string().describe("The bill ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.accountingUrl(`bills/bills/${args.bill_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete bill: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
