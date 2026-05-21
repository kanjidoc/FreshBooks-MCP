import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { allTools } from "./tool-registry";

/**
 * The FreshBooks MCP server. Every tool is registered through `tool-registry.ts`,
 * which wraps each handler with automatic OAuth token refresh.
 */
export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: "2.0.0",
  tools: allTools,
});
