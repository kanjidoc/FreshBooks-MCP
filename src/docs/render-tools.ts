interface ToolMeta {
  name: string;
  description: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * Render the live tool inventory for the `freshbooks_help` "tools" topic.
 *
 * Generated from the registry at call time, so adding or removing a tool is
 * reflected automatically with no documentation edit.
 *
 * The registry is pulled in with a lazy `require` rather than a top-level
 * `import` to break a module-load cycle: tool-registry → tools/help →
 * docs/render-tools → tool-registry. By the time this function is *called*
 * (tool invocation), every module is fully initialised.
 */
export function renderToolsTopic(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { allTools } = require("../tool-registry") as typeof import("../tool-registry");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RAW_TIER_DESC } = require("../raw-call") as typeof import("../raw-call");
  const tools = allTools as unknown as ToolMeta[];
  const lines: string[] = [
    "# FreshBooks MCP — Tool Inventory",
    "",
    `${tools.length} tools are registered. Every name is prefixed \`freshbooks_\`.`,
    "Annotations: read-only tools may run in parallel; destructive tools delete data;",
    "idempotent tools can be safely repeated. Tools tagged _raw_ reach endpoints",
    "the FreshBooks Node SDK never wrapped and return raw API field names",
    "(snake_case), unlike the camelCase of SDK-backed tools.",
    "",
  ];
  for (const tool of tools) {
    const tags: string[] = [];
    if (tool.annotations?.readOnlyHint) tags.push("read-only");
    if (tool.annotations?.destructiveHint) tags.push("destructive");
    if (tool.annotations?.idempotentHint) tags.push("idempotent");
    if (tool.description.includes(RAW_TIER_DESC)) tags.push("raw");
    const suffix = tags.length > 0 ? ` _(${tags.join(", ")})_` : "";
    lines.push(`- **${tool.name}**${suffix} — ${tool.description}`);
  }
  return lines.join("\n");
}
