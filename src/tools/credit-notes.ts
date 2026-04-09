import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listCreditNotes = tool(
  "freshbooks_list_credit_notes",
  "List credit notes for the FreshBooks account. Supports pagination, search by client ID, sorting, and includes. Returns credit note status, amounts, and line items.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    search_client_id: z.number().int().optional().describe("Filter by client ID (exact match)"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'create_date', 'updated')"),
    sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
    includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['lines'])"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        search: {
          ...(args.search_client_id !== undefined && { clientid: args.search_client_id }),
        },
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
        includes: args.includes,
      });

      const response = await client.creditNotes.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list credit notes: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getCreditNote = tool(
  "freshbooks_get_credit_note",
  "Get a single credit note by ID. Returns full credit note details including line items, amounts, status, and client info.",
  {
    credit_note_id: z.string().describe("The credit note ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.creditNotes.single(accountId, args.credit_note_id);

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
        content: [{ type: "text" as const, text: `Failed to get credit note: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createCreditNote = tool(
  "freshbooks_create_credit_note",
  "Create a new credit note in FreshBooks for a client. Provide the client ID, line items, and an optional date and notes.",
  {
    client_id: z.number().int().describe("The client ID to associate the credit note with (required)"),
    create_date: z.string().optional().describe("Credit note date in YYYY-MM-DD format (defaults to today)"),
    notes: z.string().optional().describe("Notes or memo to include on the credit note"),
    lines: z
      .array(
        z.object({
          name: z.string().describe("Line item name/description"),
          description: z.string().optional().describe("Additional detail for the line item"),
          qty: z.number().describe("Quantity of the line item"),
          unit_cost: z.object({
            amount: z.string().describe("Unit cost amount as a string (e.g. '99.99')"),
            code: z.string().default("USD").describe("Currency code (e.g. 'USD')"),
          }).describe("Unit cost of the line item"),
        })
      )
      .describe("Line items for the credit note"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const lines = args.lines.map((line) => ({
        name: line.name,
        ...(line.description && { description: line.description }),
        qty: line.qty,
        unitCost: {
          amount: line.unit_cost.amount,
          code: line.unit_cost.code,
        },
      }));

      const creditNoteData: Record<string, unknown> = {
        clientid: args.client_id,
        lines,
      };
      if (args.create_date) creditNoteData.createDate = args.create_date;
      if (args.notes) creditNoteData.notes = args.notes;

      const response = await client.creditNotes.create(creditNoteData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create credit note: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateCreditNote = tool(
  "freshbooks_update_credit_note",
  "Update an existing credit note. Only provide the fields you want to change.",
  {
    credit_note_id: z.string().describe("The credit note ID to update"),
    notes: z.string().optional().describe("Updated notes or memo on the credit note"),
    status: z.string().optional().describe("Updated status of the credit note (e.g. 'draft', 'active', 'sent')"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.notes !== undefined) updateData.notes = args.notes;
      if (args.status !== undefined) updateData.status = args.status;

      const response = await client.creditNotes.update(updateData as any, accountId, args.credit_note_id);

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
        content: [{ type: "text" as const, text: `Failed to update credit note: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteCreditNote = tool(
  "freshbooks_delete_credit_note",
  "Delete a credit note by ID. This action is permanent and cannot be undone.",
  {
    credit_note_id: z.string().describe("The credit note ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.creditNotes.delete(accountId, args.credit_note_id);

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
        content: [{ type: "text" as const, text: `Failed to delete credit note: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
