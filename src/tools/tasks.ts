import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listTasks = tool(
  "freshbooks_list_tasks",
  "List tasks for the FreshBooks account. Supports pagination and sorting. Returns task summaries including name, description, rate, and billable status.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'name', 'rate')"),
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

      const response = await client.tasks.list(accountId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getTask = tool(
  "freshbooks_get_task",
  "Get a single task by ID. Returns full task details including name, description, rate, and billable status.",
  {
    task_id: z.number().int().describe("The task ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.tasks.single(accountId, args.task_id);

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
        content: [{ type: "text" as const, text: `Failed to get task: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createTask = tool(
  "freshbooks_create_task",
  "Create a new task. Requires a name. Optionally set a description, hourly rate, and whether the task is billable.",
  {
    name: z.string().describe("Task name"),
    description: z.string().optional().describe("Task description"),
    rate: z.object({
      amount: z.string().describe("Rate amount as a string, e.g. '100.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Hourly rate for the task"),
    billable: z.boolean().default(true).describe("Whether the task is billable"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const taskData: Record<string, unknown> = {
        name: args.name,
        billable: args.billable,
      };
      if (args.description !== undefined) taskData.description = args.description;
      if (args.rate !== undefined) taskData.rate = { amount: args.rate.amount, code: args.rate.code };

      const response = await client.tasks.create(taskData as any, accountId);

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
        content: [{ type: "text" as const, text: `Failed to create task: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateTask = tool(
  "freshbooks_update_task",
  "Update an existing task. Only provide the fields you want to change.",
  {
    task_id: z.number().int().describe("The task ID to update"),
    name: z.string().optional().describe("Updated task name"),
    description: z.string().optional().describe("Updated task description"),
    rate: z.object({
      amount: z.string().describe("Rate amount as a string, e.g. '100.00'"),
      code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
    }).optional().describe("Updated hourly rate for the task"),
    billable: z.boolean().optional().describe("Updated billable status"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();

      const updateData: Record<string, unknown> = {};
      if (args.name !== undefined) updateData.name = args.name;
      if (args.description !== undefined) updateData.description = args.description;
      if (args.rate !== undefined) updateData.rate = { amount: args.rate.amount, code: args.rate.code };
      if (args.billable !== undefined) updateData.billable = args.billable;

      const response = await client.tasks.update(updateData as any, accountId, args.task_id);

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
        content: [{ type: "text" as const, text: `Failed to update task: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteTask = tool(
  "freshbooks_delete_task",
  "Delete a task by ID. This action is permanent and cannot be undone.",
  {
    task_id: z.number().int().describe("The task ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.tasks.delete(accountId, args.task_id);

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
        content: [{ type: "text" as const, text: `Failed to delete task: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
