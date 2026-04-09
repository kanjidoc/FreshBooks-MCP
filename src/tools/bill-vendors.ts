import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listBillVendors = tool(
  "freshbooks_list_bill_vendors",
  "List bill vendors for the FreshBooks account. Supports pagination, search by vendor name, and sorting. Returns vendor contact details, address, and currency info.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    search_vendor_name: z.string().optional().describe("Filter by vendor name (partial/like match)"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'vendor_name', 'updated')"),
    sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      });

      if (args.search_vendor_name) {
        const { SearchQueryBuilder } = await import("@freshbooks/api/dist/models/builders");
        const vendorSearch = new SearchQueryBuilder();
        vendorSearch.like("vendor_name_like", args.search_vendor_name);
        queryBuilders.push(vendorSearch);
      }

      const response = await client.billVendors.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list bill vendors: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getBillVendor = tool(
  "freshbooks_get_bill_vendor",
  "Get a single bill vendor by ID. Returns full vendor details including contact info, address, and currency code.",
  {
    vendor_id: z.number().int().describe("The bill vendor ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.billVendors.single(accountId, args.vendor_id);

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
        content: [{ type: "text" as const, text: `Failed to get bill vendor: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createBillVendor = tool(
  "freshbooks_create_bill_vendor",
  "Create a new bill vendor in FreshBooks. At minimum provide a vendor name.",
  {
    vendor_name: z.string().describe("The vendor/company name (required)"),
    first_name: z.string().optional().describe("Vendor contact first name"),
    last_name: z.string().optional().describe("Vendor contact last name"),
    email: z.string().optional().describe("Vendor email address"),
    phone: z.string().optional().describe("Vendor phone number"),
    account_number: z.string().optional().describe("Account number for this vendor"),
    city: z.string().optional().describe("Vendor city"),
    province: z.string().optional().describe("Vendor state/province"),
    country: z.string().optional().describe("Vendor country"),
    postal_code: z.string().optional().describe("Vendor postal/zip code"),
    currency_code: z.string().default("USD").describe("Vendor currency code, e.g. 'USD'"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const vendorData: Record<string, unknown> = {
        vendorName: args.vendor_name,
        currencyCode: args.currency_code,
      };
      if (args.first_name) vendorData.fName = args.first_name;
      if (args.last_name) vendorData.lName = args.last_name;
      if (args.email) vendorData.email = args.email;
      if (args.phone) vendorData.phone = args.phone;
      if (args.account_number) vendorData.accountNumber = args.account_number;
      if (args.city) vendorData.city = args.city;
      if (args.province) vendorData.province = args.province;
      if (args.country) vendorData.country = args.country;
      if (args.postal_code) vendorData.postalCode = args.postal_code;

      const response = await client.billVendors.create(vendorData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create bill vendor: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateBillVendor = tool(
  "freshbooks_update_bill_vendor",
  "Update an existing bill vendor. Only provide the fields you want to change.",
  {
    vendor_id: z.number().int().describe("The bill vendor ID to update"),
    vendor_name: z.string().optional().describe("Updated vendor/company name"),
    first_name: z.string().optional().describe("Updated contact first name"),
    last_name: z.string().optional().describe("Updated contact last name"),
    email: z.string().optional().describe("Updated email address"),
    phone: z.string().optional().describe("Updated phone number"),
    account_number: z.string().optional().describe("Updated account number"),
    city: z.string().optional().describe("Updated city"),
    province: z.string().optional().describe("Updated state/province"),
    country: z.string().optional().describe("Updated country"),
    postal_code: z.string().optional().describe("Updated postal/zip code"),
    currency_code: z.string().optional().describe("Updated currency code, e.g. 'USD'"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.vendor_name !== undefined) updateData.vendorName = args.vendor_name;
      if (args.first_name !== undefined) updateData.fName = args.first_name;
      if (args.last_name !== undefined) updateData.lName = args.last_name;
      if (args.email !== undefined) updateData.email = args.email;
      if (args.phone !== undefined) updateData.phone = args.phone;
      if (args.account_number !== undefined) updateData.accountNumber = args.account_number;
      if (args.city !== undefined) updateData.city = args.city;
      if (args.province !== undefined) updateData.province = args.province;
      if (args.country !== undefined) updateData.country = args.country;
      if (args.postal_code !== undefined) updateData.postalCode = args.postal_code;
      if (args.currency_code !== undefined) updateData.currencyCode = args.currency_code;

      const response = await client.billVendors.update(updateData as any, accountId, args.vendor_id);

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
        content: [{ type: "text" as const, text: `Failed to update bill vendor: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteBillVendor = tool(
  "freshbooks_delete_bill_vendor",
  "Delete a bill vendor by ID. This action is permanent and cannot be undone.",
  {
    vendor_id: z.number().int().describe("The bill vendor ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.billVendors.delete(accountId, args.vendor_id);

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
        content: [{ type: "text" as const, text: `Failed to delete bill vendor: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
