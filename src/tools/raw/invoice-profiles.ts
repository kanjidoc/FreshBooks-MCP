import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getAccountId } from "../../freshbooks-client";
import { rawRequest, rawList, renderRaw, unwrapEnvelope, RAW_TIER_DESC } from "../../raw-call";

/**
 * Invoice profiles (recurring-invoice templates) — never wrapped by the
 * frozen SDK. Collection envelope key `invoice_profiles` verified live on
 * all four configured profiles (2026-07-29). HONEST ADMISSION: the
 * single-item envelope key `invoice_profile` is UNVERIFIED — no record
 * exists on any configured profile to probe, and creating one was ruled out
 * because a live invoice profile can auto-generate real invoices (the same
 * reason writes for this domain are gated). A wrong key fails LOUDLY as
 * envelope_drift with the body echoed — never silently wrong.
 */

export const listInvoiceProfiles = tool(
  "freshbooks_list_invoice_profiles",
  `List invoice profiles — recurring-invoice templates. Answers "which invoices generate automatically, on what schedule, for which client?". Generated invoices themselves appear in freshbooks_list_invoices. ${RAW_TIER_DESC}`,
  {},
  async () => {
    try {
      const accountId = getAccountId();
      const result = await rawList({
        path: `/accounting/account/${accountId}/invoice_profiles/invoice_profiles`,
        envelopeKey: "invoice_profiles",
        name: "List Invoice Profiles",
      });
      return renderRaw(result);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to list invoice profiles: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);

export const getInvoiceProfile = tool(
  "freshbooks_get_invoice_profile",
  `Get one invoice profile (recurring-invoice template) by ID. IDs come from freshbooks_list_invoice_profiles. ${RAW_TIER_DESC}`,
  {
    profile_id: z.number().int().describe("The invoice profile ID (from freshbooks_list_invoice_profiles)"),
  },
  async (args) => {
    try {
      const accountId = getAccountId();
      const result = await rawRequest({
        method: "GET",
        path: `/accounting/account/${accountId}/invoice_profiles/invoice_profiles/${args.profile_id}`,
        name: "Get Invoice Profile",
      });
      return renderRaw(result, (data) => unwrapEnvelope(data, "invoice_profile", "object").value);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Failed to get invoice profile: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
