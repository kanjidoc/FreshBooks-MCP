import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import Payment, { PaymentType } from "@freshbooks/api/dist/models/Payment";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";
import { parseLocalDate } from "../date-helpers";

export const listPayments = tool(
  "freshbooks_list_payments",
  "List payments for the FreshBooks account. Supports pagination, search filters, and sorting. Returns payment summaries including amount, date, type, and associated invoice.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    search_invoice_id: z.string().optional().describe("Filter by invoice ID"),
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
        search: {
          ...(args.search_invoice_id && { invoiceid: args.search_invoice_id }),
        },
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      });

      const response = await client.payments.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list payments: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getPayment = tool(
  "freshbooks_get_payment",
  "Get a single payment by ID. Returns full payment details including amount, type, date, and linked invoice.",
  {
    payment_id: z.string().describe("The payment ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.payments.single(accountId, args.payment_id);

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
        content: [{ type: "text" as const, text: `Failed to get payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createPayment = tool(
  "freshbooks_create_payment",
  "Record a payment against an invoice. Amounts are strings to preserve decimal precision.",
  {
    invoice_id: z.string().describe("The invoice ID this payment is for"),
    amount: z.object({
      amount: z.string().describe("Payment amount as a string, e.g. '500.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).describe("Payment amount as a Money object"),
    date: z.string().describe("Payment date in YYYY-MM-DD format"),
    type: z.enum([
      "Check", "Credit", "Cash", "Bank Transfer", "Credit Card",
      "Debit", "PayPal", "2Checkout", "VISA", "MASTERCARD",
      "DISCOVER", "AMEX", "DINERS", "JCB", "ACH", "Other",
    ]).default("Other").describe("Payment method type"),
    note: z.string().optional().describe("Note about the payment"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      // Typed against the SDK's Payment model so wrong property names fail the
      // build. type is cast to PaymentType — the zod enum strings match the
      // PaymentType enum values exactly.
      const paymentData: Partial<Payment> = {
        invoiceId: args.invoice_id,
        amount: { amount: args.amount.amount, code: args.amount.code },
        date: parseLocalDate(args.date),
        type: args.type as PaymentType,
      };
      if (args.note) paymentData.note = args.note;

      const response = await client.payments.create(accountId, paymentData as Payment);

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
        content: [{ type: "text" as const, text: `Failed to create payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updatePayment = tool(
  "freshbooks_update_payment",
  "Update an existing payment. Only provide the fields you want to change.",
  {
    payment_id: z.string().describe("The payment ID to update"),
    note: z.string().optional().describe("Updated note about the payment"),
    type: z.enum([
      "Check", "Credit", "Cash", "Bank Transfer", "Credit Card",
      "Debit", "PayPal", "2Checkout", "VISA", "MASTERCARD",
      "DISCOVER", "AMEX", "DINERS", "JCB", "ACH", "Other",
    ]).optional().describe("Updated payment method type"),
    amount: z.object({
      amount: z.string().describe("Payment amount as a string, e.g. '500.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Updated payment amount as a Money object"),
    date: z.string().optional().describe("Updated payment date in YYYY-MM-DD format"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      // Typed against the SDK's Payment model. transformPaymentUpdateRequest
      // serializes amount/date conditionally, so no fetch-merge is needed here.
      const updateData: Partial<Payment> = {};
      if (args.note !== undefined) updateData.note = args.note;
      if (args.type !== undefined) updateData.type = args.type as PaymentType;
      if (args.amount !== undefined) updateData.amount = { amount: args.amount.amount, code: args.amount.code };
      if (args.date !== undefined) updateData.date = parseLocalDate(args.date);

      const response = await client.payments.update(accountId, args.payment_id, updateData as Payment);

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
        content: [{ type: "text" as const, text: `Failed to update payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deletePayment = tool(
  "freshbooks_delete_payment",
  "Delete a payment by ID. This action is permanent and cannot be undone.",
  {
    payment_id: z.string().describe("The payment ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.payments.delete(accountId, args.payment_id);

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
        content: [{ type: "text" as const, text: `Failed to delete payment: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
