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
- Ask the server **how it works** — the `freshbooks_help` tool returns its own architecture, conventions, and live tool inventory

All 75 tools support the FreshBooks API's pagination, search filters, sorting, and related-resource includes where applicable.

## 🚀 Getting Started

**New here? Follow [SETUP.md](SETUP.md) — the complete, beginner-friendly setup walkthrough.** It takes about 15 minutes, assumes no coding experience, and covers both Claude Desktop and Claude Code. All you need is Claude installed on your computer and a regular FreshBooks account.

> **🤖 If you are an AI assistant** helping someone install this: open **[SETUP.md](SETUP.md)** and follow it from top to bottom. It is written as a step-by-step script — do the steps you can, and hand the interactive ones (the browser login, the setup wizard) to the user with exact instructions.

Already set up, or just want to understand how it works? Read on.

## How It Works

This MCP server runs **locally on your computer** as a Node.js process. When you configure Claude to use it, Claude launches the server automatically whenever you start a conversation. The server talks to the FreshBooks API using your OAuth credentials.

```
GitHub repo
    ↓ download or git clone
Your computer: ~/FreshBooks-MCP/
    ↓ npm install + npm run setup (OAuth, config, build)
dist/index.js (compiled MCP server, ready to run)
    ↓ Claude reads your config file
Claude launches "node dist/index.js" as a background process
    ↓ You say "list my invoices"
Claude sends a tool call → MCP server → FreshBooks API → results back to Claude
```

Nothing runs "in the cloud" — the server is a local program on your machine that Claude knows how to start and talk to.

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
│  src/server.ts         ← createSdkMcpServer         │
│  src/tool-registry.ts  ← all tools + token refresh  │
│  src/tools/*.ts        ← tool() definitions         │
│  src/freshbooks-client.ts ← SDK client + OAuth      │
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
| `src/index.ts` | Entry point — refreshes the OAuth token, then starts the stdio MCP server |
| `src/server.ts` | Serves the registered tools via `createSdkMcpServer` |
| `src/tool-registry.ts` | The single list of all tools; wraps each handler with automatic token refresh |
| `src/freshbooks-client.ts` | FreshBooks `Client` singleton + OAuth token persistence and refresh |
| `src/config-paths.ts` | OS-aware path resolution for the Claude Desktop config |
| `src/mcp-config.ts` | Builds the MCP server config entry for Claude Desktop and Claude Code |
| `src/query-helpers.ts` | Converts tool arguments into FreshBooks SDK query builders (pagination, search, sort, includes) |
| `src/date-helpers.ts` | Local-time parsing for date-only accounting fields |
| `src/docs/` | Embedded documentation served by the `freshbooks_help` tool |
| `src/tools/*.ts` | One file per resource domain — the `tool()` definitions |
| `scripts/setup.ts` | Interactive setup script — OAuth flow, ID discovery, config generation |
| `scripts/refresh-tokens.ts` | Token health-check + refresh CLI (`npm run refresh-tokens`) |

### Technology stack

- **[FreshBooks Node.js SDK](https://www.npmjs.com/package/@freshbooks/api)** (`@freshbooks/api`) — Official SDK for all FreshBooks API interactions, including OAuth, resource CRUD, query builders, and automatic retry
- **[Claude Agent SDK](https://docs.anthropic.com/en/agent-sdk/overview)** (`@anthropic-ai/claude-agent-sdk`) — Provides `tool()` and `createSdkMcpServer` for defining MCP tools with Zod schemas
- **[Zod](https://zod.dev/)** — Input schema validation for tool parameters
- **[big.js](https://github.com/MikeMcl/big.js/)** — Decimal arithmetic for monetary values (FreshBooks returns amounts as strings to avoid floating-point precision issues)
- **TypeScript** — Strict mode, compiled to ES2022

## Available Tools (75 total)

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

### Self-Documentation
| Tool | Description |
|---|---|
| `freshbooks_help` | Returns embedded docs about the server — architecture, conventions, the live tool inventory, authentication, and how to extend it |

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
npm run refresh-tokens # Refresh the OAuth token if needed
npm run check-tokens   # Audit the token files (no refresh)
npm run lint           # Lint with ESLint
npm run format         # Format with Prettier
npm test               # Run the test suite
```

New to the project? [SETUP.md](SETUP.md) is the end-to-end install walkthrough. Contributing a change or a new tool? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

- **`create_credit_note` and `create_journal_entry` are currently non-functional**, blocked
  by bugs in `@freshbooks/api@4.1.0` (the latest SDK release) that mis-serialize those two
  requests. Listing and reading credit notes and journal-entry data works normally. See
  [CHANGELOG.md](CHANGELOG.md) and `TOOL_AUDIT.md` for the full diagnosis.
- The **bills / bill payments / bill vendors** write tools require the FreshBooks
  Accounts-Payable add-on to be enabled on your account.

Setup problems are covered in the [SETUP.md troubleshooting table](SETUP.md#troubleshooting).

## Using FreshBooks MCP inside a Claude Project

If you use [Claude Projects](https://claude.ai/), you can paste a ready-made system prompt — describing all 75 tools and how Claude should use them — into the project's custom instructions. It lives at [docs/claude-project-system-prompt.md](docs/claude-project-system-prompt.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and how to add a tool, [CHANGELOG.md](CHANGELOG.md) for version history, and [SECURITY.md](SECURITY.md) for the security policy.

## License

[MIT](LICENSE)

## Acknowledgments

- **[FreshBooks](https://www.freshbooks.com/)** — Cloud accounting platform and API
- **[FreshBooks Node.js SDK](https://github.com/freshbooks/freshbooks-nodejs-sdk)** — Official SDK maintained by the FreshBooks team
- **[Anthropic](https://www.anthropic.com/)** — Claude Agent SDK and Model Context Protocol
- **[MCP](https://modelcontextprotocol.io/)** — Open protocol for AI tool integration
