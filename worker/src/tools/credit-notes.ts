import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerCreditNoteTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_credit_notes", "List credit notes. Supports pagination, search by client, sorting, and includes.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      search_client_id: z.number().int().optional().describe("Filter by client ID"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'create_date', 'updated')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
      includes: z.array(z.string()).optional().describe("Related resources to include (e.g. ['lines'])"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({
          page: args.page, perPage: args.per_page,
          search: { ...(args.search_client_id !== undefined && { clientid: args.search_client_id }) },
          sortBy: args.sort_by, sortOrder: args.sort_order, includes: args.includes,
        });
        const data = await api.get(api.accountingUrl("credit_notes/credit_notes"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list credit notes: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_credit_note", "Get a single credit note by ID.",
    { credit_note_id: z.string().describe("The credit note ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`credit_notes/credit_notes/${args.credit_note_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get credit note: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_credit_note", "Create a new credit note.",
    {
      client_id: z.number().int().describe("The client ID (required)"),
      create_date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
      notes: z.string().optional().describe("Notes or memo"),
      lines: z.array(z.object({
        name: z.string().describe("Line item name"),
        description: z.string().optional().describe("Additional detail"),
        qty: z.number().describe("Quantity"),
        unit_cost: z.object({ amount: z.string().describe("Unit cost as string"), code: z.string().default("USD").describe("Currency code") }).describe("Unit cost"),
      })).describe("Line items"),
    },
    async (args) => {
      try {
        const credit_note: Record<string, unknown> = {
          clientid: args.client_id,
          lines: args.lines.map((l) => ({
            name: l.name, description: l.description, qty: l.qty,
            unit_cost: { amount: l.unit_cost.amount, code: l.unit_cost.code },
          })),
        };
        if (args.create_date) credit_note.create_date = args.create_date;
        if (args.notes) credit_note.notes = args.notes;
        const data = await api.post(api.accountingUrl("credit_notes/credit_notes"), { credit_note });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create credit note: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_credit_note", "Update an existing credit note.",
    {
      credit_note_id: z.string().describe("The credit note ID to update"),
      notes: z.string().optional().describe("Updated notes"),
      status: z.string().optional().describe("Updated status (e.g. 'draft', 'active', 'sent')"),
    },
    async (args) => {
      try {
        const credit_note: Record<string, unknown> = {};
        if (args.notes !== undefined) credit_note.notes = args.notes;
        if (args.status !== undefined) credit_note.status = args.status;
        const data = await api.put(api.accountingUrl(`credit_notes/credit_notes/${args.credit_note_id}`), { credit_note });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update credit note: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_credit_note", "Delete a credit note by ID (soft delete).",
    { credit_note_id: z.string().describe("The credit note ID to delete") },
    async (args) => {
      try {
        const data = await api.put(api.accountingUrl(`credit_notes/credit_notes/${args.credit_note_id}`), { credit_note: { vis_state: 1 } });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete credit note: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
