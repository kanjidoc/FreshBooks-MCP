# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.2] - 2026-05-23

### Security

- Bump transitive `qs` dependency from 6.15.1 to 6.15.2 to clear
  GHSA-q8mj-m7cp-5q26 (a remotely triggerable DoS in `qs.stringify` with
  comma-formatted arrays and `encodeValuesOnly`). The advisory was disclosed
  after 2.1.1 was cut. The affected code path lives in
  `@modelcontextprotocol/sdk`'s optional Express-based HTTP transport, which
  this server does not use (stdio only) — runtime exposure was effectively
  zero — but `npm audit` is now clean. Lockfile-only change; no API surface
  or behavior changes.

## [2.1.1] - 2026-05-22

### Added

- `freshbooks_help` gains a `version` topic — it reports the installed version
  and the live tool count, directs the assistant to check GitHub for a newer
  release, and explains how to update (covering both git-clone and ZIP installs).
- Automated GitHub releases: `.github/workflows/release.yml` tags `vX.Y.Z` and
  publishes a release whenever `package.json`'s version changes on `main`, with
  notes extracted from this changelog by `scripts/extract-changelog.mjs`.

### Changed

- `package.json` is the single source of truth for the version. `src/version.ts`
  is the one module that reads it; `src/server.ts` and `freshbooks_help` derive
  the version from it, and the `overview` help topic derives the tool count from
  the registry instead of a hardcoded number.

### Fixed

- Regression tests guard against version and tool-count drift
  (`test/version.test.ts`, `test/doc-tool-count.test.ts`).

## [2.1.0] - 2026-05-21

### Fixed

- **The MCP stdio stream is no longer polluted by a dotenv banner.** dotenv v17
  prints an `injected env (N) from .env` banner to stdout on every successful
  load. Because the server speaks the MCP JSON-RPC protocol over stdout, that
  banner was a non-JSON line injected into the protocol stream — tolerated by
  lenient clients but a latent corruption bug, and it also broke the `--json`
  output mode of `npm run check-tokens` / `refresh-tokens`. `src/load-env.ts`
  now passes `quiet: true`, and a regression test (`test/load-env.test.ts`)
  guards the flag.
- **`@modelcontextprotocol/sdk` is now a declared dependency.** `src/index.ts`
  imports `@modelcontextprotocol/sdk/server/stdio.js` directly, but the package
  was only present transitively (via `@anthropic-ai/claude-agent-sdk`). The
  build worked solely because npm flattens `node_modules` — a "phantom
  dependency" that would break under a strict package manager (pnpm, Yarn PnP)
  or if the Agent SDK changed its dependency tree. It is now listed explicitly.
- The MCP server version reported in the `initialize` handshake was hardcoded
  to `2.0.0` and had silently drifted from the package version. `src/server.ts`
  now derives it from `package.json`, so the two can never diverge again.

### Security

- Resolved all 8 advisories reported by `npm audit` (2 high, 6 moderate) by
  updating transitively-pinned dependencies to patched releases. No declared
  dependency range changed; `npm audit` now reports zero vulnerabilities.

## [2.0.4] - 2026-05-21

### Fixed

- Token staleness on the Claude Code user-scope install. The 2.0.3 wizard
  embedded credentials into `~/.claude.json` via `claude mcp add-json`, but that
  file was never updated when FreshBooks rotated the refresh token — so the
  integration broke within a day or two. The root cause was a rotating secret
  duplicated across multiple launcher configs (see *Changed* below).
- `setup.ts` opened the OAuth browser through a shell command; on Windows the
  quoted URL was read as a window title and the browser never launched. It now
  spawns the browser without a shell, which behaves correctly on every platform.
- One mistyped or expired authorization code aborted the whole setup wizard. The
  token exchange now re-prompts instead of exiting.

### Changed

- **Tokens now live in exactly one file — `.env`.** The server loads `.env` by
  absolute path with `override: true` (`src/load-env.ts`), making it the single
  source of truth. MCP launcher configs (`.mcp.json`, the Claude Desktop config,
  `~/.claude.json`) carry only the command to start the server — no credentials.
  The multi-file token-sync machinery (`discoverTokenFiles`, multi-file preflight
  and persistence) is deleted: with one home for the secret there is nothing to
  keep in sync and nothing that can drift.
- Corrected the documented Claude Code configuration target throughout — MCP
  servers belong in `~/.claude.json` or a project `.mcp.json`, never in an
  `mcpServers` block in `~/.claude/settings.json`.

## [2.0.3] - 2026-05-21

### Added

- The setup wizard (`npm run setup`) now offers to install the server into
  **Claude Code**, not just Claude Desktop. When the `claude` CLI is present it
  registers the server at user scope via `claude mcp add-json`, so FreshBooks is
  available in every Claude Code project. Re-running setup is idempotent.

### Fixed

- Corrected the Claude Code configuration guidance. MCP servers belong in
  `~/.claude.json` (user scope) or a project `.mcp.json` — not in an `mcpServers`
  block in `~/.claude/settings.json`, which the wizard's printed fallback and
  `SETUP.md` had previously instructed. That wrong path would silently fail to
  register the server.

### Changed

- Extracted the MCP server-config builders into `src/mcp-config.ts`, now covered
  by unit tests.

## [2.0.2] - 2026-05-21

### Changed

- Onboarding overhaul. Added `SETUP.md` — a single, beginner-grade setup
  walkthrough that doubles as a script Claude can follow to install the server
  for a non-technical user. It covers both Claude Desktop and Claude Code, opens
  with a "which Claude do you have?" fork, and explicitly marks the steps Claude
  cannot do itself (the browser login, the interactive setup wizard).
- `README.md` is now a concise landing page that points to `SETUP.md`, rather
  than carrying its own (separately drifting) copy of the setup instructions.
- Retired `CLAUDE_PROJECT_INSTRUCTIONS.md` — it was a second copy of the setup
  instructions that had already drifted from the README. Its setup content is
  consolidated into `SETUP.md`; its claude.ai Projects system prompt moved to
  `docs/claude-project-system-prompt.md`.

## [2.0.1] - 2026-05-21

### Fixed

- `update_time_entry` no longer drops a time entry's associations. The FreshBooks
  timetracking `PUT` is a full replace, and the SDK's `transformTimeEntryRequest`
  serializes every field unconditionally — so a partial update reset
  `client_id` / `project_id` / `task_id` / `service_id` to `null`, silently
  losing the entry's links. (The 2.0.0 fix had rescued only `started_at`.) The
  handler now fetches the existing entry and sends it back complete, overriding
  only the caller's changes.
- `create_bill` line items now reach the API. The SDK's
  `transformBillLinesParsedRequest` reads only `unitCost` and `categoryId` per
  line, so the previous `amount` / `category` line fields were silently dropped —
  leaving every line with no value and no category. The `lines` schema now takes
  `unit_cost` (a Money object) and `category_id` (verified against the SDK
  source; not live-testable without the Accounts-Payable add-on).
- `create_other_income` and `update_other_income` now constrain `category_name`
  to the five values the FreshBooks API accepts — `advertising`,
  `in_person_sales`, `online_sales`, `rentals`, `other` — as a `z.enum`. The old
  free-text schema even gave `Other Income` as its example, a value the API
  rejects.

### Changed

- `create_service` no longer exposes a `billable` parameter. The SDK's
  `transformServiceRequest` serializes only the service name, so a `billable`
  flag passed on creation was silently ignored; services are always created
  billable. The tool description and `freshbooks_help` now state this.
- `delete_other_income` returns a human-readable confirmation
  (`Other income <id> deleted.`) instead of an empty `{}` body.

## [2.0.0] - 2026-05-21

### Fixed

- Repaired 11 of the 13 broken tools surfaced by a full audit (see `TOOL_AUDIT.md`). The four
  root causes were: an SDK method-signature mismatch (`create_item`), wrong property
  names handed to SDK models (credit notes, bill payments, bill vendors, journal
  entries), updates that didn't survive the SDK's request transform (`update_time_entry`,
  `update_other_income`, `update_project`), and reports using the wrong query mechanism.
- The three report tools (`report_payments_collected`, `report_profit_loss`,
  `report_tax_summary`) now honor the date range passed to them — previously they
  silently returned data for the current day only, with no error.
- `create_journal_entry` was reworked to build the single `details[]` array the SDK
  expects and to validate that credits and debits balance before the API call (the tool
  still cannot complete a create — see Known limitations).

### Changed

- Removed unsafe `as any` casts from create/update handlers. Payloads are now typed
  against the SDK model interfaces, so a wrong property name is a compile error
  instead of a silently dropped field.

### Added

- Bundled standalone-safe OAuth token refresh into the repo, replacing the external
  Python skill: adaptive token-file resolution so it works on any OS, a single-flight
  guard to prevent concurrent refreshes, proactive refresh before token expiry, and a
  `npm run refresh-tokens` CLI.
- `freshbooks_help`, a self-documenting MCP tool that describes the server, its tools,
  and how to extend it — bringing the total to 75 tools.

### Known limitations

- **`create_credit_note` and `create_journal_entry` are non-functional**, blocked by bugs
  in `@freshbooks/api@4.1.0` — the latest SDK release. The SDK's request transforms for
  these two resources serialize the body incorrectly (a wrong wrapper key for credit
  notes; missing API-required fields for journal entries), and no newer SDK version is
  available. The tool-side code is correct — the defect is upstream. The list/get tools
  for credit notes and journal entries work normally. To be revisited when `@freshbooks/api`
  ships a fix; full diagnosis in `TOOL_AUDIT.md`.
- The **`bills` / `bill_payments` / `bill_vendors`** write tools require the FreshBooks
  Accounts-Payable add-on on your account; without it the API returns an access error.

## [1.0.0]

Initial release: an MCP server exposing 74 FreshBooks accounting tools (invoices,
clients, expenses, payments, bills, projects, time entries, reports, and more) to
AI assistants, built on the official FreshBooks Node.js SDK and the Claude Agent SDK.
