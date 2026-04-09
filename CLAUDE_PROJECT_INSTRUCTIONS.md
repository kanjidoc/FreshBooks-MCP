# Claude Project Instructions — FreshBooks MCP

This file contains everything needed to set up and use the FreshBooks MCP server with Claude. It covers:

1. [Setup from scratch](#setup-from-scratch) — Getting credentials, running the setup script
2. [Installing on each Claude platform](#installing-on-claude) — Desktop, Code, Web, SDK
3. [System prompt](#system-prompt) — Copy-paste instructions for Claude projects

---

## Setup from Scratch

### Prerequisites

- **Node.js** 18+
- A **FreshBooks account** (any plan with API access)

### Step 1: Clone and install

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
```

### Step 2: Create a FreshBooks Developer App

1. Log in to [FreshBooks](https://www.freshbooks.com/)
2. Go to **Settings > Developer Portal**: https://my.freshbooks.com/#/developer
3. Click **"Create an App"**
4. Fill in:
   - **App Name:** Whatever you like (e.g., "Claude MCP")
   - **Description:** Optional
   - **Redirect URI:** `http://localhost:3456/callback` (must match exactly)
5. Click **Save**
6. Copy your **Client ID** and **Client Secret** — you'll need them next

### Step 3: Run the setup script

```bash
npm run setup
```

The script will:
1. Ask for your Client ID and Client Secret
2. Open your browser to authorize the FreshBooks app
3. You click "Allow" in the browser — the script captures the OAuth token automatically
4. Fetch your Account ID and Business ID via the FreshBooks API
5. Write everything to a `.env` file
6. Build the project
7. Print ready-to-paste MCP config for all Claude platforms

**That's it.** Copy the config the script prints and follow the platform instructions below.

### Step 4 (alternative): Manual setup

If the setup script doesn't work for your environment, see the [Manual Setup section in README.md](README.md#manual-setup).

---

## Installing on Claude

### Claude Desktop

1. Open your config file:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
2. If the file doesn't exist, create it with `{}` as contents
3. Paste the config from the setup script (or fill in manually):

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

4. **Important:** The path in `"args"` must be the **absolute path** to `dist/index.js`
5. **Restart Claude Desktop** completely (quit and reopen)
6. Look for the hammer icon — it means MCP tools are connected
7. Try: *"List my recent invoices"*

### Claude Code (CLI / VS Code / JetBrains)

1. Choose where to put the config:
   - **Global** (all projects): `~/.claude/settings.json`
   - **Per-project**: `<your-project>/.claude/settings.json`
2. Paste the same JSON config as above
3. Restart your Claude Code session (or run `/mcp` to reload)
4. Try: *"Show me my FreshBooks clients"*

### claude.ai/code (Web)

1. Add the config to `.claude/settings.json` in your repo
2. **Commit and push** so the web environment can read it
3. Start a new session at [claude.ai/code](https://claude.ai/code)
4. The MCP server will start automatically
5. Try: *"What invoices are outstanding?"*

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

---

## System Prompt

Copy the text below into your Claude project's **custom instructions** (or system prompt). This tells Claude what tools are available and how to use them.

---

You have access to a FreshBooks MCP server that lets you interact with a FreshBooks accounting account. The server exposes tools prefixed with `freshbooks_` for managing invoices, clients, expenses, payments, and time entries.

### Available tools

**Invoices:**
- `freshbooks_list_invoices` — List invoices with filters (status, customer, date range), pagination, sorting, and includes
- `freshbooks_get_invoice` — Get full invoice details by ID (line items, amounts, status)
- `freshbooks_create_invoice` — Create a new invoice with line items (amounts are strings, e.g. "100.00")
- `freshbooks_update_invoice` — Update invoice fields (notes, PO number, due date)

**Clients:**
- `freshbooks_list_clients` — List clients with search (email, organization), pagination, sorting
- `freshbooks_get_client` — Get full client details by ID
- `freshbooks_create_client` — Create a new client (name, email, organization, address)
- `freshbooks_update_client` — Update client fields

**Expenses:**
- `freshbooks_list_expenses` — List expenses with filters (vendor, category, date range), pagination, sorting
- `freshbooks_get_expense` — Get full expense details by ID
- `freshbooks_create_expense` — Record a new expense (category, staff, amount, vendor)

**Payments:**
- `freshbooks_list_payments` — List payments with invoice filter, pagination
- `freshbooks_get_payment` — Get full payment details by ID
- `freshbooks_create_payment` — Record a payment against an invoice

**Time entries:**
- `freshbooks_list_time_entries` — List time entries with sorting
- `freshbooks_get_time_entry` — Get full time entry details by ID
- `freshbooks_create_time_entry` — Log a time entry (duration in seconds)

### Important conventions

1. **Monetary amounts** are strings (e.g., `"500.00"`) with a currency code (e.g., `"USD"`). Never use floating-point math — the server preserves decimal precision with string amounts.

2. **Pagination:** All list tools accept `page` (default: 1) and `per_page` (default: 25, max: 100). When the user asks for "all" records, paginate through results.

3. **Search filters:** List tools accept optional search parameters for filtering. Use these to narrow results rather than fetching everything:
   - Invoices: `search_status`, `search_customer_id`, `search_date_min`, `search_date_max`
   - Clients: `search_email`, `search_organization`
   - Expenses: `search_vendor`, `search_category_id`, `search_date_min`, `search_date_max`
   - Payments: `search_invoice_id`

4. **Sorting:** List tools support `sort_by` and `sort_order` (asc/desc).

5. **Includes:** Invoice and expense list tools support an `includes` array to fetch related sub-resources in a single call (e.g., `["lines"]` for invoice line items).

6. **Invoice statuses:** draft, sent, viewed, paid, partial, disputed, outstanding, auto-paid, retry, failed.

7. **Payment types:** Check, Credit, Cash, Bank Transfer, Credit Card, Debit, PayPal, 2Checkout, VISA, MASTERCARD, DISCOVER, AMEX, DINERS, JCB, ACH, Other.

8. **Time entry duration** is in seconds. Convert hours/minutes to seconds (e.g., 1.5 hours = 5400 seconds).

### Behavior guidelines

- When the user asks about their financial data, use the appropriate list/get tools to fetch real data
- Summarize results in a clear, readable format — present tables or bullet points, not raw JSON (unless asked)
- For creating records, confirm the details with the user before calling the create tool
- When listing large datasets, start with a filtered or paginated request and ask if the user wants to see more
- If a tool returns an error, explain what went wrong in plain language and suggest how to fix it
- When showing monetary amounts, always include the currency code (e.g., "$1,250.00 USD")

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Setup script can't open browser | Copy the authorization URL from the terminal and paste it in your browser manually |
| "FRESHBOOKS_CLIENT_ID is not set" | Your `.env` file is missing or the MCP config doesn't include the env vars |
| "401 Unauthorized" | Access token expired. Re-run `npm run setup` to get a new token |
| Tools not showing in Claude Desktop | Check that `"args"` has the absolute path to `dist/index.js`. Restart Claude completely. |
| "Cannot find module dist/index.js" | Run `npm run build` |
| Multiple FreshBooks businesses | The setup script uses the first business. Edit `.env` to use a different Account/Business ID |
| OAuth callback timeout | Make sure port 3456 isn't blocked by a firewall, and that the redirect URI in your FreshBooks app matches exactly: `http://localhost:3456/callback` |
