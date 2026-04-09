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

## Repository Status

This repository is in early development. Follow the conventions below to keep the codebase consistent as it grows.

## Key Dependencies

| Package | Purpose |
|---|---|
| `@freshbooks/api` | FreshBooks API client — OAuth, resources, query builders, types, retry |
| `@anthropic-ai/claude-agent-sdk` | MCP tool definitions via `tool()` and `createSdkMcpServer` |
| `zod` | Input schema validation for tool parameters |
| `dotenv` | Load environment variables from `.env` |

## Project Structure

```
FreshBooks-MCP/
├── src/
│   ├── index.ts                # Entry point — starts the MCP server
│   ├── server.ts               # createSdkMcpServer setup, bundles all tools
│   ├── freshbooks-client.ts    # Initializes @freshbooks/api Client from env vars
│   ├── tools/                  # One file per FreshBooks resource domain
│   │   ├── invoices.ts         # Invoice CRUD tools
│   │   ├── clients.ts          # Client CRUD tools
│   │   ├── expenses.ts         # Expense tools
│   │   ├── payments.ts         # Payment tools
│   │   ├── time-entries.ts     # Time tracking tools
│   │   ├── projects.ts         # Project tools
│   │   ├── items.ts            # Invoice line item tools
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
npm run dev            # Run with ts-node for development (if configured)
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
| `FRESHBOOKS_ACCOUNT_ID` | FreshBooks account/business ID | Passed to resource methods |

## Tool Definition Pattern

Tools are defined using the Claude Agent SDK's `tool()` helper and bundled with `createSdkMcpServer`.

### Defining a tool

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getFreshBooksClient, getAccountId } from "../freshbooks-client";

export const listInvoices = tool(
  "freshbooks_list_invoices",                          // Name: freshbooks_<action>_<resource>
  "List invoices for the FreshBooks account with optional filters",  // Description
  {                                                     // Zod schema
    page: z.number().int().min(1).default(1).describe("Page number"),
    per_page: z.number().int().min(1).max(100).default(25).describe("Results per page"),
    status: z.string().optional().describe("Filter by invoice status"),
  },
  async (args) => {                                     // Handler
    try {
      const client = getFreshBooksClient();
      const accountId = getAccountId();
      const response = await client.invoices.list(accountId);

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `FreshBooks error: ${response.error?.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to list invoices: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } }              // Read-only → can run in parallel
);
```

### Bundling tools into an MCP server

```typescript
// src/server.ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { listInvoices, getInvoice, createInvoice } from "./tools/invoices";
import { listClients, getClient, createClient } from "./tools/clients";
// ... other tool imports

export const freshbooksServer = createSdkMcpServer({
  name: "freshbooks",
  version: "1.0.0",
  tools: [
    listInvoices, getInvoice, createInvoice,
    listClients, getClient, createClient,
    // ... all tools
  ],
});
```

### Tool naming convention

All tools are prefixed with `freshbooks_` and follow the pattern `freshbooks_<action>_<resource>`:
- `freshbooks_list_invoices`, `freshbooks_get_invoice`, `freshbooks_create_invoice`
- `freshbooks_list_clients`, `freshbooks_get_client`, `freshbooks_create_client`
- `freshbooks_list_expenses`, `freshbooks_create_expense`, etc.

Use `allowedTools: ["mcp__freshbooks__*"]` to allow all tools on the server.

### Tool annotations

| Annotation | Use for | Effect |
|---|---|---|
| `readOnlyHint: true` | List, get, search tools | Enables parallel execution |
| `destructiveHint: true` | Delete tools | Informational — signals destructive action |
| `idempotentHint: true` | Update tools | Repeated calls with same args have no extra effect |

## FreshBooks SDK Patterns

### Client initialization

```typescript
// src/freshbooks-client.ts
import { Client } from "@freshbooks/api";

let fbClient: Client | null = null;

export function getFreshBooksClient(): Client {
  if (!fbClient) {
    fbClient = new Client(process.env.FRESHBOOKS_CLIENT_ID!, {
      accessToken: process.env.FRESHBOOKS_ACCESS_TOKEN!,
      refreshToken: process.env.FRESHBOOKS_REFRESH_TOKEN,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
    });
  }
  return fbClient;
}

export function getAccountId(): string {
  return process.env.FRESHBOOKS_ACCOUNT_ID!;
}
```

### Resource CRUD methods

All resources follow the same pattern on the `Client` instance:

```typescript
const accountId = getAccountId();

// List
const invoices = await client.invoices.list(accountId, queryBuilders?);

// Get single
const invoice = await client.invoices.get(accountId, invoiceId);

// Create
const newInvoice = await client.invoices.create(accountId, invoiceData);

// Update
const updated = await client.invoices.update(accountId, invoiceId, changes);
```

### Query builders

Use for filtering, pagination, and including related data on list operations:

- **`PaginationQueryBuilder`** — `page`, `perPage`
- **`SearchQueryBuilder`** — `.equals()`, `.in()`, `.like()`, `.between()`, `.boolean()`
- **`IncludesQueryBuilder`** — Fetch related sub-resources in a single call

### Response shape

Every SDK call returns:

```typescript
{
  ok: boolean;
  data?: T;            // The resource(s) on success
  error?: {
    name: string;
    message: string;
    status: number;
    details?: Array<{ field: string; errorCode: string }>;
  };
}
```

**Always check `response.ok` before accessing `response.data`.**

### Data handling notes

- **Monetary amounts** are returned as strings — use a decimal library for arithmetic, not native JS numbers
- **Dates** are normalized to UTC
- **IDs** are numeric in FreshBooks

## Error Handling

Tool handlers must **never throw**. Uncaught exceptions kill the agent loop.

1. **SDK errors** — Check `response.ok`. If `false`, return `isError: true` with the error message.
2. **Network/runtime errors** — Wrap handler body in `try/catch`, return `isError: true` on catch.
3. **Summarize for LLM** — Don't pass raw error objects. Extract the message and relevant details.

```typescript
// Pattern: always return, never throw
if (!response.ok) {
  return {
    content: [{ type: "text", text: `FreshBooks API error: ${response.error?.message}` }],
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

- Use strict TypeScript (`"strict": true` in tsconfig)
- Prefer explicit types over `any` — use types from `@freshbooks/api` where available
- Use `async/await` for all asynchronous operations
- Export tool definitions as named exports from each tool module

### File Organization

- One tool file per FreshBooks resource domain (invoices, clients, expenses, etc.)
- `src/server.ts` imports all tools and bundles them into the MCP server
- `src/freshbooks-client.ts` is the single place that initializes the FreshBooks `Client`
- Shared types go in `src/types.ts`

### Git Conventions

- Descriptive commit messages: `feat: add invoice listing tool`, `fix: handle token refresh on 401`
- One logical change per commit
- Never commit `.env`, `node_modules/`, or `dist/`

## FreshBooks API Reference

- **SDK Docs:** https://github.com/freshbooks/freshbooks-nodejs-sdk
- **API Docs:** https://www.freshbooks.com/api
- **npm:** https://www.npmjs.com/package/@freshbooks/api
- **Auth:** OAuth2 with access/refresh tokens
- **Common resources:** invoices, clients, expenses, payments, taxes, items, time_entries, projects

## Notes for AI Assistants

- Always read existing source files before modifying them
- When adding a new tool: define with `tool()` in the appropriate `src/tools/<resource>.ts`, then add it to the tools array in `src/server.ts`
- Use Zod `.describe()` on every schema field so Claude understands parameters
- Use `.default()` on optional Zod fields
- Mark read-only tools (list, get) with `{ annotations: { readOnlyHint: true } }`
- Use the FreshBooks SDK client methods (`client.invoices.list(...)`) — not raw fetch/HTTP
- Always check `response.ok` before accessing `response.data`
- Run `npm run build` after changes to verify TypeScript compiles cleanly
- Do not add dependencies without justification — keep the dependency tree lean
