import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshBooksApiClient } from "../freshbooks-api/client";
import { buildQueryParams } from "../freshbooks-api/query-builder";

export function registerProjectTools(server: McpServer, api: FreshBooksApiClient) {
  server.tool("freshbooks_list_projects", "List projects. Supports pagination and sorting.",
    {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
      sort_by: z.string().optional().describe("Sort field (e.g. 'title', 'due_date', 'budget')"),
      sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
    },
    async (args) => {
      try {
        const qs = buildQueryParams({ page: args.page, perPage: args.per_page, sortBy: args.sort_by, sortOrder: args.sort_order, endpointType: "project" });
        const data = await api.get(api.projectUrl("projects"), qs);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to list projects: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_get_project", "Get a single project by ID.",
    { project_id: z.number().int().describe("The project ID") },
    async (args) => {
      try {
        const data = await api.get(api.projectUrl(`projects/${args.project_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to get project: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_create_project", "Create a new project.",
    {
      title: z.string().describe("Project title (required)"),
      client_id: z.number().int().optional().describe("Client ID"),
      project_type: z.string().optional().describe("Project type (e.g. 'fixed_price', 'hourly_rate')"),
      description: z.string().optional().describe("Project description"),
      due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
      budget: z.number().optional().describe("Budget in hours"),
      fixed_price: z.string().optional().describe("Fixed price as string (e.g. '1500.00')"),
    },
    async (args) => {
      try {
        const project: Record<string, unknown> = { title: args.title };
        if (args.client_id !== undefined) project.client_id = args.client_id;
        if (args.project_type !== undefined) project.project_type = args.project_type;
        if (args.description !== undefined) project.description = args.description;
        if (args.due_date !== undefined) project.due_date = args.due_date;
        if (args.budget !== undefined) project.budget = args.budget;
        if (args.fixed_price !== undefined) project.fixed_price = args.fixed_price;
        const data = await api.post(api.projectUrl("projects"), { project });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to create project: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_update_project", "Update an existing project.",
    {
      project_id: z.number().int().describe("The project ID to update"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description"),
      due_date: z.string().optional().describe("Updated due date"),
      budget: z.number().optional().describe("Updated budget in hours"),
    },
    async (args) => {
      try {
        const project: Record<string, unknown> = {};
        if (args.title !== undefined) project.title = args.title;
        if (args.description !== undefined) project.description = args.description;
        if (args.due_date !== undefined) project.due_date = args.due_date;
        if (args.budget !== undefined) project.budget = args.budget;
        const data = await api.put(api.projectUrl(`projects/${args.project_id}`), { project });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to update project: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );

  server.tool("freshbooks_delete_project", "Delete a project by ID. This action is permanent.",
    { project_id: z.number().int().describe("The project ID to delete") },
    async (args) => {
      try {
        const data = await api.delete(api.projectUrl(`projects/${args.project_id}`));
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? { deleted: true }, null, 2) }] };
      } catch (error) { return { content: [{ type: "text" as const, text: `Failed to delete project: ${error instanceof Error ? error.message : String(error)}` }], isError: true }; }
    }
  );
}
