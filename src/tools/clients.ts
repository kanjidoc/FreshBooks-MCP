import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listClients = tool(
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
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        search: {
          ...(args.search_email && { email: args.search_email }),
        },
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
        includes: args.includes,
      });

      // Handle 'like' search for organization separately
      if (args.search_organization) {
        const { SearchQueryBuilder } = await import("@freshbooks/api/dist/models/builders");
        const orgSearch = new SearchQueryBuilder();
        orgSearch.like("organization_like", args.search_organization);
        queryBuilders.push(orgSearch);
      }

      const response = await client.clients.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list clients: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getClient = tool(
  "freshbooks_get_client",
  "Get a single client by ID. Returns full client details including contact info, billing address, and account settings.",
  {
    client_id: z.string().describe("The client ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.clients.single(accountId, args.client_id);

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
        content: [{ type: "text" as const, text: `Failed to get client: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createClient = tool(
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
      const fbClient = getFreshBooksClient();
      const accountId = getAccountId();

      const clientData: Record<string, unknown> = {};
      if (args.first_name) clientData.fName = args.first_name;
      if (args.last_name) clientData.lName = args.last_name;
      if (args.organization) clientData.organization = args.organization;
      if (args.email) clientData.email = args.email;
      if (args.phone) clientData.busPhone = args.phone;
      if (args.currency_code) clientData.currencyCode = args.currency_code;
      if (args.note) clientData.note = args.note;
      if (args.p_street) clientData.pStreet = args.p_street;
      if (args.p_city) clientData.pCity = args.p_city;
      if (args.p_province) clientData.pProvince = args.p_province;
      if (args.p_code) clientData.pCode = args.p_code;
      if (args.p_country) clientData.pCountry = args.p_country;

      const response = await fbClient.clients.create(clientData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create client: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateClient = tool(
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
      const fbClient = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.first_name !== undefined) updateData.fName = args.first_name;
      if (args.last_name !== undefined) updateData.lName = args.last_name;
      if (args.organization !== undefined) updateData.organization = args.organization;
      if (args.email !== undefined) updateData.email = args.email;
      if (args.phone !== undefined) updateData.busPhone = args.phone;
      if (args.note !== undefined) updateData.note = args.note;

      const response = await fbClient.clients.update(updateData as any, accountId, args.client_id);

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
        content: [{ type: "text" as const, text: `Failed to update client: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteClient = tool(
  "freshbooks_delete_client",
  "Delete a client by ID. This action is permanent and cannot be undone.",
  {
    client_id: z.string().describe("The client ID to delete"),
  },
  async (args) => {
    try {
      const fbClient = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await fbClient.clients.delete(accountId, args.client_id);

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
        content: [{ type: "text" as const, text: `Failed to delete client: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
