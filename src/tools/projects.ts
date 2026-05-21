import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import Project from "@freshbooks/api/dist/models/Project";
import { getFreshBooksClient, getBusinessId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listProjects = tool(
  "freshbooks_list_projects",
  "List projects for the FreshBooks account. Supports pagination and sorting. Returns project summaries including title, client, type, budget, and due date.",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    sort_by: z.string().optional().describe("Sort field (e.g. 'title', 'due_date', 'budget')"),
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

      const response = await client.projects.list(businessId, queryBuilders);

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
        content: [{ type: "text" as const, text: `Failed to list projects: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getProject = tool(
  "freshbooks_get_project",
  "Get a single project by ID. Returns full project details including title, client, type, description, budget, fixed price, and due date.",
  {
    project_id: z.number().int().describe("The project ID"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();
      const response = await client.projects.single(businessId, args.project_id);

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
        content: [{ type: "text" as const, text: `Failed to get project: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const createProject = tool(
  "freshbooks_create_project",
  "Create a new project in FreshBooks.",
  {
    title: z.string().describe("Project title (required)"),
    client_id: z.number().int().optional().describe("Client ID to associate with the project"),
    project_type: z.string().optional().describe("Project type (e.g. 'fixed_price', 'hourly_rate')"),
    description: z.string().optional().describe("Project description"),
    due_date: z.string().optional().describe("Project due date in YYYY-MM-DD format"),
    budget: z.number().optional().describe("Project budget in hours"),
    fixed_price: z.string().optional().describe("Fixed price for the project as a monetary amount string (e.g. '1500.00')"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      // Typed against the SDK's Project model so wrong property names fail the build.
      // A few fields are assigned values whose runtime type matches what the SDK
      // serializes (it passes these straight through to JSON) but differs from the
      // model's declared TS type — those assignments carry a narrow cast.
      const projectData: Partial<Project> = {
        title: args.title,
      };
      if (args.client_id !== undefined) projectData.clientId = args.client_id as unknown as Project["clientId"];
      if (args.project_type !== undefined) projectData.projectType = args.project_type as Project["projectType"];
      if (args.description !== undefined) projectData.description = args.description;
      if (args.due_date !== undefined) projectData.dueDate = args.due_date as unknown as Project["dueDate"];
      if (args.budget !== undefined) projectData.budget = args.budget as unknown as Project["budget"];
      if (args.fixed_price !== undefined) projectData.fixedPrice = args.fixed_price;

      const response = await client.projects.create(projectData as Project, businessId);

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
        content: [{ type: "text" as const, text: `Failed to create project: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateProject = tool(
  "freshbooks_update_project",
  "Update an existing project. Only provide fields that need to be changed.",
  {
    project_id: z.number().int().describe("The project ID to update"),
    title: z.string().optional().describe("Updated project title"),
    description: z.string().optional().describe("Updated project description"),
    due_date: z.string().optional().describe("Updated due date in YYYY-MM-DD format"),
    budget: z.number().optional().describe("Updated project budget in hours"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();

      // The Projects API requires title on every PUT; fetch and preserve it when
      // the caller doesn't supply a new one.
      let title = args.title;
      if (title === undefined) {
        const existing = await client.projects.single(businessId, args.project_id);
        if (!existing.ok || !existing.data?.title) {
          return {
            content: [{ type: "text" as const, text: `Could not load project ${args.project_id} to preserve its title: ${existing.error?.message ?? "no title on returned project"}` }],
            isError: true,
          };
        }
        title = existing.data.title;
      }

      // Typed against the SDK's Project model; dueDate/budget carry a narrow cast
      // because the tool's input types differ from the model's declared TS types.
      const projectData: Partial<Project> = { title };
      if (args.description !== undefined) projectData.description = args.description;
      if (args.due_date !== undefined) projectData.dueDate = args.due_date as unknown as Project["dueDate"];
      if (args.budget !== undefined) projectData.budget = args.budget as unknown as Project["budget"];

      const response = await client.projects.update(projectData as Project, businessId, args.project_id);

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
        content: [{ type: "text" as const, text: `Failed to update project: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { idempotentHint: true } }
);

export const deleteProject = tool(
  "freshbooks_delete_project",
  "Delete a project by ID. This action is permanent and cannot be undone.",
  {
    project_id: z.number().int().describe("The project ID to delete"),
  },
  async (args) => {
    try {
      const client = getFreshBooksClient();
      const businessId = getBusinessId();
      const response = await client.projects.delete(businessId, args.project_id);

      if (!response.ok) {
        return {
          content: [{ type: "text" as const, text: `FreshBooks error: ${response.error?.message ?? "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Project ${args.project_id} deleted.` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to delete project: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { destructiveHint: true } }
);
