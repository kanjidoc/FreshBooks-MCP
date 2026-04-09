import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listExpenses = tool(
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
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        search: {
          ...(args.search_vendor && { vendor: args.search_vendor }),
          ...(args.search_category_id && { categoryid: args.search_category_id }),
        },
        dateRange: args.search_date_min || args.search_date_max
          ? { key: "date", min: args.search_date_min, max: args.search_date_max }
          : undefined,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
        includes: args.includes,
      });

      const response = await client.expenses.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list expenses: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getExpense = tool(
  "freshbooks_get_expense",
  "Get a single expense by ID. Returns full expense details including amount, category, vendor, tax info, and receipt status.",
  {
    expense_id: z.string().describe("The expense ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.expenses.single(accountId, args.expense_id);

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
        content: [{ type: "text" as const, text: `Failed to get expense: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createExpense = tool(
  "freshbooks_create_expense",
  "Create a new expense. Requires a category ID, staff ID, date, and amount. Amounts are strings to preserve decimal precision.",
  {
    category_id: z.number().int().describe("Expense category ID"),
    staff_id: z.number().int().describe("Staff member ID who incurred the expense"),
    date: z.string().describe("Expense date in YYYY-MM-DD format"),
    amount: z.object({
      amount: z.string().describe("Expense amount as a string, e.g. '50.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).describe("Expense amount as a Money object"),
    vendor: z.string().optional().describe("Vendor name"),
    notes: z.string().optional().describe("Notes about the expense"),
    client_id: z.number().int().optional().describe("Client ID to associate the expense with"),
    project_id: z.number().int().optional().describe("Project ID to associate the expense with"),
    tax_name1: z.string().optional().describe("First tax name, e.g. 'HST'"),
    tax_percent1: z.string().optional().describe("First tax percent as string, e.g. '13'"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const expenseData: Record<string, unknown> = {
        categoryId: args.category_id,
        staffId: args.staff_id,
        date: new Date(args.date),
        amount: { amount: args.amount.amount, code: args.amount.code },
      };
      if (args.vendor) expenseData.vendor = args.vendor;
      if (args.notes) expenseData.notes = args.notes;
      if (args.client_id) expenseData.clientId = args.client_id;
      if (args.project_id) expenseData.projectId = args.project_id;
      if (args.tax_name1) expenseData.taxName1 = args.tax_name1;
      if (args.tax_percent1) expenseData.taxPercent1 = args.tax_percent1;

      const response = await client.expenses.create(expenseData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create expense: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateExpense = tool(
  "freshbooks_update_expense",
  "Update an existing expense. Only provide the fields you want to change. Amounts are strings to preserve decimal precision.",
  {
    expense_id: z.string().describe("The expense ID to update"),
    vendor: z.string().optional().describe("Updated vendor name"),
    notes: z.string().optional().describe("Updated notes about the expense"),
    category_id: z.number().int().optional().describe("Updated expense category ID"),
    amount: z.object({
      amount: z.string().describe("Expense amount as a string, e.g. '50.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Updated expense amount as a Money object"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.vendor !== undefined) updateData.vendor = args.vendor;
      if (args.notes !== undefined) updateData.notes = args.notes;
      if (args.category_id !== undefined) updateData.categoryId = args.category_id;
      if (args.amount !== undefined) updateData.amount = { amount: args.amount.amount, code: args.amount.code };

      const response = await client.expenses.update(updateData as any, accountId, args.expense_id);

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
        content: [{ type: "text" as const, text: `Failed to update expense: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteExpense = tool(
  "freshbooks_delete_expense",
  "Delete an expense by ID. This action is permanent and cannot be undone.",
  {
    expense_id: z.string().describe("The expense ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.expenses.delete(accountId, args.expense_id);

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
        content: [{ type: "text" as const, text: `Failed to delete expense: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
