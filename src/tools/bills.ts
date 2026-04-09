import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listBills = tool(
  "freshbooks_list_bills",
  "List bills for the FreshBooks account. Supports pagination, sorting, and includes. Returns bill summaries including id, vendor, amount, status, and dates.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'due_date', 'amount', 'bill_number')"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['lines', 'vendor'])"),
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
        includes: args.includes,
      });

      const response = await client.bills.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list bills: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getBill = tool(
  "freshbooks_get_bill",
  "Get a single bill by ID. Returns full bill details including line items, vendor info, amounts, and status.",
  {
    bill_id: z.string().describe("The bill ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.bills.single(accountId, Number(args.bill_id));

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
        content: [{ type: "text" as const, text: `Failed to get bill: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createBill = tool(
  "freshbooks_create_bill",
  "Create a new bill. Requires a vendor ID and at least one line item. Amounts are strings to preserve decimal precision.",
  {
    vendor_id: z.number().int().describe("The bill vendor ID this bill belongs to"),
    lines: z.array(z.object({
      description: z.string().describe("Line item description"),
      amount: z.string().describe("Line item amount as a string, e.g. '100.00'"),
      category: z.string().optional().describe("Expense category for the line item"),
      quantity: z.number().default(1).describe("Quantity of the line item"),
    })).describe("Bill line items"),
    due_date: z.string().describe("Bill due date in YYYY-MM-DD format"),
    currency_code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const billData = {
        vendorId: args.vendor_id,
        lines: args.lines.map((line) => ({
          description: line.description,
          amount: { amount: line.amount, code: args.currency_code },
          category: line.category,
          quantity: line.quantity,
        })),
        dueDate: new Date(args.due_date),
        currencyCode: args.currency_code,
      };

      const response = await client.bills.create(billData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create bill: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const deleteBill = tool(
  "freshbooks_delete_bill",
  "Delete a bill by ID. This action is permanent and cannot be undone.",
  {
    bill_id: z.string().describe("The bill ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.bills.delete(accountId, Number(args.bill_id));

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
        content: [{ type: "text" as const, text: `Failed to delete bill: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
