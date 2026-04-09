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

### Step 1: Clone, install, and build

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
npm run build
```

### Step 2: Get your FreshBooks credentials

1. Log in to [FreshBooks](https://www.freshbooks.com/)
2. Go to **Settings > Developer Portal**: https://my.freshbooks.com/#/developer
3. Click **"Create an App"** (Application Type: "Private App")
4. Set the **Redirect URI** to: `https://localhost/callback`
5. Save and copy your **Client ID** and **Client Secret**
6. Complete the OAuth flow to get tokens (see [README.md](README.md#completing-the-oauth-flow))
7. Find your Account ID and Business ID from the `/users/me` endpoint

### Step 3: Configure `.env`

```bash
cp .env.example .env
```

Paste all 7 values into `.env`. Then follow the platform instructions below to tell Claude about the server.

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

You have access to a FreshBooks MCP server that lets you interact with a FreshBooks accounting account. The server exposes 73 tools prefixed with `freshbooks_` covering the full FreshBooks API: invoicing, clients, expenses, payments, time tracking, bills (accounts payable), credit notes, items, projects, services, tasks, journal entries, and reports.

### Available tools

**Invoices:** `freshbooks_list_invoices`, `freshbooks_get_invoice`, `freshbooks_create_invoice`, `freshbooks_update_invoice`, `freshbooks_delete_invoice`

**Clients:** `freshbooks_list_clients`, `freshbooks_get_client`, `freshbooks_create_client`, `freshbooks_update_client`, `freshbooks_delete_client`

**Expenses:** `freshbooks_list_expenses`, `freshbooks_get_expense`, `freshbooks_create_expense`, `freshbooks_update_expense`, `freshbooks_delete_expense`

**Expense Categories (read-only):** `freshbooks_list_expense_categories`, `freshbooks_get_expense_category`

**Payments:** `freshbooks_list_payments`, `freshbooks_get_payment`, `freshbooks_create_payment`, `freshbooks_update_payment`, `freshbooks_delete_payment`

**Time Entries:** `freshbooks_list_time_entries`, `freshbooks_get_time_entry`, `freshbooks_create_time_entry`, `freshbooks_update_time_entry`, `freshbooks_delete_time_entry`

**Items:** `freshbooks_list_items`, `freshbooks_get_item`, `freshbooks_create_item`, `freshbooks_update_item`

**Bills (Accounts Payable):** `freshbooks_list_bills`, `freshbooks_get_bill`, `freshbooks_create_bill`, `freshbooks_delete_bill`

**Bill Payments:** `freshbooks_list_bill_payments`, `freshbooks_get_bill_payment`, `freshbooks_create_bill_payment`, `freshbooks_update_bill_payment`, `freshbooks_delete_bill_payment`

**Bill Vendors:** `freshbooks_list_bill_vendors`, `freshbooks_get_bill_vendor`, `freshbooks_create_bill_vendor`, `freshbooks_update_bill_vendor`, `freshbooks_delete_bill_vendor`

**Credit Notes:** `freshbooks_list_credit_notes`, `freshbooks_get_credit_note`, `freshbooks_create_credit_note`, `freshbooks_update_credit_note`, `freshbooks_delete_credit_note`

**Other Incomes:** `freshbooks_list_other_incomes`, `freshbooks_get_other_income`, `freshbooks_create_other_income`, `freshbooks_update_other_income`, `freshbooks_delete_other_income`

**Projects:** `freshbooks_list_projects`, `freshbooks_get_project`, `freshbooks_create_project`, `freshbooks_update_project`, `freshbooks_delete_project`

**Services:** `freshbooks_list_services`, `freshbooks_get_service`, `freshbooks_create_service`

**Tasks:** `freshbooks_list_tasks`, `freshbooks_get_task`, `freshbooks_create_task`, `freshbooks_update_task`, `freshbooks_delete_task`

**Journal Entries:** `freshbooks_create_journal_entry`, `freshbooks_list_journal_entry_accounts`, `freshbooks_list_journal_entry_details`

**Reports:** `freshbooks_report_profit_loss`, `freshbooks_report_payments_collected`, `freshbooks_report_tax_summary`

### Important conventions

1. **Monetary amounts** are strings (e.g., `"500.00"`) with a currency code (e.g., `"USD"`). Never use floating-point math — the server preserves decimal precision with string amounts.

2. **Pagination:** All list tools accept `page` (default: 1) and `per_page` (default: 25, max: 100). When the user asks for "all" records, paginate through results.

3. **Search filters:** List tools accept optional search parameters for filtering. Use these to narrow results rather than fetching everything. Each tool's parameters are self-documented via Zod `.describe()` — inspect the tool schema for available filters.

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
| OAuth callback timeout | Make sure the redirect URI in your FreshBooks app matches exactly: `https://localhost/callback` |
