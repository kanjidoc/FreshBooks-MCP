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

## Quick Start

The interactive setup script handles everything — creating the OAuth connection, fetching your IDs, and generating config for all Claude platforms:

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
npm run setup
```

The setup script will:
1. Prompt you for your FreshBooks Developer App credentials
2. Open your browser to authorize the app
3. Capture the OAuth tokens automatically
4. Fetch your Account ID and Business ID
5. Write your `.env` file
6. Build the project
7. Print ready-to-paste MCP config for Claude Desktop, Claude Code, and claude.ai/code

If you prefer to set things up manually, see [Manual Setup](#manual-setup) below.

## Installing on Claude

After running `npm run setup`, the script prints config blocks for each platform. Here's what to do with them:

### Claude Desktop

1. Open your Claude Desktop config file:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
2. If the file doesn't exist, create it
3. Paste the config block from the setup script. It looks like this:

```json
{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["/absolute/path/to/FreshBooks-MCP/dist/index.js"],
      "env": {
        "FRESHBOOKS_CLIENT_ID": "your_client_id",
        "FRESHBOOKS_CLIENT_SECRET": "your_client_secret",
        "FRESHBOOKS_REDIRECT_URI": "http://localhost:3456/callback",
        "FRESHBOOKS_ACCESS_TOKEN": "your_access_token",
        "FRESHBOOKS_REFRESH_TOKEN": "your_refresh_token",
        "FRESHBOOKS_ACCOUNT_ID": "your_account_id",
        "FRESHBOOKS_BUSINESS_ID": "your_business_id"
      }
    }
  }
}
```

4. **Restart Claude Desktop** for the changes to take effect
5. You should see a hammer icon indicating MCP tools are available
6. Try: *"List my recent invoices"*

### Claude Code (CLI / IDE Extensions)

1. Open your settings file:
   - **Global:** `~/.claude/settings.json` (applies to all projects)
   - **Per-project:** `<project>/.claude/settings.json`
2. Paste the same config block as above
3. Restart your Claude Code session
4. Try: *"List my FreshBooks clients"*

### claude.ai/code (Web)

1. Add the config to your project's `.claude/settings.json`
2. Push the settings file to your repo so the web environment can access it
3. Start a new claude.ai/code session in that repo
4. Try: *"Show me my unpaid invoices"*

### Claude Agent SDK (Programmatic)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { freshbooksServer } from "./path/to/FreshBooks-MCP/src/server";

for await (const message of query({
  prompt: "Show me my unpaid invoices",
  options: {
    mcpServers: { freshbooks: freshbooksServer },
    allowedTools: ["mcp__freshbooks__*"],
  },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

## Manual Setup

If you prefer not to use the setup script, follow these steps:

### 1. Create a FreshBooks Developer App

1. Log in to [FreshBooks](https://www.freshbooks.com/)
2. Navigate to **Settings > Developer Portal**: https://my.freshbooks.com/#/developer
3. Click **"Create an App"**
4. Fill in your app details:
   - **App Name:** Whatever you like (e.g., "Claude MCP")
   - **Redirect URI:** `http://localhost:3456/callback`
5. Save the app and copy your **Client ID** and **Client Secret**

### 2. Complete the OAuth2 flow

You need an access token and refresh token. The FreshBooks SDK handles the OAuth2 flow:

```typescript
import { Client } from "@freshbooks/api";

const client = new Client("YOUR_CLIENT_ID", {
  clientSecret: "YOUR_CLIENT_SECRET",
  redirectUri: "http://localhost:3456/callback",
});

// Step 1: Get the authorization URL
const authUrl = client.getAuthRequestUrl();
console.log("Visit this URL in your browser:", authUrl);

// Step 2: After you authorize, FreshBooks redirects to your redirect URI
// with a ?code= parameter. Capture that code.

// Step 3: Exchange the code for tokens
const tokens = await client.getAccessToken(code);
console.log("Access Token:", tokens.accessToken);
console.log("Refresh Token:", tokens.refreshToken);
```

### 3. Find your Account ID and Business ID

After getting your tokens, call `users.me()`:

```typescript
const authedClient = new Client("YOUR_CLIENT_ID", {
  accessToken: tokens.accessToken,
});

const { data } = await authedClient.users.me();
// data.businessMemberships[0].business.accountId → your Account ID
// data.businessMemberships[0].business.id → your Business ID
```

**Why two IDs?**
- **Account ID** (string) — Used for accounting endpoints: invoices, clients, expenses, payments, items, taxes
- **Business ID** (number) — Used for project endpoints: time entries, projects, services

### 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
FRESHBOOKS_CLIENT_ID=your_client_id
FRESHBOOKS_CLIENT_SECRET=your_client_secret
FRESHBOOKS_REDIRECT_URI=http://localhost:3456/callback
FRESHBOOKS_ACCESS_TOKEN=your_access_token
FRESHBOOKS_REFRESH_TOKEN=your_refresh_token
FRESHBOOKS_ACCOUNT_ID=your_account_id
FRESHBOOKS_BUSINESS_ID=your_business_id
```

### 5. Build

```bash
npm run build
```

Then follow the [Installing on Claude](#installing-on-claude) instructions above.

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
| `scripts/setup.ts` | Interactive setup script — OAuth flow, ID discovery, config generation |

### Technology stack

- **[FreshBooks Node.js SDK](https://www.npmjs.com/package/@freshbooks/api)** (`@freshbooks/api`) — Official SDK for all FreshBooks API interactions, including OAuth, resource CRUD, query builders, and automatic retry
- **[Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview)** (`@anthropic-ai/claude-agent-sdk`) — Provides `tool()` and `createSdkMcpServer` for defining MCP tools with Zod schemas
- **[Zod](https://zod.dev/)** — Input schema validation for tool parameters
- **[big.js](https://github.com/MikeMcl/big.js/)** — Decimal arithmetic for monetary values (FreshBooks returns amounts as strings to avoid floating-point precision issues)
- **TypeScript** — Strict mode, compiled to ES2022

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
npm run setup          # Interactive setup (OAuth + config generation)
npm run lint           # Lint with ESLint
npm run format         # Format with Prettier
npm test               # Run tests
```

## Troubleshooting

| Problem | Solution |
|---|---|
| "FRESHBOOKS_CLIENT_ID is not set" | Your `.env` file is missing or incomplete. Run `npm run setup` or check `.env.example`. |
| "401 Unauthorized" from FreshBooks | Your access token has expired. Get a new one via the OAuth flow or use the refresh token. |
| MCP tools not showing in Claude | Make sure the config path in `"args"` is an absolute path to `dist/index.js`. Restart Claude. |
| "Cannot find module dist/index.js" | Run `npm run build` first. |
| Multiple FreshBooks businesses | The setup script uses the first business. Edit `.env` to change the Account ID / Business ID. |

## License

[MIT](LICENSE)

## Acknowledgments

- **[FreshBooks](https://www.freshbooks.com/)** — Cloud accounting platform and API
- **[FreshBooks Node.js SDK](https://github.com/freshbooks/freshbooks-nodejs-sdk)** — Official SDK maintained by the FreshBooks team
- **[Anthropic](https://www.anthropic.com/)** — Claude Agent SDK and Model Context Protocol
- **[MCP](https://modelcontextprotocol.io/)** — Open protocol for AI tool integration
