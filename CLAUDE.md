# CLAUDE.md — FreshBooks MCP Server

## Project Overview

FreshBooks-MCP is a Model Context Protocol (MCP) server that exposes FreshBooks accounting API functionality as tools for AI assistants. It uses the official **FreshBooks Node.js SDK** (`@freshbooks/api`) for all API interactions and the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) to define and serve MCP tools.

- **License:** MIT
- **Owner:** kanjidoc
- **Language:** TypeScript
- **Runtime:** Node.js
- **FreshBooks SDK:** `@freshbooks/api`
- **MCP Layer:** `@anthropic-ai/claude-agent-sdk` (`tool()`, `createSdkMcpServer`)
- **Input Validation:** `zod`

## Key Dependencies

| Package | Purpose |
|---|---|
| `@freshbooks/api` | FreshBooks API client — OAuth, resources, query builders, types, retry |
| `@anthropic-ai/claude-agent-sdk` | MCP tool definitions via `tool()` and `createSdkMcpServer` |
| `@modelcontextprotocol/sdk` | `StdioServerTransport` — serves the MCP server over stdio (`src/index.ts`) |
| `zod` | Input schema validation for tool parameters |
| `big.js` | Decimal arithmetic for monetary amounts (FreshBooks returns amounts as strings) |
| `dotenv` | Load environment variables from `.env` |

## Project Structure

```
FreshBooks-MCP/
├── src/
│   ├── index.ts                # Entry point — connects the stdio server, then refreshes every profile in the background; manages the server lock
│   ├── load-env.ts             # Loads the base .env (shared app credentials) by absolute path
│   ├── server.ts               # createSdkMcpServer setup; serves the tool list from tool-registry.ts
│   ├── tool-registry.ts        # The single tool array; wraps API tools with withAccount, account-free tools with withoutAccount
│   ├── profiles.ts             # Profile types, discovery of profiles/<name>.env, memoized registry, AsyncLocalStorage context
│   ├── freshbooks-client.ts    # Per-profile @freshbooks/api Client (single getOrCreateClient); per-profile OAuth refresh/persist
│   ├── atomic-write.ts         # writeAtomic() + readTokenMarkers() — crash-safe token writes shared by client refresh and migration
│   ├── migrate.ts              # Transactional migration of a legacy single-login .env into profiles/<name>.env
│   ├── server-lock.ts          # Best-effort .server.lock (pid-liveness) so migration refuses to run while a server holds tokens
│   ├── config-paths.ts         # OS-aware path to the Claude Desktop config
│   ├── mcp-config.ts           # Builds the MCP server entry for Claude Desktop / Code config
│   ├── query-helpers.ts        # Shared utility to build query builders from tool args
│   ├── date-helpers.ts         # parseLocalDate() — avoids a UTC off-by-one on date-only fields
│   ├── docs/                   # Embedded self-documentation for the freshbooks_help tool
│   │   ├── content.ts          # Static help topic content (overview, architecture, etc.)
│   │   └── render-tools.ts     # Renders the live tool inventory from the registry
│   ├── tools/                  # Account wrapper, freshbooks_help, freshbooks_list_accounts, + one file per resource domain (17 files)
│   │   ├── with-refresh.ts     # withAccount() (account injection + per-profile pre-call refresh) and withoutAccount()
│   │   ├── help.ts             # The freshbooks_help self-documentation tool (1 tool, account-free)
│   │   ├── accounts.ts         # The freshbooks_list_accounts tool (1 tool, account-free)
│   │   ├── invoices.ts         # Invoice CRUD + delete (5 tools)
│   │   ├── clients.ts          # Client CRUD + delete (5 tools)
│   │   ├── expenses.ts         # Expense CRUD + delete (5 tools)
│   │   ├── payments.ts         # Payment CRUD + delete (5 tools)
│   │   ├── time-entries.ts     # Time entry CRUD + delete (5 tools, uses businessId)
│   │   ├── bills.ts            # Bill list/get/create/delete (4 tools)
│   │   ├── bill-payments.ts    # Bill payment CRUD + delete (5 tools)
│   │   ├── bill-vendors.ts     # Bill vendor CRUD + delete (5 tools)
│   │   ├── credit-notes.ts     # Credit note CRUD + delete (5 tools)
│   │   ├── items.ts            # Item CRUD (4 tools)
│   │   ├── tasks.ts            # Task CRUD + delete (5 tools)
│   │   ├── projects.ts         # Project CRUD + delete (5 tools, uses businessId)
│   │   ├── services.ts         # Service list/get/create (3 tools, uses businessId)
│   │   ├── other-incomes.ts    # Other income CRUD + delete (5 tools)
│   │   ├── expense-categories.ts # Expense category list/get (2 read-only tools)
│   │   ├── journal-entries.ts  # Journal entry create + account/detail listings (3 tools)
│   │   └── reports.ts          # Profit & Loss, Payments Collected, Tax Summary (3 tools)
├── profiles/                   # One <name>.env per FreshBooks login (tokens + IDs); git-ignored, created by setup/migration
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example                # Template for the shared OAuth app credentials (no tokens)
├── scripts/
│   ├── setup.ts                # Interactive setup wizard (migration, add-login loop, OAuth, config)
│   └── refresh-tokens.ts       # CLI to refresh each profile's token (or audit with --check-only; --profile <name> to target one)
├── README.md                   # Project landing page (what it does, architecture, tool list)
├── SETUP.md                    # Beginner setup walkthrough — also a script Claude can follow
├── CLAUDE.md                   # This file
├── docs/
│   └── claude-project-system-prompt.md  # Optional system prompt for Claude Projects users
└── LICENSE
```

## Development Workflow

### Setup

```bash
npm install
npm run setup          # Interactive: OAuth flow, ID discovery, config generation
# OR manually:
cp .env.example .env   # Fill in your FreshBooks credentials
```

### Build and Run

```bash
npm run build          # Compile TypeScript to dist/
npm start              # Run the compiled MCP server
npm run dev            # Run with ts-node for development
npm run setup          # Interactive setup wizard (migrate + add-login loop, OAuth, config for all Claude platforms)
npm run refresh-tokens # Refresh each profile's token if near expiry (-- --profile <name> targets one)
npm run check-tokens   # Audit every profile's tokens + report JWT expiry (refresh-tokens --check-only, no API call)
```

### Token persistence safety

OAuth tokens live **only in dotenv files**, one per FreshBooks login: `profiles/<name>.env` (a legacy single-login base `.env` is still honored as the implicit `default` profile). The base `.env` holds only the shared OAuth **app** credentials (`FRESHBOOKS_CLIENT_ID`/`SECRET`/`REDIRECT_URI`) plus the `FRESHBOOKS_MIGRATED=1` marker — never a token. The server loads the base `.env` by absolute path at startup (`src/load-env.ts`, with `override: true`), and `src/profiles.ts` discovers the profile files into a memoized registry. MCP launcher configs (`.mcp.json`, the Claude Desktop config, `~/.claude.json`) carry only the command to start the server — never tokens. FreshBooks rotates the refresh token on every refresh call; the rotated pair is written back to that profile's own file.

A FreshBooks `Client` is constructed in exactly **one** place — `getOrCreateClient(profile)` in `src/freshbooks-client.ts` — so token state lives on one object per profile. `src/freshbooks-client.ts` enforces these invariants on every refresh (each scoped to the active profile's file via the `src/atomic-write.ts` helper):
1. **Pre-flight refusal** — before calling `refreshAccessToken()`, `preflightEnvFile()` verifies the profile's file exists, is readable/writable, and contains both token markers. If not, it throws *without* calling the API (no burned refresh token).
2. **Atomic write** — `writeAtomic()` writes `<file>.tmp` (fsync'd) then `rename()`s into place; backup saved as `<file>.bak` (tmp/bak names are always derived from the target path, never a shared constant).
3. **Post-write verification** — re-reads the file and confirms the new tokens are present.
4. **Loud failure** — if the write fails after a successful refresh, prints the new tokens to stderr so they can be pasted into the profile file manually; `config` is still updated so the live client never sits on a revoked token.

Tokens refresh **automatically**: at server startup (`ensureFreshTokens()` in `index.ts` refreshes every profile sequentially, with per-profile isolation, in the background) and proactively before every tool call. The pre-call refresh is `refreshIfNeeded(profile)` — a cheap no-op JWT-expiry check unless the token is within 10 minutes of expiring — wired centrally in `src/tool-registry.ts` via `withAccount`. A per-profile single-flight guard ensures concurrent tool calls on one profile share a single refresh rather than each rotating the refresh token.

`scripts/refresh-tokens.ts` is the manual CLI: `npm run refresh-tokens` iterates every profile and refreshes the ones that need it (`-- --profile <name>` targets one), and `npm run check-tokens` (i.e. `refresh-tokens --check-only`) audits each profile and reports JWT expiry with no API call. With no profiles configured it exits `2`.

### Linting and Formatting

```bash
npm run lint           # ESLint
npm run format         # Prettier
```

### Testing

```bash
npm test               # Runs the Vitest test suite
```

### Versioning and releases

The version has **one** source of truth: the `version` field in `package.json`.
`src/version.ts` is the only module that reads it; `src/server.ts` (the MCP
handshake) and the `freshbooks_help` `version` topic both call `getVersion()`.
Never hardcode a version string anywhere else.

The tool count is likewise derived — from `allTools.length`. State the tool
*total* only in the files watched by `test/doc-tool-count.test.ts` (README,
SETUP, `package.json`'s description, the Claude-project prompt, this file);
that test fails if any of them drifts from the live registry count.

**Cutting a release.** Everyday PRs add notes under the `## [Unreleased]`
heading in `CHANGELOG.md`. To release, make one commit that (a) renames
`## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and (b) bumps the version with
`npm version X.Y.Z --no-git-tag-version` (this updates `package.json` and
`package-lock.json` together). Merge that commit to `main`.

`.github/workflows/release.yml` then tags `vX.Y.Z` and publishes a GitHub
Release automatically, with notes extracted from the changelog section by
`scripts/extract-changelog.mjs`. It is idempotent — ordinary commits never
release; only a new version does.

## Environment Variables

Credentials are loaded from dotenv files so any FreshBooks user can plug in their own account(s). They split across two kinds of file: the base `.env` holds the shared OAuth **app** credentials, and each FreshBooks login's tokens live in its own `profiles/<name>.env`. **Never commit `.env` or any `profiles/*.env`.** `npm run setup` writes both; the model below is the contract.

**Base `.env` — shared app credentials only (copy from `.env.example`):**

| Variable | Description | Maps to |
|---|---|---|
| `FRESHBOOKS_CLIENT_ID` | OAuth2 client ID from FreshBooks Developer Portal | `Client` constructor first arg |
| `FRESHBOOKS_CLIENT_SECRET` | OAuth2 client secret | `clientSecret` option |
| `FRESHBOOKS_REDIRECT_URI` | OAuth2 redirect URI | `redirectUri` option |
| `FRESHBOOKS_MIGRATED` | Set to `1` once a legacy single-login `.env` has been migrated into a profile (idempotency marker; not a credential) | — |

**Per-profile `profiles/<name>.env` — one file per FreshBooks login (tokens, never in the base `.env`):**

| Variable | Description | Maps to |
|---|---|---|
| `FRESHBOOKS_ACCESS_TOKEN` | Access token (after OAuth flow) | `accessToken` option |
| `FRESHBOOKS_REFRESH_TOKEN` | Refresh token (for automatic renewal) | `refreshToken` option |
| `FRESHBOOKS_ACCOUNT_ID` | FreshBooks account ID (for accounting endpoints) | Passed to resource `.list()`, `.single()`, `.create()` |
| `FRESHBOOKS_BUSINESS_ID` | FreshBooks business ID (for project/time endpoints) | Passed to `timeEntries`, `projects`, `services` methods |

`parseProfileConfig` requires only the two tokens to be present; `FRESHBOOKS_ACCOUNT_ID`/`FRESHBOOKS_BUSINESS_ID` may be blank for an accounting-only login and throw at call time only if a tool actually needs them.

**accountId vs businessId:** Most accounting resources (invoices, clients, expenses, payments) use `accountId: string`. Project-related resources (time entries, projects, services) use `businessId: number`. Both are available from `client.users.me()`. There is no `FRESHBOOKS_DEFAULT_PROFILE` selector — with one login it is used by default; with two or more, every API tool's `account` argument is required.

## Multi-Account Model (Profiles)

One server can serve several FreshBooks logins. Each login is a **profile** — a `profiles/<name>.env` file. The model:

- **The `account` convention.** `withAccount` injects an optional `account: z.string().optional()` field into every API tool's schema. The wrapper resolves it to a profile (`resolveProfile`), refreshes that profile's token (`refreshIfNeeded`), strips `account` from the args, and runs the original handler inside `runInProfile(profile, …)`. The unchanged zero-arg `getFreshBooksClient()` / `getAccountId()` / `getBusinessId()` read the active profile from `AsyncLocalStorage`, so the resource tool files never had to change. With ≥2 profiles, omitting `account` returns an `isError` result listing the valid names (never throws); with exactly one profile, `defaultProfileName()` supplies it.
- **`freshbooks_list_accounts`** is the discovery tool — it enumerates profiles (name, account/business id, company, token health) and any ignored/colliding files. It and `freshbooks_help` are the only account-free tools.
- **One `Client` per profile.** A FreshBooks `Client` is constructed in exactly one place — `getOrCreateClient(profile)` — and cached on `profile.client`, so each login's rotating token state lives on a single object. Never call `new Client(...)` elsewhere.
- **Discovery is validated.** `discoverProfiles` excludes malformed files (`broken`), refuses duplicate refresh tokens (`duplicates`), and quarantines a profile that shares an `accountId` with another but carries a distinct token (until an explicit `# freshbooks-distinct-login` opt-in marker) so its possibly-superseded token is never auto-rotated.
- **Server lock for migration safety.** `src/server-lock.ts` writes `.server.lock` (`{ pid }`) at startup. Migration refuses to run while a live server holds the lock — judged by **PID liveness only** (`process.kill(pid, 0)`), with no file-age bound and no heartbeat — so it can never rotate a token concurrently with a running server. A reused PID after an uncleaned crash fails closed; the `confirmNoServer` override on `runMigration` is the only recovery.

## FreshBooks SDK Patterns

### Client initialization

```typescript
import { Client } from "@freshbooks/api";

// Option A: With pre-generated access token
const client = new Client(clientId, { accessToken: token });

// Option B: With client secret for OAuth flow
const client = new Client(clientId, {
  clientSecret,
  redirectUri: "https://your-redirect-uri.com/",
});
```

### OAuth authorization flow

1. Generate auth URL: `client.getAuthRequestUrl()` → user visits URL
2. User authorizes, gets redirected with `code` parameter
3. Exchange code: `client.getAccessToken(code)` → returns `{ accessToken, refreshToken, accessTokenExpiresAt }`
4. Client automatically uses the token for future requests

### Current user

```typescript
const { data } = await client.users.me();
// data.id, data.businessMemberships, etc.
```

### Resource methods

**Important:** Method signatures vary by resource. Check `src/tools/<resource>.ts` for exact signatures.

```typescript
// Accounting resources use accountId (string)
const invoices = await client.invoices.list(accountId, queryBuilders?);
const invoice  = await client.invoices.single(accountId, invoiceId);
const created  = await client.invoices.create(invoiceData, accountId);
const updated  = await client.invoices.update(accountId, invoiceId, data);

// Clients: create/update take (data, accountId, ...) order
const newClient = await client.clients.create(clientData, accountId);
const updated   = await client.clients.update(clientData, accountId, clientId);

// Project resources use businessId (number)
const entries = await client.timeEntries.list(businessId, queryBuilders?);
const entry   = await client.timeEntries.single(businessId, entryId);
const created = await client.timeEntries.create(entryData, businessId);
```

### Available resources on Client

| Resource | Endpoint type | ID type |
|---|---|---|
| `client.invoices` | Accounting | `accountId: string` |
| `client.clients` | Accounting | `accountId: string` |
| `client.expenses` | Accounting | `accountId: string` |
| `client.payments` | Accounting | `accountId: string` |
| `client.items` | Accounting | `accountId: string` |
| `client.bills` | Accounting | `accountId: string` |
| `client.billPayments` | Accounting | `accountId: string` |
| `client.billVendors` | Accounting | `accountId: string` |
| `client.creditNotes` | Accounting | `accountId: string` |
| `client.otherIncomes` | Accounting | `accountId: string` |
| `client.expenseCategories` | Accounting | `accountId: string` |
| `client.callbacks` | Accounting | `accountId: string` |
| `client.tasks` | Accounting | `accountId: string` |
| `client.journalEntries` | Accounting | `accountId: string` |
| `client.timeEntries` | Projects | `businessId: number` |
| `client.projects` | Projects | `businessId: number` |
| `client.services` | Projects | `businessId: number` |
| `client.reports` | Reports | `accountId: string` |
| `client.users` | Identity | N/A (`.me()`) |

### Intentional exclusions — do not "fix" these

The SDK wraps three resources this server deliberately does **not** expose as
tools. Their absence is a scoping decision, not an oversight, so "the SDK already
supports it, it's a free win" is not an argument for adding them. When auditing
tool coverage against the SDK, list these as out of scope rather than as gaps:

| SDK resource | What it would add |
|---|---|
| `client.callbacks` | Webhooks — create/single/list/update/delete/resendVerification/verify |
| `client.paymentOptions` | Online payment options — create/single/default |
| `client.invoices` `share_link` | Client-facing invoice share links |

This applies only to resources the SDK *does* wrap. Resources the SDK never
wrapped (Estimates, Staff, Taxes, Invoice Profiles, and the General Ledger /
Balance Sheet / Cash Flow / Accounts Aging / Expense Details / Trial Balance
reports) are a separate question and are not covered by this exclusion.

**There is no separate Chart of Accounts endpoint.** Probed live (2026-07-28):
every `chart_of_accounts` path variant returns 404. The chart of accounts **is**
`journal_entry_accounts`, already exposed as
`freshbooks_list_journal_entry_accounts` — do not add a duplicate tool for it.

### Query builders (Pagination, Search, Sort, Includes)

All list endpoints accept an optional array of query builders. Import from `@freshbooks/api/dist/models/builders`.

```typescript
import {
  PaginationQueryBuilder,
  SearchQueryBuilder,
  IncludesQueryBuilder,
  SortQueryBuilder,
} from "@freshbooks/api/dist/models/builders";
```

**Pagination:**
```typescript
const paginator = new PaginationQueryBuilder();
paginator.page(1).perPage(10);
const { data } = await client.clients.list(accountId, [paginator]);
// data.pages = { page, pages, total, size }
```

**Search filters (5 methods):**
```typescript
const search = new SearchQueryBuilder();
search.equals("email", "user@example.com");       // exact match
search.in("clientids", [123, 456]);                // match multiple values
search.like("email_like", "@freshbooks.com");      // partial match (key includes _like)
search.between("amount", { min: 1, max: 100 });   // range filter (also works with dates)
search.between("date", { min: new Date("2024-01-01"), max: new Date("2024-12-31") });
search.boolean("complete", false);                 // boolean filter
```

**Sorting:**
```typescript
const sort = new SortQueryBuilder();
sort.asc("invoice_date");   // or .ascending()
sort.desc("amount");        // or .descending()
```

**Includes (sub-resources):**
```typescript
const includes = new IncludesQueryBuilder();
includes.includes("lines");  // e.g. invoice line items
const { data } = await client.invoices.list(accountId, [includes]);
```

**Combining multiple builders:**
```typescript
const response = await client.invoices.list(accountId, [paginator, search, sort, includes]);
```

A shared helper at `src/query-helpers.ts` builds these from simplified tool arguments.

### Response shape

```typescript
interface Result<T> {
  ok: boolean;
  data?: T;
  error?: {
    name: string;
    message: string;
    statusCode?: string;
    errors?: Array<{
      message: string;
      errorCode?: number;
      field?: string;
      object?: string;
      value?: string;
    }>;
  };
}
```

### Data handling

- **Monetary amounts** — Returned as `{ amount: string, code: string }`. Use `big.js` for arithmetic, never native JS numbers.
- **Dates/times** — Many accounting resources return date/times in US/Eastern timezone; the SDK converts them to UTC `Date` objects.
- **IDs** — Numeric in FreshBooks. Some method signatures take `string`, others `number` — check the types.

## Tool Definition Pattern

Tools are defined using the Claude Agent SDK's `tool()` helper and bundled with `createSdkMcpServer`.

### Defining a tool

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";
import { buildQueryBuilders } from "../query-helpers";

export const listInvoices = tool(
  "freshbooks_list_invoices",                                    // Name: freshbooks_<action>_<resource>
  "List invoices with optional pagination, filters, and sorting", // Description
  {                                                               // Zod schema
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    search_status: z.string().optional().describe("Filter by status"),
  },
  async (args) => {                                               // Handler — NEVER throw
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const queryBuilders = buildQueryBuilders({ page: args.page, perPage: args.per_page });
      const response = await client.invoices.list(accountId, queryBuilders);

      if (!response.ok) {                                         // defense-in-depth — see Error Handling
        return {
          content: [{ type: "text", text: `FreshBooks error: ${response.error?.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error: any) {
      // The REAL SDK error path: call() throws { name, message, statusCode, errors }
      return {
        content: [{ type: "text", text: `Error: ${error.message ?? String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }                        // Read-only → parallel execution
);
```

### Bundling tools into an MCP server

All 76 tools are imported and assembled into a single array in `src/tool-registry.ts`. The 74 API tools are wrapped with `withAccount` (it injects the `account` field, resolves the named profile, refreshes that profile's token, and runs the handler inside the profile's `AsyncLocalStorage` context); the two account-free tools (`freshbooks_help`, `freshbooks_list_accounts`) are wrapped with `withoutAccount` (identity). `src/server.ts` then passes that array to `createSdkMcpServer`. When adding a new tool, define it in the appropriate `src/tools/<resource>.ts` file, then import and add it to the tools array in `src/tool-registry.ts` (under `accountScoped` for an API tool, or `accountFree` for an account-free one).

### Tool naming convention

All 76 tools are prefixed with `freshbooks_` and follow `freshbooks_<action>_<resource>`:

**Accounting resources (accountId):**
- Invoices: `freshbooks_list_invoices`, `freshbooks_get_invoice`, `freshbooks_create_invoice`, `freshbooks_update_invoice`, `freshbooks_delete_invoice`
- Clients: `freshbooks_list_clients`, `freshbooks_get_client`, `freshbooks_create_client`, `freshbooks_update_client`, `freshbooks_delete_client`
- Expenses: `freshbooks_list_expenses`, `freshbooks_get_expense`, `freshbooks_create_expense`, `freshbooks_update_expense`, `freshbooks_delete_expense`
- Payments: `freshbooks_list_payments`, `freshbooks_get_payment`, `freshbooks_create_payment`, `freshbooks_update_payment`, `freshbooks_delete_payment`
- Bills: `freshbooks_list_bills`, `freshbooks_get_bill`, `freshbooks_create_bill`, `freshbooks_delete_bill`
- Bill Payments: `freshbooks_list_bill_payments`, `freshbooks_get_bill_payment`, `freshbooks_create_bill_payment`, `freshbooks_update_bill_payment`, `freshbooks_delete_bill_payment`
- Bill Vendors: `freshbooks_list_bill_vendors`, `freshbooks_get_bill_vendor`, `freshbooks_create_bill_vendor`, `freshbooks_update_bill_vendor`, `freshbooks_delete_bill_vendor`
- Credit Notes: `freshbooks_list_credit_notes`, `freshbooks_get_credit_note`, `freshbooks_create_credit_note`, `freshbooks_update_credit_note`, `freshbooks_delete_credit_note`
- Items: `freshbooks_list_items`, `freshbooks_get_item`, `freshbooks_create_item`, `freshbooks_update_item`
- Tasks: `freshbooks_list_tasks`, `freshbooks_get_task`, `freshbooks_create_task`, `freshbooks_update_task`, `freshbooks_delete_task`
- Other Incomes: `freshbooks_list_other_incomes`, `freshbooks_get_other_income`, `freshbooks_create_other_income`, `freshbooks_update_other_income`, `freshbooks_delete_other_income`
- Expense Categories: `freshbooks_list_expense_categories`, `freshbooks_get_expense_category` (read-only)
- Journal Entries: `freshbooks_create_journal_entry`, `freshbooks_list_journal_entry_accounts`, `freshbooks_list_journal_entry_details`
- Reports: `freshbooks_report_payments_collected`, `freshbooks_report_profit_loss`, `freshbooks_report_tax_summary`

**Report basis and filters.** FreshBooks reports default to an **accrual** basis.
`freshbooks_report_profit_loss` accepts `cash_based` and `fiscal_year_view`;
`freshbooks_report_tax_summary` accepts `cash_based` only. Which optional params
each endpoint honors is not guesswork — decode the `downloadToken` JWT in any
report response and its `params` claim echoes the exact set the server parsed.
**Unsupported params are silently dropped** (`ok: true`, no error), so never
offer a param on a report whose token does not list it: the filter would appear
to work while quietly producing wrong numbers. The matrix lives as DATA in
`src/report-params.ts` (`REPORT_PARAMS` — honored, proven-ignored, wire-key
mapping, and verification date per endpoint); `freshbooks_help topic=reports`
renders it live, and `test/report-params.test.ts` asserts every report tool's
schema stays inside its entry. Do not restate the matrix in prose anywhere —
link here or to the help topic instead.

Report params also serialize differently from list endpoints: the SDK builds
reports with the `AccountingReportsResource` type, which is **not** in
`SearchQueryBuilder`'s `isAccountingLike` list, so `equals`/`boolean` params emit
as flat `&key=value` rather than `&search[key]=value`. Array params need a
literal `[]` suffix (`currency_codes[]=USD`); the SDK's own `.in()` builder emits
`search[currency_codes][]=` and is silently ignored by these endpoints.

To learn what an endpoint honors, decode the token:

```js
JSON.parse(Buffer.from(downloadToken.split(".")[1], "base64url").toString()).params
```

This doubles as a free changelog: the `params` claim lists server-side options
the frozen Node SDK never learned to send, which is how `cash_based` and
`fiscal_year_view` were found. Verify report changes against a profile with an
invoiced-but-unpaid invoice — cash-basis and accrual then produce genuinely
different totals that reconcile against identifiable transactions, so you are
testing the flag's effect rather than just that it echoes back.

### Journal entries, sub-accounts, and derived balances

Four verified traps for anything that reports on the chart of accounts. All
confirmed against live data on 2026-07-28. Account identifiers and balances are
omitted here per the redaction policy in `TOOL_AUDIT.md` — the mechanisms are what
matter and they outlive any particular figure.

**1. Custom sub-account names come back as UUIDs.** A sub-account created by the
user has `account_sub_name` set to a UUID, not the label the FreshBooks UI shows
("Owner's Draws"). Built-in sub-accounts ("Opening Balance Adjustments") keep real
names. The stable join key is `sub_accountid`. The display name is **not returned
by any endpoint** — not the accounts list, not `journal_entry_details`, and not the
balance sheet report, which emits the same UUIDs. The `name` field on a detail row
is that journal line's own label, not the sub-account name. Any reporting tool must
therefore carry its own `sub_accountid` → label mapping; it cannot derive one.
(This server deliberately ships no such map — it would be account-specific and
would break shareability.)

**2. The `balance` field is stale — do not use it.** On the accounts endpoint it
disagreed with the ledger for **every** non-zero sub-account tested, sometimes by
more than 2×, and reported `0` for sub-accounts with real activity. Derive
balances by summing `debit`/`credit` from `journal_entry_details` instead. For
equity accounts, credit is positive (`netCredit = credit - debit`).

**3. Deriving balances REQUIRES pagination.** `journal_entry_details` is capped at
100 rows per page. On a test account with 144 rows across 2 pages, summing only
page 1 understated one equity sub-account by $2,000 and another by $1,000 — wrong,
with no error. Always follow `response.result.pages` to the end.

**4. `subAccountId` / `accountSubName` are nested one level down.** They live at
`subAccounts[].subAccountId`, **not** on the parent `journalEntryAccount` record,
where both read `undefined`. The SDK does map them correctly
(`models/JournalEntryAccount.js` → `sub_accounts` → `subAccounts`, via
`transformSubAccountParsedResponse`) — so the typed model is fine and no raw
payload access is needed. This trap is listed because reading the parent level
yields `undefined` rather than an error, which is easily mistaken for the SDK
dropping the field.

**Project resources (businessId):**
- Time Entries: `freshbooks_list_time_entries`, `freshbooks_get_time_entry`, `freshbooks_create_time_entry`, `freshbooks_update_time_entry`, `freshbooks_delete_time_entry`
- Projects: `freshbooks_list_projects`, `freshbooks_get_project`, `freshbooks_create_project`, `freshbooks_update_project`, `freshbooks_delete_project`
- Services: `freshbooks_list_services`, `freshbooks_get_service`, `freshbooks_create_service`

**Account-free tools (no `account` argument, no profile context):**
- Account directory: `freshbooks_list_accounts` — enumerates the configured FreshBooks logins (each profile's name, account/business id, company, token health, plus any ignored/colliding files); resolves a `Client` directly via `getOrCreateClient(profile)` since it runs outside any profile context
- Self-documentation: `freshbooks_help` — returns embedded docs about this project (architecture, conventions, the live tool inventory, how to extend); no FreshBooks API call

Use `allowedTools: ["mcp__freshbooks__*"]` to allow all tools on the server.

### Tool annotations

| Annotation | Use for | Effect |
|---|---|---|
| `readOnlyHint: true` | `list_`/`get_`/`report_` tools | Enables parallel execution |
| `destructiveHint: true` | `delete_` tools | Signals destructive action |
| `idempotentHint: true` | `update_` tools | Repeated calls have no extra effect |
| *(none)* | `create_` tools | Deliberate: a create is neither read-only, idempotent, nor destructive of existing data |

This convention is keyed on the tool's action prefix and **enforced by
`test/tool-inventory.test.ts`**. A tool whose name matches no action prefix
(e.g. `freshbooks_help`) must be added to that test's explicit allow-list with
its expected annotations — the test fails otherwise.

## Error Handling

Tool handlers must **never throw**. Uncaught exceptions kill the agent loop.

**How errors actually arrive is scoped by tier:**

- **SDK-backed tools (every `client.<resource>` call): errors THROW.** The SDK's
  `call()` (`APIClient.js`) throws `{ name, message, statusCode, errors[] }` on
  every failure and **never returns `ok: false`** — there is not a single
  `ok: false` construction site in the SDK. The `if (!response.ok)` branch in
  these handlers is defense-in-depth against a future SDK change, not a live
  error path. Keep writing it (it is harmless and uniform), but never rely on it:
  the `catch` block is where SDK errors are actually handled.
- **Raw-backed tools (direct API access via `src/raw-call.ts`, where present):
  the inverse.** They return a real `Result`-shaped object and the `!ok` branch
  is the **only** error path — nothing throws.

The `Result<T>` response shape documented above is correct as a type either way.
Both paths must end in `isError: true`, never a throw:

```typescript
try {
  const response = await client.invoices.single(accountId, invoiceId);
  if (!response.ok) {
    return {
      content: [{ type: "text", text: `FreshBooks API error: ${response.error?.message}` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
} catch (error: any) {
  // SDK throws: { name, message, statusCode, errors: [{ message, errorCode, field }] }
  const details = error.errors?.map((e: any) => e.message).join("; ") ?? "";
  return {
    content: [{ type: "text", text: `FreshBooks error (${error.statusCode}): ${error.message}. ${details}` }],
    isError: true,
  };
}
```

## Doc-maintenance contract

The tool inventory and tool count appear in multiple documents. When tools are
added, renamed, or removed, this is the authoritative map of what must change
and what catches you if you forget:

**Test-enforced (a failing test names the file):**
- Tool **count** — README.md, SETUP.md, `package.json` description, CLAUDE.md,
  `docs/claude-project-system-prompt.md` → `test/doc-tool-count.test.ts`
- Tool **names** — README.md, CLAUDE.md, `docs/claude-project-system-prompt.md`
  (both directions: missing AND stale) → `test/doc-inventory.test.ts`
- **Report params** — schemas vs `src/report-params.ts` → `test/report-params.test.ts`
- **Annotations** — the action-prefix convention → `test/tool-inventory.test.ts`

**Derived automatically (zero edits):** `freshbooks_help` topics `tools`
(renders the live registry) and `reports` (renders `REPORT_PARAMS`).

**Hand-written and rot-prone (no guard — check deliberately):** SETUP.md's
example prompts and limitations list; `src/docs/content.ts` prose topics;
`CHANGELOG.md`. When you add a capability, grep these for the affected
resource before shipping.

## Shareability

This project is designed so any FreshBooks user can use it:

- All credentials are environment-variable driven — no hardcoded account IDs or tokens
- `.env.example` documents every required variable with descriptions
- Clone → `npm install` → configure `.env` → run
- `SETUP.md` is the user-facing install walkthrough — keep it accurate when the OAuth flow, the setup wizard, or the platform configs change

## Key Conventions

### TypeScript

- Strict mode (`"strict": true` in tsconfig)
- Prefer explicit types over `any` — use types from `@freshbooks/api` where available
- Use `async/await` for all asynchronous operations
- Export tool definitions as named exports from each tool module

### File Organization

- One tool file per FreshBooks resource domain (invoices, clients, expenses, etc.)
- `src/tool-registry.ts` imports all tools into a single array and wraps each handler with automatic token refresh
- `src/server.ts` serves that tool list via `createSdkMcpServer`
- `src/freshbooks-client.ts` is the single place that initializes the FreshBooks `Client`
- `src/query-helpers.ts` provides `buildQueryBuilders()` to convert tool args to SDK query builders

### Git Conventions

- Descriptive commit messages: `feat: add invoice listing tool`, `fix: handle token refresh on 401`
- One logical change per commit
- Never commit `.env`, `node_modules/`, or `dist/`

## FreshBooks API Reference

- **SDK Docs:** https://freshbooks.github.io/freshbooks-nodejs-sdk/
- **SDK GitHub:** https://github.com/freshbooks/freshbooks-nodejs-sdk
- **API Docs:** https://www.freshbooks.com/api
- **API Parameters:** https://www.freshbooks.com/api/parameters
- **npm:** https://www.npmjs.com/package/@freshbooks/api
- **Auth:** OAuth2 with access/refresh tokens
- **Resources:** invoices, clients, expenses, payments, taxes, items, bills, bill_payments, bill_vendors, credit_notes, other_incomes, expense_categories, callbacks, tasks, journal_entries, time_entries, projects, services, reports

## Notes for AI Assistants

- Always read existing source files before modifying them
- When adding a new tool: define with `tool()` in `src/tools/<resource>.ts`, then add to the tools array in `src/tool-registry.ts`
- Use Zod `.describe()` on every schema field so Claude understands parameters
- Use `.default()` on optional Zod fields with sensible defaults
- Annotations follow the action prefix (test-enforced): `list_`/`get_`/`report_` → `readOnlyHint`; `delete_` → `destructiveHint`; `update_` → `idempotentHint`; `create_` → none; prefix-free tools go in `test/tool-inventory.test.ts`'s allow-list
- Use the FreshBooks SDK client methods — never raw fetch/HTTP
- Check `response.ok` before accessing `response.data`, and catch thrown errors — knowing that for SDK-backed tools the throw is the real error path (`call()` never returns `ok: false`; see Error Handling)
- Monetary amounts are strings — use `big.js` for any arithmetic
- Accounting resources use `accountId` (string), project resources use `businessId` (number)
- Do NOT add an `account` field to a tool's own schema — `withAccount` injects it. Keep using the zero-arg `getFreshBooksClient()`/`getAccountId()`/`getBusinessId()`; they resolve the active profile from the `AsyncLocalStorage` context
- Run `npm run build` after changes to verify TypeScript compiles cleanly
- Do not add dependencies without justification
