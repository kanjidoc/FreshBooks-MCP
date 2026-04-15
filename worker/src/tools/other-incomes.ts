import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerOtherIncomeTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_other_incomes", "List other income records. Supports pagination and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'date', 'amount')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order });
        const data = await api.get(api.accountingUrl("other_incomes/other_incomes"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list other incomes: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_other_income", "Get a single other income record by ID.",
    { other_income_id: z.string().describe("The other income ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`other_incomes/other_incomes/${args.other_income_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get other income: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_other_income", "Create a new other income record for income outside of invoices.",
    {
      source: z.string().describe("Income source description"),
      amount: z.object({ amount: z.string().describe("Amount as string"), code: z.string().default("USD").describe("Currency code") }).describe("Income amount"),
      date: z.string().describe("Income date in YYYY-MM-DD format"),
      category_name: z.string().optional().describe("Income category name"),
      note: z.string().optional().describe("Optional note"),
    },
    async (args) => {
      try {
        const other_income: Record<string, unknown> = { source: args.source, amount: { amount: args.amount.amount, code: args.amount.code }, date: args.date };
        if (args.category_name !== undefined) other_income.category_name = args.category_name;
        if (args.note !== undefined) other_income.note = args.note;
        const data = await api.post(api.accountingUrl("other_incomes/other_incomes"), { other_income });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create other income: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_other_income", "Update an existing other income record.",
    {
      other_income_id: z.string().describe("The other income ID to update"),
      source: z.string().optional().describe("Updated source"),
      note: z.string().optional().describe("Updated note"),
      category_name: z.string().optional().describe("Updated category name"),
    },
    async (args) => {
      try {
        const other_income: Record<string, unknown> = {};
        if (args.source !== undefined) other_income.source = args.source;
        if (args.note !== undefined) other_income.note = args.note;
        if (args.category_name !== undefined) other_income.category_name = args.category_name;
        const data = await api.put(api.accountingUrl(`other_incomes/other_incomes/${args.other_income_id}`), { other_income });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update other income: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_other_income", "Delete an other income record by ID (soft delete).",
    { other_income_id: z.string().describe("The other income ID to delete") },
    async (args) => {
      try {
        const data = await api.put(api.accountingUrl(`other_incomes/other_incomes/${args.other_income_id}`), { other_income: { vis_state: 1 } });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete other income: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
