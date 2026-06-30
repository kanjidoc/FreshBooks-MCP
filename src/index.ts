import "./load-env";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { freshbooksServer } from "./server";
import { ensureFreshTokens } from "./freshbooks-client";
import { lockPathFor, writeLock, removeLock } from "./server-lock";

async function main() {
  const lock = lockPathFor(join(__dirname, ".."));
  // U8 — an advisory lock that cannot be written (read-only dir / EBUSY) must
  // never crash the server. Log and continue; migration's pid-liveness check
  // simply won't see this process, which is a safe degradation.
  try {
    writeLock(lock);
  } catch (err) {
    console.error(
      "[freshbooks] could not write server lock, continuing without it:",
      err instanceof Error ? err.message : err,
    );
  }
  const cleanup = () => removeLock(lock);
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // Connect FIRST so a slow/rate-limited refresh can never exceed the MCP init
  // timeout and fail the whole server (Amendment A4). Lazy pre-call refresh in
  // withAccount covers correctness; this startup pass is best-effort.
  const transport = new StdioServerTransport();
  await freshbooksServer.instance.connect(transport);

  ensureFreshTokens().catch((err) =>
    console.error(
      "[freshbooks] background startup refresh error:",
      err instanceof Error ? err.message : err,
    ),
  );
}

main().catch((err) => {
  console.error("Failed to start FreshBooks MCP server:", err);
  process.exit(1);
});
