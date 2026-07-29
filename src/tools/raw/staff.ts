import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import { rawRequest, rawList, renderRaw, unwrapEnvelope, RAW_TIER_DESC } from "../../raw-call";

/**
 * Staff — never wrapped by the frozen SDK. READ-ONLY BY DECISION: staff
 * writes cannot be live-verified (create_staff emails a real human), so no
 * write tools ship for this domain. These reads close a real hole:
 * freshbooks_create_expense requires a staff_id that no other tool could
 * produce.
 *
 * Envelope keys verified live (2026-07-29): collection `staff` (NOT
 * `staffs`), single item also `staff`.
 *
 * SECURITY: the API returns each staff member's `api_token` — a live
 * credential (observed non-null on an admin row). It is STRIPPED here and
 * must never be rendered into model context. test/raw-entities.test.ts
 * locks this in.
 */

function stripApiToken(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return row;
  const { api_token: _token, ...rest } = row as Record<string, unknown>;
  return rest;
}

/**
 * Deep-redact `api_token` EVERYWHERE in a raw result before it reaches
 * renderRaw. The shape-level strip covers only the success path; renderRaw's
 * failure branch echoes `rawBody` VERBATIM on envelope drift (and on
 * api_error with no structured detail), and its shape-throw catch echoes the
 * unshaped body too — so a drifted staff response would otherwise leak live
 * tokens into model context. Redacting the whole result object closes every
 * echo path at once; only values under an `api_token` key are touched.
 */
function redactApiTokens<T>(node: T): T {
  if (Array.isArray(node)) return node.map(redactApiTokens) as unknown as T;
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = key === "api_token" ? "[REDACTED]" : redactApiTokens(value);
  }
  return out as T;
}

export const listStaff = tool(
  "freshbooks_list_staff",
  `List the FreshBooks account's staff members (team logins). Answers "who works in this account, and what is their staff id?" — the staff_id freshbooks_create_expense needs. Not the configured server logins (that is freshbooks_list_accounts). QUIRK: the API returns each member's api_token credential; this server strips it. ${RAW_TIER_DESC}`,
  {},
  async () => {
    try {
      const accountId = getAccountId();
      const result = await rawList({
        path: `/accounting/account/${accountId}/users/staffs`,
        envelopeKey: "staff",
        name: "List Staff",
      });
      return renderRaw(redactApiTokens(result), (rows) => (rows as unknown[]).map(stripApiToken));
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to list staff: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const getStaffMember = tool(
  "freshbooks_get_staff_member",
  `Get one staff member by ID. IDs come from freshbooks_list_staff. QUIRK: the api_token credential the API returns is stripped. ${RAW_TIER_DESC}`,
  {
    staff_id: z.number().int().describe("The staff ID (from freshbooks_list_staff)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "GET",
        path: `/accounting/account/${accountId}/users/staffs/${args.staff_id}`,
        name: "Get Staff Member",
      });
      return renderRaw(redactApiTokens(result), (data) =>
        stripApiToken(unwrapEnvelope(data, "staff", "object").value),
      );
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to get staff member: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
