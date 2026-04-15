import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";

export function registerServiceTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_services", "List services for the FreshBooks account.",
    {},
    async () => {
      try {
        const data = await api.get(api.projectUrl("services"));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list services: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_service", "Get a single service by ID.",
    { service_id: z.number().int().describe("The service ID") },
    async (args) => {
      try {
        const data = await api.get(api.projectUrl(`services/${args.service_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get service: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_service", "Create a new service.",
    {
      name: z.string().describe("Service name (required)"),
      billable: z.boolean().default(true).describe("Whether the service is billable"),
    },
    async (args) => {
      try {
        const data = await api.post(api.projectUrl("services"), { service: { name: args.name, billable: args.billable } });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create service: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
