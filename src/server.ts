import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { allTools } from "./tool-registry";

// The server version reported in the MCP `initialize` handshake comes straight
// from package.json — its single source of truth — so the two can never drift.
// Read with `require` rather than a top-level JSON `import`: package.json sits
// outside `rootDir` (src/), and an `import` would pull it into the compilation
// and break the build. From the compiled dist/server.js, `../package.json`
// resolves to the package root, exactly as it does from src/ under ts-node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require("../package.json") as { version: string };

/**
 * The FreshBooks MCP server. Every tool is registered through `tool-registry.ts`,
 * which wraps each handler with automatic OAuth token refresh.
 */
export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version,
  tools: allTools,
});
