import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerExpenseCategoryTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_expense_categories", "List expense categories. Supports pagination and sorting. Read-only.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'category')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order });
        const data = await api.get(api.accountingUrl("expenses/categories"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list expense categories: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_expense_category", "Get a single expense category by ID. Read-only.",
    { category_id: z.string().describe("The expense category ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`expenses/categories/${args.category_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get expense category: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
