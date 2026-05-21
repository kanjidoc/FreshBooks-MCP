import * as path from "path";

/** The FreshBooks credentials the MCP server reads from its environment. */
export type FreshbooksEnv = Record<string, string>;

/**
 * Build the FreshBooks MCP server entry in the shape Claude Desktop's config
 * file and a project `.mcp.json` both expect: `{ command, args, env }`.
 */
export function buildClaudeServerConfig(env: FreshbooksEnv, projectDir: string) {
  return {
    command: "node",
    args: [path.join(projectDir, "dist", "index.js")],
    env,
  };
}

/**
 * Build the server entry in the shape the `claude mcp add-json` CLI expects —
 * the same `{ command, args, env }` plus an explicit `type: "stdio"`.
 */
export function buildClaudeCodeServerJson(env: FreshbooksEnv, projectDir: string) {
  return {
    type: "stdio" as const,
    ...buildClaudeServerConfig(env, projectDir),
  };
}
