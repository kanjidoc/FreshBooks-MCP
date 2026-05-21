---
name: freshbooks-token-refresh
description: Check and refresh the FreshBooks MCP server's OAuth tokens. Use whenever FreshBooks MCP tools fail with 401 / unauthorized / "error" responses, when the user mentions FreshBooks tokens, auth, login, "expired", or "not working", before heavy FreshBooks tool use after a long idle, or when token drift between config files is suspected. Triggers on phrases like "freshbooks broken", "freshbooks 401", "refresh freshbooks", "check freshbooks tokens", "is freshbooks working". Runs the repo's bundled Node token CLI.
---

# FreshBooks Token Refresh

This skill ships **inside the FreshBooks-MCP repository**, so a fresh `git clone`
has it automatically — no external setup, no Python. It wraps the repo's built-in
token CLI (`scripts/refresh-tokens.ts`).

## What it solves

FreshBooks OAuth uses **rotating refresh tokens**: every refresh mints a new pair
and revokes the old one. Access tokens expire roughly every 12 hours. The MCP
server refreshes automatically — at startup and before every tool call — but you
may still want to refresh or audit tokens on demand.

## How to use it

Run from the repo root:

```bash
npm run refresh-tokens                  # refresh only if needed
npm run refresh-tokens -- --check-only  # audit token files, never refresh
npm run refresh-tokens -- --json        # machine-readable output
```

Read the exit code and the printed report:

- **`HEALTHY`** (exit 0) — tokens current (or refresh succeeded). If a refresh
  succeeded, tell the user to reload their Claude app so the MCP server picks up
  the new token.
- **`REFRESH FAILED`** (exit 1) — the refresh token was rejected (it was used
  elsewhere, or the FreshBooks app was deleted). Recovery: run `npm run setup`
  to re-authorize through the browser OAuth flow.
- **`CONFIG ERROR`** (exit 2) — `.env` is missing. The project was never set up:
  run `npm run setup`.

## When tokens look healthy but FreshBooks tools still fail

The problem is elsewhere — the MCP server may not be running or registered.
Check that the server process is alive and that the MCP entry exists in the
relevant Claude config, then have the user reload their Claude app.

## Notes

- Token persistence is **adaptive**: `.env` is the source of truth; `.mcp.json`
  and the Claude Desktop config are synced only if they exist. A clone on any OS
  refreshes cleanly.
- Don't refresh a healthy token — rotating it for no reason burns a refresh-token
  cycle. When the CLI says `HEALTHY`, trust it.
