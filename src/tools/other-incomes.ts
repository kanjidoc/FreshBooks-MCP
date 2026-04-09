import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listOtherIncomes = tool(
  "freshbooks_list_other_incomes",
  "List other income records for the FreshBooks account. Supports pagination and sorting. Returns summaries including id, source, amount, date, and category.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'date', 'amount')"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      });

      const response = await client.otherIncomes.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list other incomes: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getOtherIncome = tool(
  "freshbooks_get_other_income",
  "Get a single other income record by ID. Returns full details including source, amount, date, category, and notes.",
  {
    other_income_id: z.string().describe("The other income ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.otherIncomes.single(accountId, args.other_income_id);

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
        content: [{ type: "text" as const, text: `Failed to get other income: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createOtherIncome = tool(
  "freshbooks_create_other_income",
  "Create a new other income record in FreshBooks for income that isn't tracked through invoices (e.g. interest, grants, side work).",
  {
    source: z.string().describe("Income source description, e.g. 'Bank interest', 'Grant payment'"),
    amount: z.object({
      amount: z.string().describe("Amount as a string, e.g. '500.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).describe("Income amount as a Money object"),
    date: z.string().describe("Income date in YYYY-MM-DD format"),
    category_name: z.string().optional().describe("Income category name, e.g. 'Other Income'"),
    note: z.string().optional().describe("Optional note about this income"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const incomeData: Record<string, unknown> = {
        source: args.source,
        amount: { amount: args.amount.amount, code: args.amount.code },
        date: new Date(args.date),
      };
      if (args.category_name !== undefined) incomeData.categoryName = args.category_name;
      if (args.note !== undefined) incomeData.note = args.note;

      const response = await client.otherIncomes.create(incomeData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create other income: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateOtherIncome = tool(
  "freshbooks_update_other_income",
  "Update an existing other income record in FreshBooks. Only provide the fields you want to change.",
  {
    other_income_id: z.string().describe("The other income ID to update"),
    source: z.string().optional().describe("Updated income source description"),
    note: z.string().optional().describe("Updated note"),
    category_name: z.string().optional().describe("Updated income category name"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.source !== undefined) updateData.source = args.source;
      if (args.note !== undefined) updateData.note = args.note;
      if (args.category_name !== undefined) updateData.categoryName = args.category_name;

      const response = await client.otherIncomes.update(accountId, args.other_income_id, updateData);

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
        content: [{ type: "text" as const, text: `Failed to update other income: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteOtherIncome = tool(
  "freshbooks_delete_other_income",
  "Delete an other income record by ID. This action is permanent and cannot be undone.",
  {
    other_income_id: z.string().describe("The other income ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.otherIncomes.delete(accountId, args.other_income_id);

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
        content: [{ type: "text" as const, text: `Failed to delete other income: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
