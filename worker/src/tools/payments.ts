import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerPaymentTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_payments", "List payments for the FreshBooks account. Supports pagination, search filters, and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      search_invoice_id: z.string().optional().describe("Filter by invoice ID"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'date', 'amount')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, search: { ...(args.search_invoice_id && { invoiceid: args.search_invoice_id }) }, sortBy: args.sort_by, sortOrder: args.sort_order });
        const data = await api.get(api.accountingUrl("payments/payments"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list payments: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_payment", "Get a single payment by ID.",
    { payment_id: z.string().describe("The payment ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`payments/payments/${args.payment_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_payment", "Record a payment against an invoice. Amounts are strings to preserve decimal precision.",
    {
      invoice_id: z.string().describe("The invoice ID this payment is for"),
      amount: z.object({ amount: z.string().describe("Payment amount as a string, e.g. '500.00'"), code: z.string().default("USD").describe("Currency code") }).describe("Payment amount"),
      date: z.string().describe("Payment date in YYYY-MM-DD format"),
      type: z.enum(["Check","Credit","Cash","Bank Transfer","Credit Card","Debit","PayPal","2Checkout","VISA","MASTERCARD","DISCOVER","AMEX","DINERS","JCB","ACH","Other"]).default("Other").describe("Payment method type"),
      note: z.string().optional().describe("Note about the payment"),
    },
    async (args) => {
      try {
        const payment: Record<string, unknown> = { invoiceid: args.invoice_id, amount: { amount: args.amount.amount, code: args.amount.code }, date: args.date, type: args.type };
        if (args.note) payment.note = args.note;
        const data = await api.post(api.accountingUrl("payments/payments"), { payment });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_payment", "Update an existing payment. Only provide the fields you want to change.",
    {
      payment_id: z.string().describe("The payment ID to update"),
      note: z.string().optional().describe("Updated note"),
      type: z.enum(["Check","Credit","Cash","Bank Transfer","Credit Card","Debit","PayPal","2Checkout","VISA","MASTERCARD","DISCOVER","AMEX","DINERS","JCB","ACH","Other"]).optional().describe("Updated payment type"),
    },
    async (args) => {
      try {
        const payment: Record<string, unknown> = {};
        if (args.note !== undefined) payment.note = args.note;
        if (args.type !== undefined) payment.type = args.type;
        const data = await api.put(api.accountingUrl(`payments/payments/${args.payment_id}`), { payment });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_payment", "Delete a payment by ID (soft delete).",
    { payment_id: z.string().describe("The payment ID to delete") },
    async (args) => {
      try {
        const data = await api.put(api.accountingUrl(`payments/payments/${args.payment_id}`), { payment: { vis_state: 1 } });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
