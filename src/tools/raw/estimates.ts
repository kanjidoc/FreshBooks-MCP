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
 *
 * WRITE CONTRACT (go/no-go memo 2026-07-29, live CRUD transcript):
 * create requires `customerid` (not clientid — the 422 names it) and
 * `create_date`; creating produces a DRAFT and emails nothing; PUT has
 * MERGE semantics (a notes-only PUT left lines and total intact — probed
 * with include[]=lines); DELETE is a SOFT delete (vis_state: 1, restorable
 * in the UI, excluded from lists). Sending is a separate explicit action
 * (freshbooks_send_estimate) and is the only path that emails anyone.
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

const estimateLine = z.object({
  name: z.string().min(1).describe("Line item name"),
  qty: z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal number string").describe("Quantity, as a string, e.g. '1' or '2.5'"),
  unit_cost: z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal number string").describe("Unit price as a decimal string, e.g. '150.00'"),
  currency_code: z.string().default("USD").describe("Currency code for the unit price"),
  description: z.string().optional().describe("Line item description"),
});

type EstimateLineArgs = z.infer<typeof estimateLine>;

const toWireLine = (l: EstimateLineArgs) => ({
  name: l.name,
  qty: l.qty,
  unit_cost: { amount: l.unit_cost, code: l.currency_code },
  ...(l.description ? { description: l.description } : {}),
  type: 0,
});

export const createEstimate = tool(
  "freshbooks_create_estimate",
  `Create a DRAFT estimate (quote) for a client — nothing is emailed; use freshbooks_send_estimate to send it. The client id is the 'id' from freshbooks_list_clients. ${RAW_TIER_DESC}`,
  {
    client_id: z.number().int().describe("The client to quote — the 'id' field from freshbooks_list_clients (sent on the wire as customerid)"),
    create_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").describe("Estimate date in YYYY-MM-DD format (required by the API)"),
    lines: z.array(estimateLine).min(1).describe("Line items"),
    notes: z.string().optional().describe("Notes shown on the estimate"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "POST",
        path: `/accounting/account/${accountId}/estimates/estimates`,
        body: {
          estimate: {
            customerid: args.client_id,
            create_date: args.create_date,
            lines: args.lines.map(toWireLine),
            ...(args.notes ? { notes: args.notes } : {}),
          },
        },
        name: "Create Estimate",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "estimate", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to create estimate: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
);

export const updateEstimate = tool(
  "freshbooks_update_estimate",
  `Update an estimate by ID. Partial update — only the fields you pass change (verified live: the API merges). QUIRK: passing lines REPLACES the whole line set; omit lines to leave them untouched. ${RAW_TIER_DESC}`,
  {
    estimate_id: z.number().int().describe("The estimate ID (from freshbooks_list_estimates)"),
    create_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional().describe("New estimate date (YYYY-MM-DD)"),
    lines: z.array(estimateLine).min(1).optional().describe("REPLACES all line items when provided"),
    notes: z.string().optional().describe("New notes"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const estimate: Record<string, unknown> = {};
      if (args.create_date !== undefined) estimate.create_date = args.create_date;
      if (args.lines !== undefined) estimate.lines = args.lines.map(toWireLine);
      if (args.notes !== undefined) estimate.notes = args.notes;
      if (Object.keys(estimate).length === 0) {
        return {
          content: [{ type: "text" as const, text: "Nothing to update: pass at least one of create_date, lines, notes." }],
          isError: true,
        };
      }
      const result = await rawRequest({
        method: "PUT",
        path: `/accounting/account/${accountId}/estimates/estimates/${args.estimate_id}`,
        body: { estimate },
        name: "Update Estimate",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "estimate", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to update estimate: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } },
);

export const deleteEstimate = tool(
  "freshbooks_delete_estimate",
  `Delete an estimate by ID. This is a soft delete (the API sets vis_state to deleted): the record leaves list results but can be restored in the FreshBooks web UI. ${RAW_TIER_DESC}`,
  {
    estimate_id: z.number().int().describe("The estimate ID (from freshbooks_list_estimates)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "DELETE",
        path: `/accounting/account/${accountId}/estimates/estimates/${args.estimate_id}`,
        name: "Delete Estimate",
      });
      return renderRaw(result, () => ({ deleted: true, soft_delete: true, estimate_id: args.estimate_id }));
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to delete estimate: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } },
);

export const sendEstimate = tool(
  "freshbooks_send_estimate",
  `EMAIL an estimate to recipients — this contacts real people. email_recipients is required and never defaulted; the client is NOT emailed unless their address is listed. Create/review the estimate first (freshbooks_get_estimate). ${RAW_TIER_DESC}`,
  {
    estimate_id: z.number().int().describe("The estimate ID to send (from freshbooks_list_estimates)"),
    email_recipients: z
      .array(z.string().email())
      .min(1)
      .describe("REQUIRED: every address that will receive the estimate email. Nothing is inferred — an empty or missing list refuses to send."),
    email_subject: z.string().optional().describe("Custom email subject"),
    email_body: z.string().optional().describe("Custom email body text"),
  },
  async (args) => {
    try {
      // Belt-and-suspenders beyond schema validation: this handler must be
      // unreachable-to-send without explicit recipients even when called
      // directly (tested with a fake client that records invocations).
      if (!Array.isArray(args.email_recipients) || args.email_recipients.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Refusing to send: email_recipients is required and empty. List every address that should receive this estimate.",
            },
          ],
          isError: true,
        };
      }
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "PUT",
        path: `/accounting/account/${accountId}/estimates/estimates/${args.estimate_id}`,
        body: {
          estimate: {
            action_email: true,
            email_recipients: args.email_recipients,
            ...(args.email_subject ? { email_subject: args.email_subject } : {}),
            ...(args.email_body ? { email_body: args.email_body } : {}),
          },
        },
        name: "Send Estimate",
      });
      return renderRaw(result, (data) => {
        const estimate = unwrapEnvelope<Record<string, unknown>>(data, "estimate", "object").value;
        return { sent_to: args.email_recipients, estimate_status: estimate.status, ui_status: estimate.ui_status };
      });
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to send estimate: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
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
