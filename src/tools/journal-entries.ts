import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const createJournalEntry = tool(
  "freshbooks_create_journal_entry",
  "Create a new journal entry. Requires a description, credit entries, and debit entries. Credit and debit totals must balance. Amounts are strings to preserve decimal precision.",
  {
    description: z.string().describe("Description of the journal entry"),
    currency_code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    credit_entries: z.array(
      z.object({
        account_number: z.string().describe("Chart of accounts account number for the credit entry"),
        amount: z.string().describe("Credit amount as a string, e.g. '500.00'"),
      })
    ).describe("Array of credit entries — each has an account number and amount"),
    debit_entries: z.array(
      z.object({
        account_number: z.string().describe("Chart of accounts account number for the debit entry"),
        amount: z.string().describe("Debit amount as a string, e.g. '500.00'"),
      })
    ).describe("Array of debit entries — each has an account number and amount"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const entryData: Record<string, unknown> = {
        description: args.description,
        currencyCode: args.currency_code,
        creditEntries: args.credit_entries.map((e) => ({
          accountNumber: e.account_number,
          amount: e.amount,
        })),
        debitEntries: args.debit_entries.map((e) => ({
          accountNumber: e.account_number,
          amount: e.amount,
        })),
      };

      const response = await client.journalEntries.create(entryData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create journal entry: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const listJournalEntryAccounts = tool(
  "freshbooks_list_journal_entry_accounts",
  "List journal entry accounts (chart of accounts) for the FreshBooks account. Supports pagination. Returns account numbers and names used when creating journal entries.",
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

      const response = await (client as any).journalEntryAccounts.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list journal entry accounts: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const listJournalEntryDetails = tool(
  "freshbooks_list_journal_entry_details",
  "List journal entry details for the FreshBooks account. Supports pagination. Returns individual line-level detail records associated with posted journal entries.",
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

      const response = await (client as any).journalEntryDetails.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list journal entry details: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);
