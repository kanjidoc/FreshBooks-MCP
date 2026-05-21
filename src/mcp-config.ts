import * as path from "path";

/**
 * Build the FreshBooks MCP server entry for Claude Desktop's config file and a
 * project `.mcp.json`: just `{ command, args }`. There is deliberately **no**
 * `env` block — the server loads its credentials from `.env` itself (see
 * `src/load-env.ts`), so a rotating token is never duplicated into a launcher
 * config where it would go stale.
 */
export function buildClaudeServerConfig(projectDir: string) {
  return {
    command: "node",
    args: [path.join(projectDir, "dist", "index.js")],
  };
}

/**
 * Build the server entry for the `claude mcp add-json` CLI — the same
 * `{ command, args }` plus an explicit `type: "stdio"`. No `env` block, for the
 * same reason as above.
 */
export function buildClaudeCodeServerJson(projectDir: string) {
  return {
    type: "stdio" as const,
    ...buildClaudeServerConfig(projectDir),
  };
}
