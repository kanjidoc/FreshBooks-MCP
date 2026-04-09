import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { freshbooksServer } from "./server";

// The server is passed to query() via mcpServers.
// This entry point can be used to test the server or integrate with a host.
export { freshbooksServer };
