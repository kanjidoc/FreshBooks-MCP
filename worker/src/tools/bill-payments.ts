import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerBillPaymentTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_bill_payments", "List bill payments. Supports pagination.",
    { page: z.number().int().min(1).default(1).describe("Page number"), per_page: z.number().int().min(1).max(100).default(25).describe("Results per page") },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page });
        const data = await api.get(api.accountingUrl("bills/bill_payments"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list bill payments: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_bill_payment", "Get a single bill payment by ID.",
    { bill_payment_id: z.string().describe("The bill payment ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`bills/bill_payments/${args.bill_payment_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get bill payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_bill_payment", "Create a new bill payment.",
    {
      bill_id: z.number().int().describe("The bill ID this payment applies to"),
      amount: z.object({ amount: z.string().describe("Payment amount as string"), code: z.string().default("USD").describe("Currency code") }).describe("Payment amount"),
      paid_date: z.string().describe("Date the payment was made in YYYY-MM-DD format"),
      type: z.string().optional().describe("Payment type (e.g. 'Check', 'Credit Card', 'Bank Transfer')"),
    },
    async (args) => {
      try {
        const bill_payment: Record<string, unknown> = { billid: args.bill_id, amount: { amount: args.amount.amount, code: args.amount.code }, paid_date: args.paid_date };
        if (args.type !== undefined) bill_payment.type = args.type;
        const data = await api.post(api.accountingUrl("bills/bill_payments"), { bill_payment });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create bill payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_bill_payment", "Update an existing bill payment.",
    {
      bill_payment_id: z.string().describe("The bill payment ID to update"),
      amount: z.object({ amount: z.string().describe("Updated amount"), code: z.string().default("USD").describe("Currency code") }).optional().describe("Updated amount"),
      paid_date: z.string().optional().describe("Updated paid date"),
      type: z.string().optional().describe("Updated payment type"),
    },
    async (args) => {
      try {
        const bill_payment: Record<string, unknown> = {};
        if (args.amount !== undefined) bill_payment.amount = { amount: args.amount.amount, code: args.amount.code };
        if (args.paid_date !== undefined) bill_payment.paid_date = args.paid_date;
        if (args.type !== undefined) bill_payment.type = args.type;
        const data = await api.put(api.accountingUrl(`bills/bill_payments/${args.bill_payment_id}`), { bill_payment });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update bill payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_bill_payment", "Delete a bill payment by ID.",
    { bill_payment_id: z.string().describe("The bill payment ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.accountingUrl(`bills/bill_payments/${args.bill_payment_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete bill payment: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
