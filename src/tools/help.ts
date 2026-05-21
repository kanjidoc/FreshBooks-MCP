import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  TOPIC_OVERVIEW,
  TOPIC_ARCHITECTURE,
  TOPIC_AUTHENTICATION,
  TOPIC_EXTENDING,
  TOPIC_CONVENTIONS,
  TOPIC_TROUBLESHOOTING,
} from "../docs/content";
import { renderToolsTopic } from "../docs/render-tools";

const TOPIC_INDEX = `# FreshBooks MCP — Help

This server documents itself. Call \`freshbooks_help\` with a \`topic\`:

- **overview** — what this server is and the key concepts (start here)
- **architecture** — file layout and how a request flows
- **tools** — the full live inventory of every registered tool
- **authentication** — OAuth, token files, auto-refresh, recovery
- **extending** — how to add a new tool, and the SDK gotchas to avoid
- **conventions** — naming, error handling, money, dates
- **troubleshooting** — common failures and how to fix them`;

/**
 * `freshbooks_help` — the self-documenting tool. Returns embedded documentation
 * so an AI assistant (or a developer) can understand how this project is built
 * without reading the source. All content is compiled into the build.
 */
export const freshbooksHelp = tool(
  "freshbooks_help",
  "Returns embedded documentation about how this FreshBooks MCP server is built — architecture, conventions, authentication, the full tool inventory, how to add tools, and troubleshooting. Call this to understand the project without reading its source.",
  {
    topic: z
      .enum([
        "index",
        "overview",
        "architecture",
        "tools",
        "authentication",
        "extending",
        "conventions",
        "troubleshooting",
      ])
      .default("index")
      .describe("Which documentation section to retrieve. 'index' lists all sections."),
  },
  async (args) => {
    try {
      const sections: Record<string, string | (() => string)> = {
        index: TOPIC_INDEX,
        overview: TOPIC_OVERVIEW,
        architecture: TOPIC_ARCHITECTURE,
        tools: renderToolsTopic,
        authentication: TOPIC_AUTHENTICATION,
        extending: TOPIC_EXTENDING,
        conventions: TOPIC_CONVENTIONS,
        troubleshooting: TOPIC_TROUBLESHOOTING,
      };
      const entry = sections[args.topic] ?? TOPIC_INDEX;
      const text = typeof entry === "function" ? entry() : entry;
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to render help: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
