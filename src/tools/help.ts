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
import { renderReportsTopic } from "../docs/render-reports";
import { renderSetupTopic } from "../docs/render-setup";
import { getVersion } from "../version";

/**
 * Every help topic, in the order the `index` lists them. Exported so
 * `test/help-topics.test.ts` can hold all three hand-maintained lists — this
 * enum, the `index` topic's bullets, and the `overview` topic's closing list —
 * to the same set.
 */
export const HELP_TOPICS = [
  "index",
  "overview",
  "architecture",
  "tools",
  "reports",
  "authentication",
  "setup",
  "extending",
  "conventions",
  "troubleshooting",
  "version",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** Render the `index` topic — the list of all help topics, headed by the version. */
function renderIndexTopic(): string {
  return `# FreshBooks MCP — Help

Version ${getVersion()}. This server documents itself. Call \`freshbooks_help\`
with a \`topic\`:

- **overview** — what this server is and the key concepts (start here)
- **architecture** — file layout and how a request flows
- **tools** — the full live inventory of every registered tool
- **reports** — which params each report endpoint honors (and silently ignores)
- **authentication** — OAuth, token files, auto-refresh, recovery
- **setup** — the install flow step by step: the kickoff prompt, what each step
  asks of whom, and how to add another FreshBooks login
- **extending** — how to add a new tool, and the SDK gotchas to avoid
- **conventions** — naming, error handling, money, dates
- **troubleshooting** — common failures and how to fix them
- **version** — the installed version, how to check for updates, how to update`;
}

/**
 * Topic → content. Built lazily, INSIDE the call: `docs/content.ts` imports the
 * tool registry, which imports this module, so reading its `TOPIC_*` consts at
 * module scope would hit the temporal dead zone whenever a caller imports
 * `docs/content` first. The `Record<HelpTopic, …>` type is the guard that every
 * enum topic has a section — a missing one is a compile error, not a silent
 * fallback to the index.
 */
function sections(): Record<HelpTopic, string | (() => string)> {
  return {
    index: renderIndexTopic,
    overview: renderOverviewTopic,
    architecture: TOPIC_ARCHITECTURE,
    tools: renderToolsTopic,
    reports: renderReportsTopic,
    authentication: TOPIC_AUTHENTICATION,
    setup: renderSetupTopic,
    extending: TOPIC_EXTENDING,
    conventions: TOPIC_CONVENTIONS,
    troubleshooting: TOPIC_TROUBLESHOOTING,
    version: renderVersionTopic,
  };
}

/** Render one help topic. Exported for the drift tests; the tool just wraps it. */
export function renderHelpTopic(topic: HelpTopic): string {
  const entry = sections()[topic] ?? renderIndexTopic;
  return typeof entry === "function" ? entry() : entry;
}

/**
 * `freshbooks_help` — the self-documenting tool. Returns embedded documentation
 * so an AI assistant (or a developer) can understand how this project is built
 * without reading the source. All content is compiled into the build.
 */
export const freshbooksHelp = tool(
  "freshbooks_help",
  "Returns embedded documentation about how this FreshBooks MCP server is built — architecture, conventions, authentication, the full tool inventory, how to add tools, the step-by-step setup flow (installing it, or adding another FreshBooks login), troubleshooting, and the installed version (and whether a newer one is available). Call this to understand the project, or to answer 'what version do I have?' / 'is my FreshBooks MCP up to date?'.",
  {
    topic: z
      .enum(HELP_TOPICS)
      .default("index")
      .describe("Which documentation section to retrieve. 'index' lists all sections."),
  },
  async (args) => {
    try {
      return { content: [{ type: "text" as const, text: renderHelpTopic(args.topic) }] };
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
