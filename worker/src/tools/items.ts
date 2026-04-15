import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerItemTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_items", "List items (products/services) for the FreshBooks account. Supports pagination and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'name', 'unit_cost')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order });
        const data = await api.get(api.accountingUrl("items/items"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list items: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_item", "Get a single item by ID.",
    { item_id: z.string().describe("The item ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`items/items/${args.item_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get item: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_item", "Create a new item (product or service) in FreshBooks.",
    {
      name: z.string().describe("Item name"),
      description: z.string().optional().describe("Item description"),
      unit_cost: z.object({ amount: z.string().describe("Unit cost as a string"), code: z.string().default("USD").describe("Currency code") }).describe("Unit cost"),
      inventory: z.number().optional().describe("Stock count for inventory tracking"),
      tax1: z.number().int().optional().describe("ID of the first tax to apply"),
      tax2: z.number().int().optional().describe("ID of the second tax to apply"),
    },
    async (args) => {
      try {
        const item: Record<string, unknown> = { name: args.name, unit_cost: { amount: args.unit_cost.amount, code: args.unit_cost.code } };
        if (args.description !== undefined) item.description = args.description;
        if (args.inventory !== undefined) item.inventory = args.inventory;
        if (args.tax1 !== undefined) item.tax1 = args.tax1;
        if (args.tax2 !== undefined) item.tax2 = args.tax2;
        const data = await api.post(api.accountingUrl("items/items"), { item });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create item: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_item", "Update an existing item. Only provide the fields you want to change.",
    {
      item_id: z.string().describe("The item ID to update"),
      name: z.string().optional().describe("Updated item name"),
      description: z.string().optional().describe("Updated description"),
      unit_cost: z.object({ amount: z.string().describe("Unit cost"), code: z.string().default("USD").describe("Currency code") }).optional().describe("Updated unit cost"),
      inventory: z.number().optional().describe("Updated stock count"),
      tax1: z.number().int().optional().describe("Updated first tax ID"),
      tax2: z.number().int().optional().describe("Updated second tax ID"),
    },
    async (args) => {
      try {
        const item: Record<string, unknown> = {};
        if (args.name !== undefined) item.name = args.name;
        if (args.description !== undefined) item.description = args.description;
        if (args.unit_cost !== undefined) item.unit_cost = { amount: args.unit_cost.amount, code: args.unit_cost.code };
        if (args.inventory !== undefined) item.inventory = args.inventory;
        if (args.tax1 !== undefined) item.tax1 = args.tax1;
        if (args.tax2 !== undefined) item.tax2 = args.tax2;
        const data = await api.put(api.accountingUrl(`items/items/${args.item_id}`), { item });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update item: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
