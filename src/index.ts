import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { freshbooksServer } from "./server";

async function main() {
  const transport = new StdioServerTransport();
  await freshbooksServer.instance.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start FreshBooks MCP server:", err);
  process.exit(1);
});
