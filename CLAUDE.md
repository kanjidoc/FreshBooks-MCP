# CLAUDE.md — FreshBooks MCP Server

## Project Overview

FreshBooks-MCP is a Model Context Protocol (MCP) server that exposes FreshBooks accounting API functionality as tools for AI assistants. It enables LLMs to interact with FreshBooks data — invoices, clients, expenses, payments, time entries, and more — through the standardized MCP tool interface.

- **License:** MIT
- **Owner:** kanjidoc
- **Language:** TypeScript
- **Runtime:** Node.js
- **Protocol:** MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`

## Repository Status

This repository is in early development. The initial scaffold is being built out. When contributing, follow the conventions below to keep the codebase consistent as it grows.

## Project Structure (Target)

```
FreshBooks-MCP/
├── src/
│   ├── index.ts              # Entry point — MCP server setup and transport
│   ├── tools/                # One file per tool or logical tool group
│   │   ├── invoices.ts       # Invoice CRUD tools
│   │   ├── clients.ts        # Client CRUD tools
│   │   ├── expenses.ts       # Expense tools
│   │   ├── payments.ts       # Payment tools
│   │   ├── time-entries.ts   # Time tracking tools
│   │   └── ...
│   ├── auth.ts               # OAuth2 token management for FreshBooks API
│   ├── api.ts                # HTTP client wrapper for FreshBooks API calls
│   └── types.ts              # Shared TypeScript types and interfaces
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example              # Template for required environment variables
├── README.md
├── CLAUDE.md                 # This file
└── LICENSE
```

## Development Workflow

### Setup

```bash
npm install
cp .env.example .env   # Fill in FreshBooks credentials
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

The server requires FreshBooks API credentials. These should be set in a `.env` file (never committed):

| Variable | Description |
|---|---|
| `FRESHBOOKS_CLIENT_ID` | OAuth2 client ID from FreshBooks Developer Portal |
| `FRESHBOOKS_CLIENT_SECRET` | OAuth2 client secret |
| `FRESHBOOKS_REDIRECT_URI` | OAuth2 redirect URI |
| `FRESHBOOKS_ACCESS_TOKEN` | Access token (after OAuth flow) |
| `FRESHBOOKS_REFRESH_TOKEN` | Refresh token (for automatic renewal) |
| `FRESHBOOKS_ACCOUNT_ID` | FreshBooks account/business ID |

## Key Conventions

### TypeScript

- Use strict TypeScript (`"strict": true` in tsconfig)
- Prefer explicit types over `any` — define interfaces in `src/types.ts` for FreshBooks API shapes
- Use `async/await` for all asynchronous operations
- Export tool definitions as named exports from each tool module

### MCP Tool Design

- Each tool should have a clear, descriptive `name` (e.g., `freshbooks_list_invoices`, `freshbooks_create_client`)
- Prefix all tool names with `freshbooks_` for namespacing
- Provide detailed `description` fields that explain what the tool does, required parameters, and return format
- Use Zod schemas for input validation
- Return structured JSON responses, not raw API payloads — normalize and simplify for LLM consumption
- Handle errors gracefully and return user-friendly error messages

### API Interaction

- All FreshBooks API calls go through a centralized HTTP client (`src/api.ts`)
- Handle token refresh automatically when access tokens expire
- Respect FreshBooks API rate limits
- The FreshBooks API base URL is `https://api.freshbooks.com`
- API responses follow the pattern: `response.result.<resource>`

### Error Handling

- Catch API errors and return descriptive MCP tool error responses
- Do not expose raw API error bodies to the LLM — summarize the issue
- Log errors to stderr for debugging (MCP servers communicate over stdio)

### File Organization

- One tool file per FreshBooks resource domain (invoices, clients, etc.)
- Keep tool registration in `src/index.ts` minimal — import and wire up, logic lives in tool files
- Shared types go in `src/types.ts`; avoid duplicating type definitions

## FreshBooks API Reference

- **API Docs:** https://www.freshbooks.com/api
- **Auth:** OAuth2 with access/refresh tokens
- **Base URL:** `https://api.freshbooks.com`
- **Accounting endpoints:** `/accounting/account/{account_id}/...`
- **Common resources:** invoices, clients, expenses, payments, taxes, items, time_entries, projects

## Git Conventions

- Use descriptive commit messages: `feat: add invoice listing tool`, `fix: handle token refresh on 401`
- Keep commits focused — one logical change per commit
- Do not commit `.env`, `node_modules/`, or `dist/` directories

## Notes for AI Assistants

- Always read existing source files before modifying them
- When adding a new tool, follow the pattern established by existing tool files
- Run `npm run build` after changes to verify TypeScript compiles cleanly
- Do not add dependencies without justification — keep the dependency tree lean
- When in doubt about FreshBooks API behavior, check the official docs rather than guessing
