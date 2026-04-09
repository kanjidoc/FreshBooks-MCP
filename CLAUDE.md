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
| `zod` | Input schema validation for tool parameters |
| `big.js` | Decimal arithmetic for monetary amounts (FreshBooks returns amounts as strings) |
| `dotenv` | Load environment variables from `.env` |

## Project Structure

```
FreshBooks-MCP/
├── src/
│   ├── index.ts                # Entry point — starts the MCP server
│   ├── server.ts               # createSdkMcpServer setup, bundles all tools
│   ├── freshbooks-client.ts    # Initializes @freshbooks/api Client from env vars
│   ├── query-helpers.ts        # Shared utility to build query builders from tool args
│   ├── tools/                  # One file per FreshBooks resource domain
│   │   ├── invoices.ts         # Invoice CRUD tools
│   │   ├── clients.ts          # Client CRUD tools
│   │   ├── expenses.ts         # Expense tools
│   │   ├── payments.ts         # Payment tools
│   │   ├── time-entries.ts     # Time tracking tools (uses businessId)
│   │   └── ...
│   └── types.ts                # Shared TypeScript types and interfaces
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example                # Template for required environment variables
├── README.md
├── CLAUDE.md                   # This file
└── LICENSE
```

## Development Workflow

### Setup

```bash
npm install
cp .env.example .env   # Fill in your FreshBooks credentials
```

### Build and Run

```bash
npm run build          # Compile TypeScript to dist/
npm start              # Run the compiled MCP server
npm run dev            # Run with ts-node for development
```

### Linting and Formatting

```bash
npm run lint           # ESLint
npm run format         # Prettier
```

### Testing

```bash
npm test               # Run test suite
```

## Environment Variables

All credentials are loaded from environment variables so any FreshBooks user can plug in their own account. Copy `.env.example` to `.env` and fill in your values. **Never commit `.env`.**

| Variable | Description | Maps to |
|---|---|---|
| `FRESHBOOKS_CLIENT_ID` | OAuth2 client ID from FreshBooks Developer Portal | `Client` constructor first arg |
| `FRESHBOOKS_CLIENT_SECRET` | OAuth2 client secret | `clientSecret` option |
| `FRESHBOOKS_REDIRECT_URI` | OAuth2 redirect URI | `redirectUri` option |
| `FRESHBOOKS_ACCESS_TOKEN` | Access token (after OAuth flow) | `accessToken` option |
| `FRESHBOOKS_REFRESH_TOKEN` | Refresh token (for automatic renewal) | `refreshToken` option |
| `FRESHBOOKS_ACCOUNT_ID` | FreshBooks account ID (for accounting endpoints) | Passed to resource `.list()`, `.single()`, `.create()` |
| `FRESHBOOKS_BUSINESS_ID` | FreshBooks business ID (for project/time endpoints) | Passed to `timeEntries`, `projects`, `services` methods |

**accountId vs businessId:** Most accounting resources (invoices, clients, expenses, payments) use `accountId: string`. Project-related resources (time entries, projects, services) use `businessId: number`. Both are available from `client.users.me()`.

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
| `client.taxes` | Accounting | `accountId: string` |
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

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `FreshBooks error: ${response.error?.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error: any) {
      // SDK may also throw errors with { name, message, statusCode, errors }
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

```typescript
// src/server.ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { listInvoices, getInvoice, createInvoice } from "./tools/invoices";
import { listClients, getClient, createClient } from "./tools/clients";

export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: "1.0.0",
  tools: [listInvoices, getInvoice, createInvoice, listClients, getClient, createClient],
});
```

### Tool naming convention

All tools are prefixed with `freshbooks_` and follow `freshbooks_<action>_<resource>`:
- `freshbooks_list_invoices`, `freshbooks_get_invoice`, `freshbooks_create_invoice`, `freshbooks_update_invoice`
- `freshbooks_list_clients`, `freshbooks_get_client`, `freshbooks_create_client`, `freshbooks_update_client`

Use `allowedTools: ["mcp__freshbooks__*"]` to allow all tools on the server.

### Tool annotations

| Annotation | Use for | Effect |
|---|---|---|
| `readOnlyHint: true` | List, get, search tools | Enables parallel execution |
| `destructiveHint: true` | Delete tools | Signals destructive action |
| `idempotentHint: true` | Update tools | Repeated calls have no extra effect |

## Error Handling

Tool handlers must **never throw**. Uncaught exceptions kill the agent loop.

The FreshBooks SDK can signal errors in two ways:
1. **Response-level** — `response.ok === false` with error details in `response.error`
2. **Thrown exceptions** — SDK throws errors with `{ name, message, statusCode, errors[] }`

Both must be caught and returned as `isError: true`:

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

## Shareability

This project is designed so any FreshBooks user can use it:

- All credentials are environment-variable driven — no hardcoded account IDs or tokens
- `.env.example` documents every required variable with descriptions
- Clone → `npm install` → configure `.env` → run
- README should include OAuth setup instructions for obtaining tokens from the FreshBooks Developer Portal

## Key Conventions

### TypeScript

- Strict mode (`"strict": true` in tsconfig)
- Prefer explicit types over `any` — use types from `@freshbooks/api` where available
- Use `async/await` for all asynchronous operations
- Export tool definitions as named exports from each tool module

### File Organization

- One tool file per FreshBooks resource domain (invoices, clients, expenses, etc.)
- `src/server.ts` imports all tools and bundles them into the MCP server
- `src/freshbooks-client.ts` is the single place that initializes the FreshBooks `Client`
- `src/query-helpers.ts` provides `buildQueryBuilders()` to convert tool args to SDK query builders
- Shared types go in `src/types.ts`

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
- When adding a new tool: define with `tool()` in `src/tools/<resource>.ts`, then add to the tools array in `src/server.ts`
- Use Zod `.describe()` on every schema field so Claude understands parameters
- Use `.default()` on optional Zod fields with sensible defaults
- Mark read-only tools (list, get) with `{ annotations: { readOnlyHint: true } }`
- Use the FreshBooks SDK client methods — never raw fetch/HTTP
- Check `response.ok` before accessing `response.data`, and catch thrown errors
- Monetary amounts are strings — use `big.js` for any arithmetic
- Accounting resources use `accountId` (string), project resources use `businessId` (number)
- Run `npm run build` after changes to verify TypeScript compiles cleanly
- Do not add dependencies without justification
