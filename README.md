# FreshBooks MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI assistants access to the [FreshBooks](https://www.freshbooks.com/) accounting API. Built with the official [FreshBooks Node.js SDK](https://github.com/freshbooks/freshbooks-nodejs-sdk) and the [Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview).

## What It Does

This server exposes FreshBooks accounting operations as MCP tools that any compatible AI assistant can call. Instead of manually navigating the FreshBooks UI, you can ask your AI assistant to:

- List, view, create, update, and delete **invoices**
- Manage **clients** and their contact details
- Track and record **expenses** with category lookups
- Record **payments** against invoices
- Log **time entries** for projects
- Manage **bills**, **bill payments**, and **bill vendors** (accounts payable)
- Create and manage **credit notes**
- Track **items** (products/services you sell)
- Manage **projects**, **services**, and **tasks**
- Record **other incomes** outside of invoicing
- Create **journal entries** for manual accounting adjustments
- Run **reports**: Profit & Loss, Payments Collected, Tax Summary

All 73 tools support the FreshBooks API's pagination, search filters, sorting, and related-resource includes.

## How It Works

This MCP server runs **locally on your computer** as a Node.js process. When you configure Claude to use it, Claude launches the server automatically whenever you start a conversation. The server talks to the FreshBooks API using your OAuth credentials.

```
GitHub repo
    ↓ git clone
Your computer: ~/FreshBooks-MCP/
    ↓ npm install + npm run build + configure .env
dist/index.js (compiled MCP server, ready to run)
    ↓ Claude reads your config file
Claude launches "node dist/index.js" as a background process
    ↓ You say "list my invoices"
Claude sends a tool call → MCP server → FreshBooks API → results back to Claude
```

Nothing runs "in the cloud" — the server is a local program on your machine that Claude knows how to start and talk to.

## Quick Start

### Prerequisites

- **[Node.js](https://nodejs.org/) 18+** — if you don't have it, download it from nodejs.org
- A **FreshBooks account** — any plan that has API access

### Step 1: Clone, install, and build

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
npm run build
```

### Step 2: Get your FreshBooks credentials

You need 7 values from FreshBooks. Here's how to get them:

1. Log in to [FreshBooks](https://www.freshbooks.com/)
2. Go to **Settings > Developer Portal**: https://my.freshbooks.com/#/developer
3. Click **"Create an App"** (set Application Type to "Private App")
4. Set the **Redirect URI** to: `https://localhost/callback`
5. Save and copy your **Client ID** and **Client Secret**
6. Complete the OAuth flow to get your **Access Token** and **Refresh Token** (see [OAuth Flow](#completing-the-oauth-flow) below)
7. Find your **Account ID** and **Business ID** by calling the FreshBooks API's `/users/me` endpoint after you have tokens

### Step 3: Configure your `.env` file

```bash
cp .env.example .env
```

Open `.env` in any editor and paste in all 7 values:

```env
FRESHBOOKS_CLIENT_ID=your_client_id
FRESHBOOKS_CLIENT_SECRET=your_client_secret
FRESHBOOKS_REDIRECT_URI=https://localhost/callback
FRESHBOOKS_ACCESS_TOKEN=your_access_token
FRESHBOOKS_REFRESH_TOKEN=your_refresh_token
FRESHBOOKS_ACCOUNT_ID=your_account_id
FRESHBOOKS_BUSINESS_ID=your_business_id
```

### Step 4: Tell Claude about the server

Add the MCP server to your Claude config file. See [Installing on Claude](#installing-on-claude) below.

### Step 5: Test it

Start a new Claude conversation and try: *"List my recent invoices"*

### Interactive setup script (optional)

If you prefer a guided walkthrough that handles the OAuth flow and auto-detects your IDs:

```bash
npm run setup
```

> **Note:** This script requires an interactive terminal. It will not work inside Claude Code sessions or non-interactive environments. Run it in a regular Terminal/shell.

## Installing on Claude

Add the MCP server config to your Claude platform. Replace the placeholder values with your actual credentials from `.env`.

### Claude Desktop

1. Open your Claude Desktop config file:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
2. If the file doesn't exist, create it
3. Add the following (replace values with your own):

```json
{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["/absolute/path/to/FreshBooks-MCP/dist/index.js"],
      "env": {
        "FRESHBOOKS_CLIENT_ID": "your_client_id",
        "FRESHBOOKS_CLIENT_SECRET": "your_client_secret",
        "FRESHBOOKS_REDIRECT_URI": "https://localhost/callback",
        "FRESHBOOKS_ACCESS_TOKEN": "your_access_token",
        "FRESHBOOKS_REFRESH_TOKEN": "your_refresh_token",
        "FRESHBOOKS_ACCOUNT_ID": "your_account_id",
        "FRESHBOOKS_BUSINESS_ID": "your_business_id"
      }
    }
  }
}
```

4. **Important:** The path in `"args"` must be the **absolute path** to `dist/index.js`
5. **Restart Claude Desktop** for the changes to take effect
6. You should see a hammer icon indicating MCP tools are available
7. Try: *"List my recent invoices"*

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

## Completing the OAuth Flow

FreshBooks uses OAuth2, so you need to exchange a one-time authorization code for access/refresh tokens. Here's how:

1. **Build the authorization URL** — visit this in your browser (replace your client ID):
   ```
   https://auth.freshbooks.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://localhost/callback
   ```

2. **Click "Allow"** — FreshBooks will redirect your browser to `https://localhost/callback?code=SOME_CODE`. The page won't load (that's expected). Copy the `code` value from the URL bar.

3. **Exchange the code for tokens** — make a POST request (e.g., with `curl`):
   ```bash
   curl -X POST https://api.freshbooks.com/auth/oauth/token \
     -H "Content-Type: application/json" \
     -d '{
       "grant_type": "authorization_code",
       "client_id": "YOUR_CLIENT_ID",
       "client_secret": "YOUR_CLIENT_SECRET",
       "code": "THE_CODE_FROM_STEP_2",
       "redirect_uri": "https://localhost/callback"
     }'
   ```
   The response contains your `access_token` and `refresh_token`.

4. **Get your Account ID and Business ID** — call the identity endpoint:
   ```bash
   curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     https://api.freshbooks.com/auth/api/v1/users/me
   ```
   Look for `business_memberships[0].business.account_id` (Account ID) and `business_memberships[0].business.id` (Business ID).

**Why two IDs?**
- **Account ID** (string) — Used for accounting endpoints: invoices, clients, expenses, payments, items, bills, etc.
- **Business ID** (number) — Used for project endpoints: time entries, projects, services

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
| `src/tools/invoices.ts` | Invoice tools: list, get, create, update, delete |
| `src/tools/clients.ts` | Client tools: list, get, create, update, delete |
| `src/tools/expenses.ts` | Expense tools: list, get, create, update, delete |
| `src/tools/payments.ts` | Payment tools: list, get, create, update, delete |
| `src/tools/time-entries.ts` | Time entry tools: list, get, create, update, delete |
| `src/tools/items.ts` | Item tools: list, get, create, update |
| `src/tools/bills.ts` | Bill tools: list, get, create, delete |
| `src/tools/bill-payments.ts` | Bill payment tools: list, get, create, update, delete |
| `src/tools/bill-vendors.ts` | Bill vendor tools: list, get, create, update, delete |
| `src/tools/credit-notes.ts` | Credit note tools: list, get, create, update, delete |
| `src/tools/other-incomes.ts` | Other income tools: list, get, create, update, delete |
| `src/tools/projects.ts` | Project tools: list, get, create, update, delete |
| `src/tools/services.ts` | Service tools: list, get, create |
| `src/tools/tasks.ts` | Task tools: list, get, create, update, delete |
| `src/tools/expense-categories.ts` | Expense category tools: list, get (read-only) |
| `src/tools/journal-entries.ts` | Journal entry tools: create, list accounts, list details |
| `src/tools/reports.ts` | Reports: Profit & Loss, Payments Collected, Tax Summary |
| `scripts/setup.ts` | Interactive setup script — OAuth flow, ID discovery, config generation |

### Technology stack

- **[FreshBooks Node.js SDK](https://www.npmjs.com/package/@freshbooks/api)** (`@freshbooks/api`) — Official SDK for all FreshBooks API interactions, including OAuth, resource CRUD, query builders, and automatic retry
- **[Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview)** (`@anthropic-ai/claude-agent-sdk`) — Provides `tool()` and `createSdkMcpServer` for defining MCP tools with Zod schemas
- **[Zod](https://zod.dev/)** — Input schema validation for tool parameters
- **[big.js](https://github.com/MikeMcl/big.js/)** — Decimal arithmetic for monetary values (FreshBooks returns amounts as strings to avoid floating-point precision issues)
- **TypeScript** — Strict mode, compiled to ES2022

## Available Tools (73 total)

### Invoices
| Tool | Description |
|---|---|
| `freshbooks_list_invoices` | List invoices with pagination, status filters, date range, sorting, and includes |
| `freshbooks_get_invoice` | Get a single invoice by ID with full details |
| `freshbooks_create_invoice` | Create a new invoice with line items |
| `freshbooks_update_invoice` | Update invoice fields (notes, PO number, due date) |
| `freshbooks_delete_invoice` | Delete an invoice |

### Clients
| Tool | Description |
|---|---|
| `freshbooks_list_clients` | List clients with pagination, email/organization search, sorting |
| `freshbooks_get_client` | Get a single client by ID |
| `freshbooks_create_client` | Create a new client with contact and billing info |
| `freshbooks_update_client` | Update client fields |
| `freshbooks_delete_client` | Delete a client |

### Expenses
| Tool | Description |
|---|---|
| `freshbooks_list_expenses` | List expenses with date range, vendor, and category filters |
| `freshbooks_get_expense` | Get a single expense by ID |
| `freshbooks_create_expense` | Record a new expense |
| `freshbooks_update_expense` | Update an existing expense |
| `freshbooks_delete_expense` | Delete an expense |

### Expense Categories
| Tool | Description |
|---|---|
| `freshbooks_list_expense_categories` | List all expense categories |
| `freshbooks_get_expense_category` | Get a single expense category by ID |

### Payments
| Tool | Description |
|---|---|
| `freshbooks_list_payments` | List payments with invoice filter |
| `freshbooks_get_payment` | Get a single payment by ID |
| `freshbooks_create_payment` | Record a payment against an invoice |
| `freshbooks_update_payment` | Update a payment |
| `freshbooks_delete_payment` | Delete a payment |

### Time Entries
| Tool | Description |
|---|---|
| `freshbooks_list_time_entries` | List time entries with sorting |
| `freshbooks_get_time_entry` | Get a single time entry by ID |
| `freshbooks_create_time_entry` | Log a new time entry |
| `freshbooks_update_time_entry` | Update a time entry |
| `freshbooks_delete_time_entry` | Delete a time entry |

### Items
| Tool | Description |
|---|---|
| `freshbooks_list_items` | List items (products/services you sell) |
| `freshbooks_get_item` | Get a single item by ID |
| `freshbooks_create_item` | Create a new item |
| `freshbooks_update_item` | Update an item |

### Bills (Accounts Payable)
| Tool | Description |
|---|---|
| `freshbooks_list_bills` | List bills with filters |
| `freshbooks_get_bill` | Get a single bill by ID |
| `freshbooks_create_bill` | Create a new bill |
| `freshbooks_delete_bill` | Delete a bill |

### Bill Payments
| Tool | Description |
|---|---|
| `freshbooks_list_bill_payments` | List bill payments |
| `freshbooks_get_bill_payment` | Get a single bill payment by ID |
| `freshbooks_create_bill_payment` | Record a payment against a bill |
| `freshbooks_update_bill_payment` | Update a bill payment |
| `freshbooks_delete_bill_payment` | Delete a bill payment |

### Bill Vendors
| Tool | Description |
|---|---|
| `freshbooks_list_bill_vendors` | List bill vendors |
| `freshbooks_get_bill_vendor` | Get a single bill vendor by ID |
| `freshbooks_create_bill_vendor` | Create a new bill vendor |
| `freshbooks_update_bill_vendor` | Update a bill vendor |
| `freshbooks_delete_bill_vendor` | Delete a bill vendor |

### Credit Notes
| Tool | Description |
|---|---|
| `freshbooks_list_credit_notes` | List credit notes |
| `freshbooks_get_credit_note` | Get a single credit note by ID |
| `freshbooks_create_credit_note` | Create a new credit note |
| `freshbooks_update_credit_note` | Update a credit note |
| `freshbooks_delete_credit_note` | Delete a credit note |

### Other Incomes
| Tool | Description |
|---|---|
| `freshbooks_list_other_incomes` | List other income entries |
| `freshbooks_get_other_income` | Get a single other income by ID |
| `freshbooks_create_other_income` | Record a non-invoice income |
| `freshbooks_update_other_income` | Update an other income entry |
| `freshbooks_delete_other_income` | Delete an other income entry |

### Projects
| Tool | Description |
|---|---|
| `freshbooks_list_projects` | List projects |
| `freshbooks_get_project` | Get a single project by ID |
| `freshbooks_create_project` | Create a new project |
| `freshbooks_update_project` | Update a project |
| `freshbooks_delete_project` | Delete a project |

### Services
| Tool | Description |
|---|---|
| `freshbooks_list_services` | List services |
| `freshbooks_get_service` | Get a single service by ID |
| `freshbooks_create_service` | Create a new service |

### Tasks
| Tool | Description |
|---|---|
| `freshbooks_list_tasks` | List tasks |
| `freshbooks_get_task` | Get a single task by ID |
| `freshbooks_create_task` | Create a new task |
| `freshbooks_update_task` | Update a task |
| `freshbooks_delete_task` | Delete a task |

### Journal Entries
| Tool | Description |
|---|---|
| `freshbooks_create_journal_entry` | Create a manual journal entry |
| `freshbooks_list_journal_entry_accounts` | List accounts available for journal entries |
| `freshbooks_list_journal_entry_details` | List journal entry line details |

### Reports
| Tool | Description |
|---|---|
| `freshbooks_report_profit_loss` | Generate a Profit & Loss report |
| `freshbooks_report_payments_collected` | Generate a Payments Collected report |
| `freshbooks_report_tax_summary` | Generate a Tax Summary report |

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
