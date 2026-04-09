import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listItems = tool(
  "freshbooks_list_items",
  "List items (products/services) for the FreshBooks account. Supports pagination and sorting. Returns item summaries including id, name, description, unit cost, and inventory.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'name', 'unit_cost')"),
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

      const response = await client.items.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list items: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getItem = tool(
  "freshbooks_get_item",
  "Get a single item (product/service) by ID. Returns full item details including name, description, unit cost, inventory, and tax IDs.",
  {
    item_id: z.string().describe("The item ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.items.single(accountId, args.item_id);

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
        content: [{ type: "text" as const, text: `Failed to get item: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createItem = tool(
  "freshbooks_create_item",
  "Create a new item (product or service) in FreshBooks. Items can be added to invoices as line items.",
  {
    name: z.string().describe("Item name"),
    description: z.string().optional().describe("Item description"),
    unit_cost: z.object({
      amount: z.string().describe("Unit cost as a string, e.g. '49.99'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).describe("Unit cost as a Money object"),
    inventory: z.number().optional().describe("Stock count for inventory tracking"),
    tax1: z.number().int().optional().describe("ID of the first tax to apply to this item"),
    tax2: z.number().int().optional().describe("ID of the second tax to apply to this item"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const itemData: Record<string, unknown> = {
        name: args.name,
        unitCost: { amount: args.unit_cost.amount, code: args.unit_cost.code },
      };
      if (args.description !== undefined) itemData.description = args.description;
      if (args.inventory !== undefined) itemData.inventory = args.inventory;
      if (args.tax1 !== undefined) itemData.tax1 = args.tax1;
      if (args.tax2 !== undefined) itemData.tax2 = args.tax2;

      const response = await client.items.create(itemData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create item: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateItem = tool(
  "freshbooks_update_item",
  "Update an existing item (product or service) in FreshBooks. Only provide the fields you want to change.",
  {
    item_id: z.string().describe("The item ID to update"),
    name: z.string().optional().describe("Updated item name"),
    description: z.string().optional().describe("Updated item description"),
    unit_cost: z.object({
      amount: z.string().describe("Unit cost as a string, e.g. '49.99'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Updated unit cost as a Money object"),
    inventory: z.number().optional().describe("Updated stock count"),
    tax1: z.number().int().optional().describe("Updated ID of the first tax"),
    tax2: z.number().int().optional().describe("Updated ID of the second tax"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.name !== undefined) updateData.name = args.name;
      if (args.description !== undefined) updateData.description = args.description;
      if (args.unit_cost !== undefined) updateData.unitCost = { amount: args.unit_cost.amount, code: args.unit_cost.code };
      if (args.inventory !== undefined) updateData.inventory = args.inventory;
      if (args.tax1 !== undefined) updateData.tax1 = args.tax1;
      if (args.tax2 !== undefined) updateData.tax2 = args.tax2;

      const response = await client.items.update(accountId, args.item_id, updateData);

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
        content: [{ type: "text" as const, text: `Failed to update item: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);
