import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getBusinessId } from "../freshbooks-client";

export const listServices = tool(
  "freshbooks_list_services",
  "List services for the FreshBooks account. Returns service summaries including name and billable status.",
  {},
  async (_args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      const response = await client.services.list(businessId);

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
        content: [{ type: "text" as const, text: `Failed to list services: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getService = tool(
  "freshbooks_get_service",
  "Get a single service by ID. Returns full service details including name and billable status.",
  {
    service_id: z.number().int().describe("The service ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();
      const response = await client.services.single(businessId, args.service_id);

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
        content: [{ type: "text" as const, text: `Failed to get service: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createService = tool(
  "freshbooks_create_service",
  "Create a new service in FreshBooks.",
  {
    name: z.string().describe("Service name (required)"),
    billable: z.boolean().default(true).describe("Whether the service is billable (default: true)"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      const serviceData: Record<string, unknown> = {
        name: args.name,
        billable: args.billable,
      };

      const response = await client.services.create(serviceData as any, businessId);

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
        content: [{ type: "text" as const, text: `Failed to create service: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
