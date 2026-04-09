# FreshBooks MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI assistants access to the [FreshBooks](https://www.freshbooks.com/) accounting API. Built with the official [FreshBooks Node.js SDK](https://github.com/freshbooks/freshbooks-nodejs-sdk) and the [Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview).

## What It Does

This server exposes FreshBooks accounting operations as MCP tools that any compatible AI assistant can call. Instead of manually navigating the FreshBooks UI, you can ask your AI assistant to:

- List, view, create, and update **invoices**
- Manage **clients** and their contact details
- Track and record **expenses**
- Record **payments** against invoices
- Log **time entries** for projects

All tools support the FreshBooks API's pagination, search filters, sorting, and related-resource includes.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AI Assistant (Claude, etc.)                        │
│  Calls MCP tools: freshbooks_list_invoices, etc.    │
└─────────────┬───────────────────────────────────────┘
              │ MCP Protocol
┌─────────────▼───────────────────────────────────────┐
│  FreshBooks MCP Server                              │
│                                                     │
│  src/server.ts        ← createSdkMcpServer          │
│  src/tools/*.ts       ← tool() definitions          │
│  src/query-helpers.ts ← query builder utilities      │
│  src/freshbooks-client.ts ← SDK Client singleton    │
└─────────────┬───────────────────────────────────────┘
              │ HTTPS (OAuth2)
┌─────────────▼───────────────────────────────────────┐
│  FreshBooks API                                     │
│  https://api.freshbooks.com                         │
└─────────────────────────────────────────────────────┘
```

### Key components

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — loads env vars and exports the MCP server |
| `src/server.ts` | Bundles all tools into a single MCP server via `createSdkMcpServer` |
| `src/freshbooks-client.ts` | Singleton FreshBooks `Client` initialized from environment variables |
| `src/query-helpers.ts` | Converts tool arguments into FreshBooks SDK query builders (pagination, search, sort, includes) |
| `src/tools/invoices.ts` | Invoice tools: list, get, create, update |
| `src/tools/clients.ts` | Client tools: list, get, create, update |
| `src/tools/expenses.ts` | Expense tools: list, get, create |
| `src/tools/payments.ts` | Payment tools: list, get, create |
| `src/tools/time-entries.ts` | Time entry tools: list, get, create |

### Technology stack

- **[FreshBooks Node.js SDK](https://www.npmjs.com/package/@freshbooks/api)** (`@freshbooks/api`) — Official SDK for all FreshBooks API interactions, including OAuth, resource CRUD, query builders, and automatic retry
- **[Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview)** (`@anthropic-ai/claude-agent-sdk`) — Provides `tool()` and `createSdkMcpServer` for defining MCP tools with Zod schemas
- **[Zod](https://zod.dev/)** — Input schema validation for tool parameters
- **[big.js](https://github.com/MikeMcl/big.js/)** — Decimal arithmetic for monetary values (FreshBooks returns amounts as strings to avoid floating-point precision issues)
- **TypeScript** — Strict mode, compiled to ES2022

## Prerequisites

- **Node.js** 18+
- A **FreshBooks account** with API access
- A **FreshBooks Developer App** (to get OAuth credentials)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
```

### 2. Create a FreshBooks Developer App

1. Log in to your FreshBooks account
2. Go to [Settings > Developer Portal](https://my.freshbooks.com/#/developer)
3. Create a new application
4. Note your **Client ID** and **Client Secret**
5. Set a **Redirect URI** (e.g., `http://localhost:3000/callback`)

### 3. Get your access token

Complete the OAuth2 flow to obtain an access token and refresh token. The FreshBooks SDK supports this:

```typescript
import { Client } from "@freshbooks/api";

const client = new Client("YOUR_CLIENT_ID", {
  clientSecret: "YOUR_CLIENT_SECRET",
  redirectUri: "http://localhost:3000/callback",
});

// 1. Get the authorization URL and visit it in your browser
const authUrl = client.getAuthRequestUrl();
console.log("Visit:", authUrl);

// 2. After authorizing, capture the 'code' from the redirect URL
// 3. Exchange it for tokens
const tokens = await client.getAccessToken(code);
console.log(tokens);
// { accessToken: "...", refreshToken: "...", accessTokenExpiresAt: Date }
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
FRESHBOOKS_CLIENT_ID=your_client_id
FRESHBOOKS_CLIENT_SECRET=your_client_secret
FRESHBOOKS_REDIRECT_URI=http://localhost:3000/callback
FRESHBOOKS_ACCESS_TOKEN=your_access_token
FRESHBOOKS_REFRESH_TOKEN=your_refresh_token
FRESHBOOKS_ACCOUNT_ID=your_account_id
FRESHBOOKS_BUSINESS_ID=your_business_id
```

**Finding your Account ID and Business ID:** After authenticating, call `client.users.me()` — the response includes your business memberships with both IDs.

### 5. Build and run

```bash
npm run build
npm start
```

## Available Tools

| Tool | Description |
|---|---|
| `freshbooks_list_invoices` | List invoices with pagination, status filters, date range, sorting, and includes |
| `freshbooks_get_invoice` | Get a single invoice by ID with full details |
| `freshbooks_create_invoice` | Create a new invoice with line items |
| `freshbooks_update_invoice` | Update invoice fields (notes, PO number, due date) |
| `freshbooks_list_clients` | List clients with pagination, email/organization search, sorting |
| `freshbooks_get_client` | Get a single client by ID |
| `freshbooks_create_client` | Create a new client with contact and billing info |
| `freshbooks_update_client` | Update client fields |
| `freshbooks_list_expenses` | List expenses with date range, vendor, and category filters |
| `freshbooks_get_expense` | Get a single expense by ID |
| `freshbooks_create_expense` | Record a new expense |
| `freshbooks_list_payments` | List payments with invoice filter |
| `freshbooks_get_payment` | Get a single payment by ID |
| `freshbooks_create_payment` | Record a payment against an invoice |
| `freshbooks_list_time_entries` | List time entries with sorting |
| `freshbooks_get_time_entry` | Get a single time entry by ID |
| `freshbooks_create_time_entry` | Log a new time entry |

## Monetary Values

FreshBooks returns all monetary values as a `Money` object:

```typescript
{ amount: "100.00", code: "USD" }
```

The `amount` is a **string** to avoid floating-point precision loss. When performing calculations on these values, use a decimal arithmetic library like [big.js](https://github.com/MikeMcl/big.js/). This project includes `big.js` as a dependency for this purpose.

## Development

```bash
npm run build          # Compile TypeScript
npm run dev            # Run with ts-node
npm run lint           # Lint with ESLint
npm run format         # Format with Prettier
npm test               # Run tests
```

## License

[MIT](LICENSE)

## Acknowledgments

- **[FreshBooks](https://www.freshbooks.com/)** — Cloud accounting platform and API
- **[FreshBooks Node.js SDK](https://github.com/freshbooks/freshbooks-nodejs-sdk)** — Official SDK maintained by the FreshBooks team
- **[Anthropic](https://www.anthropic.com/)** — Claude Agent SDK and Model Context Protocol
- **[MCP](https://modelcontextprotocol.io/)** — Open protocol for AI tool integration
