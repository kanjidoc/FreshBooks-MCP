---
name: freshbooks-token-refresh
description: Check and refresh the FreshBooks MCP server's per-profile OAuth tokens (one profiles/<name>.env per configured FreshBooks login/account). Use whenever FreshBooks MCP tools fail with 401 / unauthorized / "error" responses, when the user mentions FreshBooks tokens, auth, login, "expired", or "not working" — including for a specific account/profile — or before heavy FreshBooks tool use after a long idle. Triggers on phrases like "freshbooks broken", "freshbooks 401", "refresh freshbooks", "refresh the acme account", "check freshbooks tokens", "is freshbooks working". Runs the repo's bundled Node token CLI, which iterates every profile.
---

# FreshBooks Token Refresh

This skill ships **inside the FreshBooks-MCP repository**, so a fresh `git clone`
has it automatically — no external setup, no Python. It wraps the repo's built-in
token CLI (`scripts/refresh-tokens.ts`).

## What it solves

FreshBooks OAuth uses **rotating refresh tokens**: every refresh mints a new pair
and revokes the old one. Access tokens expire roughly every 12 hours. This server
can hold **several logins** — one `profiles/<name>.env` per FreshBooks account.
The MCP server refreshes each automatically — at startup and before every tool
call — but you may still want to refresh or audit a profile on demand.

## How to use it

Run from the repo root. The CLI iterates **every** configured profile:

```bash
npm run refresh-tokens                       # refresh every profile that needs it
npm run refresh-tokens -- --check-only       # audit every profile, never refresh
npm run refresh-tokens -- --profile acme     # restrict to one login (case-insensitive)
npm run refresh-tokens -- --json             # machine-readable, one object per profile
```

The report prints one line per profile, tagged with its name, e.g.
`[acme] healthy` or `[beta] REFRESH FAILED: ...`. Read the **exit code**:

- **exit 0** — every profile is current or was refreshed. If anything was
  refreshed, tell the user to reload their Claude app so the MCP server picks up
  the new token.
- **exit 1** — at least one profile's refresh failed, or (under `--check-only`) a
  profile is unhealthy. The failing line names the profile. Recovery for a
  rejected refresh token (used elsewhere, or the FreshBooks app deleted): run
  `npm run setup` to re-authorize that login through the browser OAuth flow.
- **exit 2** — config error: **no profiles configured** (the project was never set
  up — run `npm run setup`), or `--profile <name>` named a profile that doesn't
  exist, or bad arguments.

To act on a single account the user named, pass `--profile <name>`. Get the valid
names from `freshbooks_list_accounts` (or the filenames in `profiles/`).

## When tokens look healthy but FreshBooks tools still fail

The problem is elsewhere — the MCP server may not be running or registered.
Check that the server process is alive and that the MCP entry exists in the
relevant Claude config, then have the user reload their Claude app.

## Notes

- Tokens live in **`profiles/<name>.env`** — one file per FreshBooks login. The
  base `.env` holds only the shared OAuth app credentials plus `FRESHBOOKS_MIGRATED=1`,
  never a token. The server loads these by absolute path and writes each rotated
  pair back to that profile's own file; the MCP launcher configs hold no tokens,
  so there is nothing that can drift.
- Don't refresh a healthy token — rotating it for no reason burns a refresh-token
  cycle. When a profile's line says `healthy`, trust it.
- A profile marked `quarantined` (it shares an account id with another login but
  carries a possibly-superseded token) is skipped by the bulk refresh on purpose —
  rotating it could lock out the whole token family. Refresh it explicitly with
  `--profile <name>` only if it is a genuinely distinct login.
