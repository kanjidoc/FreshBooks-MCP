import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerBillVendorTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_bill_vendors", "List bill vendors. Supports pagination, search by name, and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      search_vendor_name: z.string().optional().describe("Filter by vendor name (partial/like match)"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'vendor_name', 'updated')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({
          page: args.page, perPage: args.per_page,
          searchLike: { ...(args.search_vendor_name && { vendor_name_like: args.search_vendor_name }) },
          sortBy: args.sort_by, sortOrder: args.sort_order,
        });
        const data = await api.get(api.accountingUrl("bills/bill_vendors"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list bill vendors: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_bill_vendor", "Get a single bill vendor by ID.",
    { vendor_id: z.number().int().describe("The bill vendor ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`bills/bill_vendors/${args.vendor_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get bill vendor: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_bill_vendor", "Create a new bill vendor.",
    {
      vendor_name: z.string().describe("The vendor/company name (required)"),
      first_name: z.string().optional().describe("Contact first name"),
      last_name: z.string().optional().describe("Contact last name"),
      email: z.string().optional().describe("Vendor email"),
      phone: z.string().optional().describe("Vendor phone"),
      account_number: z.string().optional().describe("Account number"),
      city: z.string().optional().describe("City"),
      province: z.string().optional().describe("State/province"),
      country: z.string().optional().describe("Country"),
      postal_code: z.string().optional().describe("Postal/zip code"),
      currency_code: z.string().default("USD").describe("Currency code"),
    },
    async (args) => {
      try {
        const bill_vendor: Record<string, unknown> = { vendor_name: args.vendor_name, currency_code: args.currency_code };
        if (args.first_name) bill_vendor.first_name = args.first_name;
        if (args.last_name) bill_vendor.last_name = args.last_name;
        if (args.email) bill_vendor.email = args.email;
        if (args.phone) bill_vendor.phone = args.phone;
        if (args.account_number) bill_vendor.account_number = args.account_number;
        if (args.city) bill_vendor.city = args.city;
        if (args.province) bill_vendor.province = args.province;
        if (args.country) bill_vendor.country = args.country;
        if (args.postal_code) bill_vendor.postal_code = args.postal_code;
        const data = await api.post(api.accountingUrl("bills/bill_vendors"), { bill_vendor });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create bill vendor: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_bill_vendor", "Update an existing bill vendor.",
    {
      vendor_id: z.number().int().describe("The bill vendor ID to update"),
      vendor_name: z.string().optional().describe("Updated vendor name"),
      first_name: z.string().optional().describe("Updated first name"),
      last_name: z.string().optional().describe("Updated last name"),
      email: z.string().optional().describe("Updated email"),
      phone: z.string().optional().describe("Updated phone"),
      account_number: z.string().optional().describe("Updated account number"),
      city: z.string().optional().describe("Updated city"),
      province: z.string().optional().describe("Updated state/province"),
      country: z.string().optional().describe("Updated country"),
      postal_code: z.string().optional().describe("Updated postal code"),
      currency_code: z.string().optional().describe("Updated currency code"),
    },
    async (args) => {
      try {
        const bill_vendor: Record<string, unknown> = {};
        if (args.vendor_name !== undefined) bill_vendor.vendor_name = args.vendor_name;
        if (args.first_name !== undefined) bill_vendor.first_name = args.first_name;
        if (args.last_name !== undefined) bill_vendor.last_name = args.last_name;
        if (args.email !== undefined) bill_vendor.email = args.email;
        if (args.phone !== undefined) bill_vendor.phone = args.phone;
        if (args.account_number !== undefined) bill_vendor.account_number = args.account_number;
        if (args.city !== undefined) bill_vendor.city = args.city;
        if (args.province !== undefined) bill_vendor.province = args.province;
        if (args.country !== undefined) bill_vendor.country = args.country;
        if (args.postal_code !== undefined) bill_vendor.postal_code = args.postal_code;
        if (args.currency_code !== undefined) bill_vendor.currency_code = args.currency_code;
        const data = await api.put(api.accountingUrl(`bills/bill_vendors/${args.vendor_id}`), { bill_vendor });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update bill vendor: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_bill_vendor", "Delete a bill vendor by ID.",
    { vendor_id: z.number().int().describe("The bill vendor ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.accountingUrl(`bills/bill_vendors/${args.vendor_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete bill vendor: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
