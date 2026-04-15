import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerTimeEntryTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_time_entries", "List time entries. Supports pagination and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'started_at', 'duration')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order, endpointType: "project" });
        const data = await api.get(api.projectUrl("time_entries"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list time entries: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_time_entry", "Get a single time entry by ID.",
    { time_entry_id: z.number().int().describe("The time entry ID") },
    async (args) => {
      try {
        const data = await api.get(api.projectUrl(`time_entries/${args.time_entry_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get time entry: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_time_entry", "Create a new time entry. Duration is in seconds.",
    {
      started_at: z.string().describe("Start time in ISO 8601 format"),
      duration: z.number().int().min(0).describe("Duration in seconds"),
      is_logged: z.boolean().default(true).describe("Whether the time entry is logged (completed)"),
      client_id: z.number().int().optional().describe("Client ID"),
      project_id: z.number().int().optional().describe("Project ID"),
      task_id: z.number().int().optional().describe("Task ID"),
      service_id: z.number().int().optional().describe("Service ID"),
      note: z.string().optional().describe("Note about what was done"),
      billable: z.boolean().default(true).describe("Whether billable"),
    },
    async (args) => {
      try {
        const time_entry: Record<string, unknown> = { started_at: args.started_at, duration: args.duration, is_logged: args.is_logged, billable: args.billable };
        if (args.client_id) time_entry.client_id = args.client_id;
        if (args.project_id) time_entry.project_id = args.project_id;
        if (args.task_id) time_entry.task_id = args.task_id;
        if (args.service_id) time_entry.service_id = args.service_id;
        if (args.note) time_entry.note = args.note;
        const data = await api.post(api.projectUrl("time_entries"), { time_entry });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create time entry: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_time_entry", "Update an existing time entry. Duration is in seconds.",
    {
      time_entry_id: z.number().int().describe("The time entry ID to update"),
      duration: z.number().int().min(0).optional().describe("Updated duration in seconds"),
      note: z.string().optional().describe("Updated note"),
      billable: z.boolean().optional().describe("Updated billable status"),
    },
    async (args) => {
      try {
        const time_entry: Record<string, unknown> = {};
        if (args.duration !== undefined) time_entry.duration = args.duration;
        if (args.note !== undefined) time_entry.note = args.note;
        if (args.billable !== undefined) time_entry.billable = args.billable;
        const data = await api.put(api.projectUrl(`time_entries/${args.time_entry_id}`), { time_entry });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update time entry: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_time_entry", "Delete a time entry by ID. This action is permanent.",
    { time_entry_id: z.number().int().describe("The time entry ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.projectUrl(`time_entries/${args.time_entry_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete time entry: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
