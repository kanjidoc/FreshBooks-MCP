import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  renderOverviewTopic,
  renderVersionTopic,
  TOPIC_ARCHITECTURE,
  TOPIC_AUTHENTICATION,
  TOPIC_EXTENDING,
  TOPIC_CONVENTIONS,
  TOPIC_TROUBLESHOOTING,
} from "../docs/content";
import { renderToolsTopic } from "../docs/render-tools";
import { getVersion } from "../version";

/** Render the `index` topic — the list of all help topics, headed by the version. */
function renderIndexTopic(): string {
  return `# FreshBooks MCP — Help

Version ${getVersion()}. This server documents itself. Call \`freshbooks_help\`
with a \`topic\`:

- **overview** — what this server is and the key concepts (start here)
- **architecture** — file layout and how a request flows
- **tools** — the full live inventory of every registered tool
- **authentication** — OAuth, token files, auto-refresh, recovery
- **extending** — how to add a new tool, and the SDK gotchas to avoid
- **conventions** — naming, error handling, money, dates
- **troubleshooting** — common failures and how to fix them
- **version** — the installed version, how to check for updates, how to update`;
}

/**
 * `freshbooks_help` — the self-documenting tool. Returns embedded documentation
 * so an AI assistant (or a developer) can understand how this project is built
 * without reading the source. All content is compiled into the build.
 */
export const freshbooksHelp = tool(
  "freshbooks_help",
  "Returns embedded documentation about how this FreshBooks MCP server is built — architecture, conventions, authentication, the full tool inventory, how to add tools, troubleshooting, and the installed version (and whether a newer one is available). Call this to understand the project, or to answer 'what version do I have?' / 'is my FreshBooks MCP up to date?'.",
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
        "version",
      ])
      .default("index")
      .describe("Which documentation section to retrieve. 'index' lists all sections."),
  },
  async (args) => {
    try {
      const sections: Record<string, string | (() => string)> = {
        index: renderIndexTopic,
        overview: renderOverviewTopic,
        architecture: TOPIC_ARCHITECTURE,
        tools: renderToolsTopic,
        authentication: TOPIC_AUTHENTICATION,
        extending: TOPIC_EXTENDING,
        conventions: TOPIC_CONVENTIONS,
        troubleshooting: TOPIC_TROUBLESHOOTING,
        version: renderVersionTopic,
      };
      const entry = sections[args.topic] ?? renderIndexTopic;
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
