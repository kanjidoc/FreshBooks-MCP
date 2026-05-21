import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import Big from "big.js";
import JournalEntry from "@freshbooks/api/dist/models/JournalEntry";
import Detail from "@freshbooks/api/dist/models/Detail";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";
import { parseLocalDate } from "../date-helpers";

/**
 * `journalEntryAccounts` and `journalEntryDetails` exist on the SDK Client at
 * runtime but are missing from its `Client` type declaration. This narrow shim
 * types just those two resources so the rest of `client` stays fully typed
 * instead of being blanket-cast `as any`.
 */
type JournalEntryListResources = {
  journalEntryAccounts: { list: (a: string, q?: unknown[]) => Promise<any> };
  journalEntryDetails: { list: (a: string, q?: unknown[]) => Promise<any> };
};

export const createJournalEntry = tool(
  "freshbooks_create_journal_entry",
  "Create a new journal entry. KNOWN LIMITATION: currently non-functional — blocked by a bug in @freshbooks/api@4.1.0 (the SDK omits API-required fields). See CHANGELOG.md. Requires a description, credit entries, and debit entries; credit and debit totals must balance. Amounts are passed as strings but converted to numbers (the SDK's detail model types credit/debit as numbers).",
  {
    description: z.string().describe("Description of the journal entry"),
    currency_code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    entry_date: z.string().optional().describe("Journal entry date in YYYY-MM-DD format (defaults to today)"),
    credit_entries: z.array(
      z.object({
        sub_account_id: z.number().int().describe(
          "Sub-account ID — get it from freshbooks_list_journal_entry_accounts (the subAccountId field)"
        ),
        amount: z.string().describe("Credit amount, e.g. '500.00'"),
      })
    ).min(1).describe("Credit lines"),
    debit_entries: z.array(
      z.object({
        sub_account_id: z.number().int().describe(
          "Sub-account ID — get it from freshbooks_list_journal_entry_accounts (the subAccountId field)"
        ),
        amount: z.string().describe("Debit amount, e.g. '500.00'"),
      })
    ).min(1).describe("Debit lines"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      // Credit and debit totals must balance — reject before hitting the API.
      const creditTotal = args.credit_entries.reduce((s, e) => s.plus(e.amount), new Big(0));
      const debitTotal = args.debit_entries.reduce((s, e) => s.plus(e.amount), new Big(0));
      if (!creditTotal.eq(debitTotal)) {
        return {
          content: [{ type: "text" as const, text: `Journal entry does not balance: credits ${creditTotal} vs debits ${debitTotal}` }],
          isError: true,
        };
      }

      const entryData: Partial<JournalEntry> = {
        description: args.description,
        currencyCode: args.currency_code,
        details: [
          ...args.credit_entries.map((e): Detail => ({ credit: Number(e.amount), subAccountId: e.sub_account_id })),
          ...args.debit_entries.map((e): Detail => ({ debit: Number(e.amount), subAccountId: e.sub_account_id })),
        ],
      };
      if (args.entry_date) entryData.userEnteredDate = parseLocalDate(args.entry_date);

      const response = await client.journalEntries.create(entryData as JournalEntry, accountId);

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

      const jeClient = client as unknown as JournalEntryListResources;
      const response = await jeClient.journalEntryAccounts.list(accountId, queryBuilders);

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

      const jeClient = client as unknown as JournalEntryListResources;
      const response = await jeClient.journalEntryDetails.list(accountId, queryBuilders);

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
