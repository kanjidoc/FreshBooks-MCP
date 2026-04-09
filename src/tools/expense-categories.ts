import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listExpenseCategories = tool(
  "freshbooks_list_expense_categories",
  "List expense categories for the FreshBooks account. Supports pagination and sorting. Returns category names and IDs used when creating or filtering expenses.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'category')"),
    sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
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

      const response = await client.expenseCategories.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list expense categories: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getExpenseCategory = tool(
  "freshbooks_get_expense_category",
  "Get a single expense category by ID. Returns the category name and associated metadata.",
  {
    category_id: z.string().describe("The expense category ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.expenseCategories.single(accountId, args.category_id);

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
        content: [{ type: "text" as const, text: `Failed to get expense category: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);
