import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerClientTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool(
    "freshbooks_list_clients",
    "List clients for the FreshBooks account. Supports pagination, search filters, sorting, and includes. Returns client names, emails, organizations, and contact details.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      search_email: z.string().optional().describe("Filter by email (exact match)"),
      search_organization: z.string().optional().describe("Filter by organization name (like/partial match)"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'email', 'organization', 'updated')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
      includes: z.array(z.string()).optional().describe("Related resources to include"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({
          page: args.page,
          perPage: args.per_page,
          search: {
            ...(args.search_email && { email: args.search_email }),
          },
          searchLike: {
            ...(args.search_organization && { organization_like: args.search_organization }),
          },
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
          includes: args.includes,
        });
        const data = await api.get(api.accountingUrl("users/clients"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to list clients: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "freshbooks_get_client",
    "Get a single client by ID. Returns full client details including contact info, billing address, and account settings.",
    { client_id: z.string().describe("The client ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`users/clients/${args.client_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to get client: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "freshbooks_create_client",
    "Create a new client in FreshBooks. At minimum provide a first name or organization.",
    {
      first_name: z.string().optional().describe("Client first name"),
      last_name: z.string().optional().describe("Client last name"),
      organization: z.string().optional().describe("Company/organization name"),
      email: z.string().email().optional().describe("Client email address"),
      phone: z.string().optional().describe("Business phone number"),
      currency_code: z.string().default("USD").describe("Default currency code, e.g. 'USD'"),
      note: z.string().optional().describe("Internal note about the client"),
      p_street: z.string().optional().describe("Billing street address"),
      p_city: z.string().optional().describe("Billing city"),
      p_province: z.string().optional().describe("Billing state/province"),
      p_code: z.string().optional().describe("Billing postal/zip code"),
      p_country: z.string().optional().describe("Billing country"),
    },
    async (args) => {
      try {
        const client: Record<string, unknown> = {};
        if (args.first_name) client.fname = args.first_name;
        if (args.last_name) client.lname = args.last_name;
        if (args.organization) client.organization = args.organization;
        if (args.email) client.email = args.email;
        if (args.phone) client.bus_phone = args.phone;
        if (args.currency_code) client.currency_code = args.currency_code;
        if (args.note) client.note = args.note;
        if (args.p_street) client.p_street = args.p_street;
        if (args.p_city) client.p_city = args.p_city;
        if (args.p_province) client.p_province = args.p_province;
        if (args.p_code) client.p_code = args.p_code;
        if (args.p_country) client.p_country = args.p_country;

        const data = await api.post(api.accountingUrl("users/clients"), { client });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to create client: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "freshbooks_update_client",
    "Update an existing client. Only provide the fields you want to change.",
    {
      client_id: z.string().describe("The client ID to update"),
      first_name: z.string().optional().describe("Updated first name"),
      last_name: z.string().optional().describe("Updated last name"),
      organization: z.string().optional().describe("Updated organization name"),
      email: z.string().email().optional().describe("Updated email"),
      phone: z.string().optional().describe("Updated business phone"),
      note: z.string().optional().describe("Updated internal note"),
    },
    async (args) => {
      try {
        const client: Record<string, unknown> = {};
        if (args.first_name !== undefined) client.fname = args.first_name;
        if (args.last_name !== undefined) client.lname = args.last_name;
        if (args.organization !== undefined) client.organization = args.organization;
        if (args.email !== undefined) client.email = args.email;
        if (args.phone !== undefined) client.bus_phone = args.phone;
        if (args.note !== undefined) client.note = args.note;

        const data = await api.put(api.accountingUrl(`users/clients/${args.client_id}`), { client });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update client: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "freshbooks_delete_client",
    "Delete a client by ID (soft delete — sets vis_state to deleted).",
    { client_id: z.string().describe("The client ID to delete") },
    async (args) => {
      try {
        const data = await api.put(
          api.accountingUrl(`users/clients/${args.client_id}`),
          { client: { vis_state: 1 } }
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to delete client: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
