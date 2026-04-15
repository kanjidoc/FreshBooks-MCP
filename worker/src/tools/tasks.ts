import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerTaskTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_tasks", "List tasks. Supports pagination and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'name', 'rate')"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order });
        const data = await api.get(api.accountingUrl("projects/tasks"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_task", "Get a single task by ID.",
    { task_id: z.number().int().describe("The task ID") },
    async (args) => {
      try {
        const data = await api.get(api.accountingUrl(`projects/tasks/${args.task_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get task: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_task", "Create a new task.",
    {
      name: z.string().describe("Task name"),
      description: z.string().optional().describe("Task description"),
      rate: z.object({ amount: z.string().describe("Rate as string"), code: z.string().default("USD").describe("Currency code") }).optional().describe("Hourly rate"),
      billable: z.boolean().default(true).describe("Whether billable"),
    },
    async (args) => {
      try {
        const task: Record<string, unknown> = { name: args.name, billable: args.billable };
        if (args.description !== undefined) task.description = args.description;
        if (args.rate !== undefined) task.rate = { amount: args.rate.amount, code: args.rate.code };
        const data = await api.post(api.accountingUrl("projects/tasks"), { task });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create task: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_task", "Update an existing task.",
    {
      task_id: z.number().int().describe("The task ID to update"),
      name: z.string().optional().describe("Updated name"),
      description: z.string().optional().describe("Updated description"),
      rate: z.object({ amount: z.string().describe("Rate as string"), code: z.string().default("USD").describe("Currency code") }).optional().describe("Updated rate"),
      billable: z.boolean().optional().describe("Updated billable status"),
    },
    async (args) => {
      try {
        const task: Record<string, unknown> = {};
        if (args.name !== undefined) task.name = args.name;
        if (args.description !== undefined) task.description = args.description;
        if (args.rate !== undefined) task.rate = { amount: args.rate.amount, code: args.rate.code };
        if (args.billable !== undefined) task.billable = args.billable;
        const data = await api.put(api.accountingUrl(`projects/tasks/${args.task_id}`), { task });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update task: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_task", "Delete a task by ID.",
    { task_id: z.number().int().describe("The task ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.accountingUrl(`projects/tasks/${args.task_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete task: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
