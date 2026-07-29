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
      return renderRaw(result, (rows) => (rows as unknown[]).map(stripApiToken));
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
      return renderRaw(result, (data) => stripApiToken(unwrapEnvelope(data, "staff", "object").value));
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
