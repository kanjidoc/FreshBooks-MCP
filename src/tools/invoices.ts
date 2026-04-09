import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listInvoices = tool(
  "freshbooks_list_invoices",
  "List invoices for the FreshBooks account. Supports pagination, search filters, sorting, and includes. Returns invoice summaries including id, status, amount, customer, and dates.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    search_status: z.string().optional().describe("Filter by status (e.g. 'draft', 'sent', 'viewed', 'paid', 'partial', 'disputed')"),
    search_customer_id: z.number().int().optional().describe("Filter by customer/client ID"),
    search_date_min: z.string().optional().describe("Filter invoices created on or after this date (YYYY-MM-DD)"),
    search_date_max: z.string().optional().describe("Filter invoices created on or before this date (YYYY-MM-DD)"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'invoice_date', 'amount', 'invoice_number')"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['lines', 'allowed_gateway_info'])"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        search: {
          ...(args.search_status && { status: args.search_status }),
          ...(args.search_customer_id && { customerid: args.search_customer_id }),
        },
        dateRange: args.search_date_min || args.search_date_max
          ? { key: "invoice_date", min: args.search_date_min, max: args.search_date_max }
          : undefined,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
        includes: args.includes,
      });

      const response = await client.invoices.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list invoices: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getInvoice = tool(
  "freshbooks_get_invoice",
  "Get a single invoice by ID. Returns full invoice details including line items, amounts, status, and customer info.",
  {
    invoice_id: z.string().describe("The invoice ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.invoices.single(accountId, args.invoice_id);

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
        content: [{ type: "text" as const, text: `Failed to get invoice: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createInvoice = tool(
  "freshbooks_create_invoice",
  "Create a new invoice. Requires a customer ID and at least one line item. Amounts are strings to preserve decimal precision.",
  {
    customer_id: z.number().int().describe("The customer/client ID to invoice"),
    create_date: z.string().describe("Invoice date in YYYY-MM-DD format"),
    due_offset_days: z.number().int().default(30).describe("Number of days until due"),
    lines: z.array(z.object({
      name: z.string().describe("Line item name/description"),
      description: z.string().optional().describe("Additional description"),
      qty: z.number().describe("Quantity"),
      unit_cost: z.object({
        amount: z.string().describe("Unit cost as a string, e.g. '100.00'"),
        code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
      }).describe("Unit cost as a Money object"),
    })).describe("Invoice line items"),
    notes: z.string().optional().describe("Notes to include on the invoice"),
    po_number: z.string().optional().describe("Purchase order number"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const invoiceData = {
        customerId: args.customer_id,
        createDate: new Date(args.create_date),
        dueOffsetDays: args.due_offset_days,
        lines: args.lines.map((line) => ({
          name: line.name,
          description: line.description,
          qty: line.qty,
          unitCost: { amount: line.unit_cost.amount, code: line.unit_cost.code },
        })),
        notes: args.notes,
        poNumber: args.po_number,
      };

      const response = await client.invoices.create(invoiceData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create invoice: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateInvoice = tool(
  "freshbooks_update_invoice",
  "Update an existing invoice. Only provide the fields you want to change.",
  {
    invoice_id: z.string().describe("The invoice ID to update"),
    notes: z.string().optional().describe("Updated notes"),
    po_number: z.string().optional().describe("Updated purchase order number"),
    due_offset_days: z.number().int().optional().describe("Updated days until due"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.notes !== undefined) updateData.notes = args.notes;
      if (args.po_number !== undefined) updateData.poNumber = args.po_number;
      if (args.due_offset_days !== undefined) updateData.dueOffsetDays = args.due_offset_days;

      const response = await client.invoices.update(accountId, args.invoice_id, updateData);

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
        content: [{ type: "text" as const, text: `Failed to update invoice: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);
