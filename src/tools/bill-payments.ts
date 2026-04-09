import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listBillPayments = tool(
  "freshbooks_list_bill_payments",
  "List bill payments for the FreshBooks account. Supports pagination. Returns bill payment summaries including id, bill, amount, and paid date.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
      });

      const response = await client.billPayments.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list bill payments: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getBillPayment = tool(
  "freshbooks_get_bill_payment",
  "Get a single bill payment by ID. Returns full bill payment details including amount, paid date, and associated bill.",
  {
    bill_payment_id: z.string().describe("The bill payment ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.billPayments.single(accountId, Number(args.bill_payment_id));

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
        content: [{ type: "text" as const, text: `Failed to get bill payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createBillPayment = tool(
  "freshbooks_create_bill_payment",
  "Create a new bill payment. Requires a bill ID, amount, and paid date. Amounts are strings to preserve decimal precision.",
  {
    bill_id: z.number().int().describe("The bill ID this payment applies to"),
    amount: z.object({
      amount: z.string().describe("Payment amount as a string, e.g. '250.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).describe("Payment amount as a Money object"),
    paid_date: z.string().describe("Date the payment was made in YYYY-MM-DD format"),
    type: z.string().optional().describe("Payment type (e.g. 'Check', 'Credit Card', 'Bank Transfer')"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const paymentData: Record<string, unknown> = {
        billId: args.bill_id,
        amount: { amount: args.amount.amount, code: args.amount.code },
        paidDate: new Date(args.paid_date),
      };
      if (args.type !== undefined) paymentData.type = args.type;

      const response = await client.billPayments.create(paymentData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create bill payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateBillPayment = tool(
  "freshbooks_update_bill_payment",
  "Update an existing bill payment. Only provide the fields you want to change.",
  {
    bill_payment_id: z.string().describe("The bill payment ID to update"),
    amount: z.object({
      amount: z.string().describe("Updated payment amount as a string, e.g. '250.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Updated payment amount as a Money object"),
    paid_date: z.string().optional().describe("Updated date the payment was made in YYYY-MM-DD format"),
    type: z.string().optional().describe("Updated payment type (e.g. 'Check', 'Credit Card', 'Bank Transfer')"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.amount !== undefined) updateData.amount = { amount: args.amount.amount, code: args.amount.code };
      if (args.paid_date !== undefined) updateData.paidDate = new Date(args.paid_date);
      if (args.type !== undefined) updateData.type = args.type;

      const response = await client.billPayments.update(updateData as any, accountId, Number(args.bill_payment_id));

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
        content: [{ type: "text" as const, text: `Failed to update bill payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteBillPayment = tool(
  "freshbooks_delete_bill_payment",
  "Delete a bill payment by ID. This action is permanent and cannot be undone.",
  {
    bill_payment_id: z.string().describe("The bill payment ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.billPayments.delete(accountId, Number(args.bill_payment_id));

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
        content: [{ type: "text" as const, text: `Failed to delete bill payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
