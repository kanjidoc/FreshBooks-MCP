import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import { rawRequest, rawList, renderRaw, unwrapEnvelope, RAW_TIER_DESC } from "../../raw-call";

/**
 * Taxes — the account's tax DEFINITIONS (name, rate, number), never wrapped
 * by the frozen SDK. Envelope keys verified live (2026-07-29): collection
 * `taxes`, single item `tax` (singular). Bogus IDs return a clean 404
 * api_error (probed).
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
