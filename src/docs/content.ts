/**
 * Embedded self-documentation for the FreshBooks MCP server.
 *
 * Authored as TypeScript string constants so it compiles into `dist/` with the
 * rest of the build — the `freshbooks_help` tool serves it with zero runtime
 * file I/O, no network, and no chance of a missing asset after `git clone`.
 *
 * Keep these in sync with reality when the architecture changes. The tool
 * inventory is NOT here — it is generated live from the registry (render-tools.ts).
 */

export const TOPIC_OVERVIEW = `# FreshBooks MCP — Overview

This is a Model Context Protocol (MCP) server that exposes the FreshBooks
accounting API as tools for AI assistants. It is built on the official
**FreshBooks Node.js SDK** (\`@freshbooks/api\`) and the **Claude Agent SDK**
(\`@anthropic-ai/claude-agent-sdk\`).

- **75 tools** covering invoices, clients, expenses, payments, time entries,
  items, bills, credit notes, projects, services, tasks, journal entries,
  reports, and this \`freshbooks_help\` tool itself.
- Every credential is environment-variable driven — anyone can clone the repo,
  run \`npm run setup\`, and connect their own FreshBooks account.
- OAuth tokens refresh automatically: at server startup and before every tool call.

**Key concept — accountId vs businessId.** Most accounting resources (invoices,
clients, expenses, payments, …) use a string \`accountId\`. Project-related
resources (time entries, projects, services) use a numeric \`businessId\`. Both
come from your FreshBooks account and are stored in \`.env\`.

Call \`freshbooks_help\` with other topics — \`architecture\`, \`tools\`,
\`authentication\`, \`extending\`, \`conventions\`, \`troubleshooting\` — to go deeper.`;

export const TOPIC_ARCHITECTURE = `# FreshBooks MCP — Architecture

\`\`\`
src/
  index.ts              Entry point — refreshes the token, starts the stdio server
  server.ts             createSdkMcpServer — serves the registered tools
  tool-registry.ts      The single list of all tools; wraps each with token refresh
  freshbooks-client.ts  FreshBooks SDK client + OAuth token persistence/refresh
  config-paths.ts       OS-aware path to the Claude Desktop config
  query-helpers.ts      buildQueryBuilders() — turns tool args into SDK query builders
  date-helpers.ts       parseLocalDate() — avoids an off-by-one on date-only fields
  docs/                 Embedded self-documentation (this content)
  tools/                One file per FreshBooks resource domain
    with-refresh.ts     withTokenRefresh() — wraps a handler with pre-call refresh
    help.ts             The freshbooks_help tool
    invoices.ts, clients.ts, expenses.ts, ...   (one per domain)
\`\`\`

**Request flow.** An assistant calls a tool → \`tool-registry.ts\` has wrapped the
handler so \`refreshIfNeeded()\` runs first → the handler builds a typed payload →
the FreshBooks SDK serializes and sends it → the handler checks \`response.ok\`,
catches any thrown error, and returns an MCP result. Handlers never throw.

**The SDK is the contract.** The wrapper hands the SDK camelCase model objects;
the SDK's \`transform*Request\` functions translate them to the API's snake_case
JSON. Property names must match the SDK model interfaces exactly — see \`extending\`.`;

export const TOPIC_AUTHENTICATION = `# FreshBooks MCP — Authentication

FreshBooks uses **OAuth2 with rotating refresh tokens**: every refresh mints a
new access+refresh pair and revokes the old one. Access tokens last ~12 hours.

**Token files.** \`.env\` is the canonical store and is always required.
\`.mcp.json\` and the Claude Desktop config are optional mirrors, kept in sync
only when they exist — so a clone on any OS works. Persistence is atomic
(tmp + rename), keeps \`.bak\` backups, and verifies the write.

**Auto-refresh.** The token is refreshed automatically:
- at server startup (\`ensureFreshToken()\` in index.ts), and
- before every tool call (\`refreshIfNeeded()\`, wired in tool-registry.ts).
\`refreshIfNeeded()\` is a cheap no-op unless the token is within 10 minutes of
expiry; concurrent calls share one refresh via a single-flight guard.

**Manual control.**
- \`npm run refresh-tokens\` — refresh now if needed.
- \`npm run refresh-tokens -- --check-only\` — audit the token files, no refresh.

**Recovery.** If the refresh token is rejected (used elsewhere, or the FreshBooks
app was deleted), run \`npm run setup\` to re-authorize through the browser.`;

export const TOPIC_EXTENDING = `# FreshBooks MCP — Adding a Tool

1. **Define it** in the appropriate \`src/tools/<domain>.ts\` with the Agent SDK's
   \`tool(name, description, zodSchema, handler, { annotations })\` helper.
   Name it \`freshbooks_<action>_<resource>\`. Put \`.describe()\` on every Zod field.

2. **Register it** — add the export to the array in \`src/tool-registry.ts\`.
   That is the only wiring step; token-refresh wrapping is automatic.

3. **Handlers must never throw.** Wrap the body in try/catch. Check
   \`response.ok\` before reading \`response.data\`; also catch thrown SDK errors.
   Return \`{ content: [{ type: "text", text }], isError: true }\` on failure.

**SDK gotchas (these caused real bugs — see TOOL_AUDIT.md):**
- **Method signatures vary by resource.** Most creates are \`create(data, accountId)\`,
  but \`items.create\` is \`(accountId, data)\` and project resources use \`businessId\`.
  Check \`node_modules/@freshbooks/api/dist/APIClient.js\` for the exact signature.
- **Type payloads against the SDK model interface** (\`Partial<Invoice>\`, etc.) and
  do NOT cast \`as any\`. The SDK's \`transform*Request\` reads specific camelCase
  property names; a wrong name is silently dropped. Typing makes the compiler catch it.
- **Updates are often not partial.** Some SDK transforms emit required fields
  unconditionally, or the API rejects a PUT missing a field. When in doubt, fetch
  the existing record and merge (see \`update_expense\` / \`update_project\`).
- **Monetary amounts are strings** — use \`big.js\` for arithmetic, never JS numbers.`;

export const TOPIC_CONVENTIONS = `# FreshBooks MCP — Conventions

- **Tool naming:** \`freshbooks_<action>_<resource>\` — e.g. \`freshbooks_list_invoices\`.
- **Annotations:** \`readOnlyHint\` on list/get/report tools (enables parallel calls);
  \`destructiveHint\` on delete tools; \`idempotentHint\` on update tools.
- **Handlers never throw** — uncaught exceptions kill the agent loop. Every handler
  is try/catch wrapped and returns \`isError: true\` on failure.
- **Money is a string** — FreshBooks returns \`{ amount: "12.34", code: "USD" }\`.
  Never do arithmetic with JS numbers; use \`big.js\`.
- **Dates** — date-only accounting fields (\`YYYY-MM-DD\`) are parsed with
  \`parseLocalDate()\` to avoid a UTC off-by-one. Full timestamps keep their offset.
- **TypeScript strict mode** — prefer SDK model types over \`any\`.
- **Errors come two ways** — \`response.ok === false\`, OR a thrown exception with
  \`{ statusCode, message, errors[] }\`. Handle both.`;

export const TOPIC_TROUBLESHOOTING = `# FreshBooks MCP — Troubleshooting

**A tool returns a 401 / "unauthorized" error.** The access token expired or was
revoked. Run \`npm run refresh-tokens\`. If that reports REFRESH FAILED, run
\`npm run setup\` to re-authorize. Reload your Claude app afterward.

**All FreshBooks tools fail at once.** The MCP server may not be running or
registered. Confirm the server process is alive and the \`freshbooks\` entry
exists in your Claude config; reload the app.

**"FRESHBOOKS_ACCOUNT_ID is not set" (or CLIENT_ID / BUSINESS_ID).** The \`.env\`
file is missing or incomplete. Run \`npm run setup\`.

**A tool reports "not found".** The record ID does not exist or belongs to a
different account — list the resource first to get a valid ID.

**Bills / bill-payments / bill-vendors fail with "no access".** The FreshBooks
account does not have the Accounts-Payable add-on enabled.

**create_credit_note or create_journal_entry fails.** These two are known to be
non-functional — blocked by bugs in @freshbooks/api@4.1.0 (the latest SDK release)
that serialize the request incorrectly. The defect is upstream, not in this server.
The list/get tools for credit notes and journal entries work normally.

**A new service is always billable.** \`create_service\` cannot set a billable
flag — the FreshBooks SDK's transformServiceRequest serializes only the service
name, so any billable value would be silently dropped. Change it in the
FreshBooks web UI if a service must be non-billable.

**Build errors after editing a tool.** Payloads are typed against SDK model
interfaces — a compile error usually means a wrong property name. Fix the name;
do not cast \`as any\`.

**Changes to the code don't take effect.** Run \`npm run build\`, then restart the
MCP server (reload your Claude app) — the running process holds the old code.`;
