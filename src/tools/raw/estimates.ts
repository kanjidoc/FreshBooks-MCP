import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import { rawRequest, rawList, renderRaw, unwrapEnvelope, RAW_TIER_DESC } from "../../raw-call";

/**
 * Estimates — never wrapped by the frozen SDK. Collection envelope key
 * `estimates` verified live on all four configured profiles (2026-07-29).
 * The single-item envelope key `estimate` was verified during the Phase 3
 * estimate CRUD probe; if the API ever drifts, unwrapEnvelope fails loudly
 * with the body echoed.
 *
 * Per the no-guessed-filters doctrine (Part F): no optional search filters —
 * no artifact exists proving which the endpoint honors. Listing is
 * exhaustive via rawList.
 */

export const listEstimates = tool(
  "freshbooks_list_estimates",
  `List all estimates (quotes sent to clients before invoicing). Answers "what have we quoted, to whom, for how much, and what was accepted?". For billed amounts use freshbooks_list_invoices — an estimate is not an invoice. ${RAW_TIER_DESC}`,
  {},
  async () => {
    try {
      const accountId = getAccountId();
      const result = await rawList({
        path: `/accounting/account/${accountId}/estimates/estimates`,
        envelopeKey: "estimates",
        name: "List Estimates",
      });
      return renderRaw(result);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to list estimates: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const getEstimate = tool(
  "freshbooks_get_estimate",
  `Get one estimate by ID, with its line items. IDs come from freshbooks_list_estimates. ${RAW_TIER_DESC}`,
  {
    estimate_id: z.number().int().describe("The estimate ID (from freshbooks_list_estimates)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      // include[]=lines (singular "include" — verified on the wire 2026-07-29):
      // without it the single GET omits line items, which are the substance of
      // an estimate.
      const result = await rawRequest({
        method: "GET",
        path: `/accounting/account/${accountId}/estimates/estimates/${args.estimate_id}`,
        query: { "include[]": ["lines"] },
        name: "Get Estimate",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "estimate", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to get estimate: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
