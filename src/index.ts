import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { freshbooksServer } from "./server";
import { ensureFreshToken } from "./freshbooks-client";

async function main() {
  try {
    await ensureFreshToken();
  } catch (err) {
    console.error("[freshbooks] token refresh check failed, continuing with existing token:", err);
  }
  const transport = new StdioServerTransport();
  await freshbooksServer.instance.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start FreshBooks MCP server:", err);
  process.exit(1);
});
