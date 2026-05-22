import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { allTools } from "./tool-registry";
import { getVersion } from "./version";

/**
 * The FreshBooks MCP server. Every tool is registered through `tool-registry.ts`,
 * which wraps each handler with automatic OAuth token refresh. The handshake
 * version comes from `getVersion()` — see `src/version.ts`.
 */
export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: getVersion(),
  tools: allTools,
});
