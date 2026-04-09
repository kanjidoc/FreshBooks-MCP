import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getBusinessId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listTimeEntries = tool(
  "freshbooks_list_time_entries",
  "List time entries for the FreshBooks account. Supports pagination and sorting. Returns time entry summaries including duration, client, project, and notes.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'started_at', 'duration')"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      const queryBuilders = buildQueryBuilders({
        page: args.page,
        perPage: args.per_page,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      });

      const response = await client.timeEntries.list(businessId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list time entries: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getTimeEntry = tool(
  "freshbooks_get_time_entry",
  "Get a single time entry by ID. Returns full time entry details including duration, client, project, task, and billing status.",
  {
    time_entry_id: z.number().int().describe("The time entry ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();
      const response = await client.timeEntries.single(businessId, args.time_entry_id);

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
        content: [{ type: "text" as const, text: `Failed to get time entry: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createTimeEntry = tool(
  "freshbooks_create_time_entry",
  "Create a new time entry. Duration is in seconds.",
  {
    started_at: z.string().describe("Start time in ISO 8601 format, e.g. '2024-01-15T09:00:00Z'"),
    duration: z.number().int().min(0).describe("Duration in seconds"),
    is_logged: z.boolean().default(true).describe("Whether the time entry is logged (completed)"),
    client_id: z.number().int().optional().describe("Client ID to associate with"),
    project_id: z.number().int().optional().describe("Project ID to associate with"),
    task_id: z.number().int().optional().describe("Task ID to associate with"),
    service_id: z.number().int().optional().describe("Service ID to associate with"),
    note: z.string().optional().describe("Note about what was done"),
    billable: z.boolean().default(true).describe("Whether the time entry is billable"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      const entryData: Record<string, unknown> = {
        startedAt: new Date(args.started_at),
        duration: args.duration,
        isLogged: args.is_logged,
        billable: args.billable,
      };
      if (args.client_id) entryData.clientId = args.client_id;
      if (args.project_id) entryData.projectId = args.project_id;
      if (args.task_id) entryData.taskId = args.task_id;
      if (args.service_id) entryData.serviceId = args.service_id;
      if (args.note) entryData.note = args.note;

      const response = await client.timeEntries.create(entryData as any, businessId);

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
        content: [{ type: "text" as const, text: `Failed to create time entry: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
