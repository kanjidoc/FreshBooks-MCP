import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import { rawRequest, rawList, renderRaw, unwrapEnvelope, RAW_TIER_DESC } from "../../raw-call";

/**
 * Taxes — the account's tax DEFINITIONS (name, rate, number), never wrapped
 * by the frozen SDK. Envelope keys verified live (2026-07-29): collection
 * `taxes`, single item `tax` (singular). Bogus IDs return a clean 404
 * api_error (probed).
 *
 * WRITE CONTRACT (go/no-go memo 2026-07-29, live CRUD transcript):
 * POST/PUT bodies are `{ tax: {...} }`; PUT has MERGE semantics — a partial
 * body updates only the sent fields (probed: name/number survived an
 * amount-only PUT), so no fetch-and-merge is needed; DELETE is a HARD
 * delete (re-GET 404s — not restorable).
 */

export const listTaxes = tool(
  "freshbooks_list_taxes",
  `List the account's tax definitions (name, rate, tax number) applied to invoice/estimate lines. Answers "what taxes can this account charge?". Not a report — for tax collected/paid totals use freshbooks_report_tax_summary. ${RAW_TIER_DESC}`,
  {},
  async () => {
    try {
      const accountId = getAccountId();
      const result = await rawList({
        path: `/accounting/account/${accountId}/taxes/taxes`,
        envelopeKey: "taxes",
        name: "List Taxes",
      });
      return renderRaw(result);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to list taxes: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const createTax = tool(
  "freshbooks_create_tax",
  `Create a tax definition (name + rate) that can then be applied to invoice/estimate lines. ${RAW_TIER_DESC}`,
  {
    name: z.string().min(1).describe("Tax name shown on documents, e.g. 'VAT' or 'GST'"),
    amount: z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal number string").describe("Tax rate percentage as a string, e.g. '7.5' for 7.5%"),
    number: z.string().optional().describe("Tax registration number, if any"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "POST",
        path: `/accounting/account/${accountId}/taxes/taxes`,
        body: { tax: { name: args.name, amount: args.amount, ...(args.number ? { number: args.number } : {}) } },
        name: "Create Tax",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "tax", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to create tax: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
);

export const updateTax = tool(
  "freshbooks_update_tax",
  `Update a tax definition by ID. Partial update — only the fields you pass change (verified live: the API merges, it does not replace). ${RAW_TIER_DESC}`,
  {
    tax_id: z.number().int().describe("The tax ID (the 'id' field from freshbooks_list_taxes)"),
    name: z.string().min(1).optional().describe("New tax name"),
    amount: z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal number string").optional().describe("New rate percentage as a string, e.g. '7.5'"),
    number: z.string().optional().describe("New tax registration number"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const tax: Record<string, string> = {};
      if (args.name !== undefined) tax.name = args.name;
      if (args.amount !== undefined) tax.amount = args.amount;
      if (args.number !== undefined) tax.number = args.number;
      if (Object.keys(tax).length === 0) {
        return {
          content: [{ type: "text" as const, text: "Nothing to update: pass at least one of name, amount, number." }],
          isError: true,
        };
      }
      const result = await rawRequest({
        method: "PUT",
        path: `/accounting/account/${accountId}/taxes/taxes/${args.tax_id}`,
        body: { tax },
        name: "Update Tax",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "tax", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to update tax: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } },
);

export const deleteTax = tool(
  "freshbooks_delete_tax",
  `Delete a tax definition by ID. This is a hard delete: permanent and cannot be undone (verified live — the record 404s afterward). ${RAW_TIER_DESC}`,
  {
    tax_id: z.number().int().describe("The tax ID (the 'id' field from freshbooks_list_taxes)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "DELETE",
        path: `/accounting/account/${accountId}/taxes/taxes/${args.tax_id}`,
        name: "Delete Tax",
      });
      return renderRaw(result, () => ({ deleted: true, tax_id: args.tax_id }));
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to delete tax: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } },
);

export const getTax = tool(
  "freshbooks_get_tax",
  `Get one tax definition by ID. IDs come from freshbooks_list_taxes (use the "id" field). ${RAW_TIER_DESC}`,
  {
    tax_id: z.number().int().describe("The tax ID (the 'id' field from freshbooks_list_taxes)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "GET",
        path: `/accounting/account/${accountId}/taxes/taxes/${args.tax_id}`,
        name: "Get Tax",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "tax", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to get tax: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
