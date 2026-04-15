import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerJournalEntryTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_create_journal_entry", "Create a new journal entry. Credit and debit totals must balance. Amounts are strings.",
    {
      description: z.string().describe("Description of the journal entry"),
      currency_code: z.string().default("USD").describe("Currency code"),
      credit_entries: z.array(z.object({
        account_number: z.string().describe("Chart of accounts account number for credit"),
        amount: z.string().describe("Credit amount as string, e.g. '500.00'"),
      })).describe("Credit entries"),
      debit_entries: z.array(z.object({
        account_number: z.string().describe("Chart of accounts account number for debit"),
        amount: z.string().describe("Debit amount as string, e.g. '500.00'"),
      })).describe("Debit entries"),
    },
    async (args) => {
      try {
        const journal_entry = {
          description: args.description,
          currency_code: args.currency_code,
          credit_entries: args.credit_entries.map((e) => ({ account_number: e.account_number, amount: e.amount })),
          debit_entries: args.debit_entries.map((e) => ({ account_number: e.account_number, amount: e.amount })),
        };
        const data = await api.post(api.accountingUrl("journal_entries/journal_entries"), { journal_entry });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create journal entry: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_list_journal_entry_accounts", "List journal entry accounts (chart of accounts). Supports pagination.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page });
        const data = await api.get(api.accountingUrl("journal_entries/accounts"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list journal entry accounts: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_list_journal_entry_details", "List journal entry details. Supports pagination.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page });
        const data = await api.get(api.accountingUrl("journal_entries/journal_entry_details"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list journal entry details: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
