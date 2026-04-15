import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerExpenseTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool(
    "freshbooks_list_expenses",
    "List expenses for the FreshBooks account. Supports pagination, search filters, sorting, and includes. Returns expense summaries including amount, vendor, category, and date.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      search_vendor: z.string().optional().describe("Filter by vendor name"),
      search_category_id: z.number().int().optional().describe("Filter by expense category ID"),
      search_date_min: z.string().optional().describe("Filter expenses on or after this date (YYYY-MM-DD)"),
      search_date_max: z.string().optional().describe("Filter expenses on or before this date (YYYY-MM-DD)"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'date', 'amount', 'vendor')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
      includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['category'])"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({
          page: args.page, perPage: args.per_page,
          search: {
            ...(args.search_vendor && { vendor: args.search_vendor }),
            ...(args.search_category_id && { categoryid: args.search_category_id }),
          },
          dateRange: args.search_date_min || args.search_date_max
            ? { key: "date", min: args.search_date_min, max: args.search_date_max } : undefined,
          sortBy: args.sort_by, sortOrder: args.sort_order, includes: args.includes,
        });
        const data = await api.get(api.accountingUrl("expenses/expenses"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed to list expenses: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  server.tool("freshbooks_get_expense", "Get a single expense by ID. Returns full expense details including amount, category, vendor, tax info, and receipt status.",
    { expense_id: z.string().describe("The expense ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`expenses/expenses/${args.expense_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed to get expense: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  server.tool("freshbooks_create_expense", "Create a new expense. Requires a category ID, staff ID, date, and amount. Amounts are strings to preserve decimal precision.",
    {
      category_id: z.number().int().describe("Expense category ID"),
      staff_id: z.number().int().describe("Staff member ID who incurred the expense"),
      date: z.string().describe("Expense date in YYYY-MM-DD format"),
      amount: z.object({ amount: z.string().describe("Expense amount as a string, e.g. '50.00'"), code: z.string().default("USD").describe("Currency code") }).describe("Expense amount as a Money object"),
      vendor: z.string().optional().describe("Vendor name"),
      notes: z.string().optional().describe("Notes about the expense"),
      client_id: z.number().int().optional().describe("Client ID to associate the expense with"),
      project_id: z.number().int().optional().describe("Project ID to associate the expense with"),
      tax_name1: z.string().optional().describe("First tax name, e.g. 'HST'"),
      tax_percent1: z.string().optional().describe("First tax percent as string, e.g. '13'"),
    },
    async (args) => {
      try {
        const expense: Record<string, unknown> = {
          categoryid: args.category_id, staffid: args.staff_id, date: args.date,
          amount: { amount: args.amount.amount, code: args.amount.code },
        };
        if (args.vendor) expense.vendor = args.vendor;
        if (args.notes) expense.notes = args.notes;
        if (args.client_id) expense.clientid = args.client_id;
        if (args.project_id) expense.projectid = args.project_id;
        if (args.tax_name1) expense.taxName1 = args.tax_name1;
        if (args.tax_percent1) expense.taxPercent1 = args.tax_percent1;
        const data = await api.post(api.accountingUrl("expenses/expenses"), { expense });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed to create expense: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  server.tool("freshbooks_update_expense", "Update an existing expense. Only provide the fields you want to change.",
    {
      expense_id: z.string().describe("The expense ID to update"),
      vendor: z.string().optional().describe("Updated vendor name"),
      notes: z.string().optional().describe("Updated notes"),
      category_id: z.number().int().optional().describe("Updated expense category ID"),
      amount: z.object({ amount: z.string().describe("Amount as string"), code: z.string().default("USD").describe("Currency code") }).optional().describe("Updated amount"),
    },
    async (args) => {
      try {
        const expense: Record<string, unknown> = {};
        if (args.vendor !== undefined) expense.vendor = args.vendor;
        if (args.notes !== undefined) expense.notes = args.notes;
        if (args.category_id !== undefined) expense.categoryid = args.category_id;
        if (args.amount !== undefined) expense.amount = { amount: args.amount.amount, code: args.amount.code };
        const data = await api.put(api.accountingUrl(`expenses/expenses/${args.expense_id}`), { expense });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed to update expense: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  server.tool("freshbooks_delete_expense", "Delete an expense by ID (soft delete).",
    { expense_id: z.string().describe("The expense ID to delete") },
    async (args) => {
      try {
        const data = await api.put(api.accountingUrl(`expenses/expenses/${args.expense_id}`), { expense: { vis_state: 1 } });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed to delete expense: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
