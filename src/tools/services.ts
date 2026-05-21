import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import Service from "@freshbooks/api/dist/models/Service";
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
  "Create a new service in FreshBooks. Note: services are created billable — the FreshBooks SDK's transformServiceRequest serializes only the name, so a billable flag passed on creation would be silently ignored and is therefore not exposed.",
  {
    name: z.string().describe("Service name (required)"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      // Only `name` is sent: the SDK's transformServiceRequest (Service.js)
      // serializes nothing else, so `billable` cannot be set on creation.
      const serviceData: Service = {
        name: args.name,
      };

      const response = await client.services.create(serviceData, businessId);

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
