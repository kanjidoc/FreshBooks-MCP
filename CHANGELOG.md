# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The Claude Projects system prompt points at the `freshbooks_help` `setup`
  topic and the README kickoff prompt, so a Project-hosted Claude can guide an
  install or reconnect instead of only using the tools.

## [2.3.0] - 2026-08-07

### Added

- **Headless setup surface for agents.** `npx ts-node scripts/setup.ts --headless <verb>` —
  `--init`, `--auth-url`, `--add-login` (staged pendings, resumable branches),
  `--reauth`, `--discard-pending`, `--install`/`--print-config`, and a
  Book-keyed `--doctor`; typed exit codes and token-free JSON envelopes.
- **Agent-path docs, generated from the Book.** SETUP.md's setup steps are now
  generated blocks rendered from `src/setup-flow.ts` (drift-tested
  byte-for-byte); README gains the kickoff prompt; `freshbooks_help` gains a
  `setup` topic.

### Changed

- internal: setup flow extracted into a data-driven core; no behavior change
- **`npm run setup` is rendered from the same data as the guide.** The wizard
  no longer keeps its own copy of the setup instructions: every line it prints
  now comes from `src/setup-flow.ts`, so it cannot describe the setup
  differently from SETUP.md or from what Claude does on the agent path. What
  you will notice: the FreshBooks developer-app step matches the portal as it
  actually reads today (it said *Create an App*; the portal says *Create New
  App*), it names the exact scopes to tick, and it asks you to read the
  redirect URI back to yourself. A running checklist shows what is done, what
  is in flight, and what is still ahead, repeating the per-login steps once per
  login. The wizard no longer opens a browser for you — it prints the sign-in
  link and tells you to open it, because two instructions for one action is one
  too many. Failures print the failing step's own troubleshooting rows rather
  than a stack trace.
- **The guide is honest about the time and the effort.** *What you need before
  you start* now gives a per-rung estimate — 15 minutes if Claude can run the
  commands, up to an hour your first time by hand — instead of a flat "about 15
  minutes" that was only ever true on the first path. A new limitation states
  the floor of roughly 35–40 actions only you can take (permission dialogs, the
  developer-app form, a browser sign-in per login, one full quit-and-reopen),
  even when Claude drives.
- **SETUP.md is now half generated.** One block per setup step is spliced in
  from `src/setup-flow.ts` — the same data the setup program itself runs on — by
  `scripts/generate-setup-docs.ts`, and `test/setup-flow-docs.test.ts`
  re-renders every block to assert byte-equality, so the guide and the program
  can no longer describe the setup differently. Each step now states who
  performs it and carries both variants side by side: what Claude does when it
  can run commands on your computer, and the exact text to type when it cannot.
  The manual Claude Desktop / Claude Code configuration blocks moved into the
  "Connect the server to your Claude" step (they are the fallback path's raw
  material), leaving the appendix scoped to the manual token exchange — gated
  to humans, since that route handles raw tokens by hand.
- **README carries the kickoff prompt**: the text to paste into a fresh chat
  when you want Claude to install the server for you, with the opening heading
  its first reply should quote and the fallback for a Claude that cannot read
  the web.
- **"Could not look up the account details" now tells you where to find the
  Account ID.** The `save-login` troubleshooting row gained a probed (not
  guessed) pointer: open any invoice in FreshBooks and the address bar reads
  `my.freshbooks.com/#/invoice/XXXXXX-123` — the part before the dash is the
  Account ID. The dashboard, the clients list and settings were each checked
  and carry it nowhere, so the guide names only the place it was observed.
- CLAUDE.md documents the setup Book and its three surfaces (the wizard, the
  headless verbs, the guided docs), and the rule that any Book edit is followed
  by `npx ts-node scripts/generate-setup-docs.ts` with the regenerated SETUP.md
  committed alongside it.

### Fixed

- **`check-tokens`/`refresh-tokens` `--json` no longer emits token material.**
  Both `npm run check-tokens -- --json` and `npm run refresh-tokens -- --json`
  serialized the full `TokenHealth` struct, which carried the profile's
  complete access AND refresh tokens — handing both live credentials to any
  agent or script capturing the CLI's output. The human-readable mode also
  printed a token suffix (still a credential fragment). `TokenHealth` now
  carries presence booleans (`hasAccessToken`/`hasRefreshToken`) instead of
  token strings, so no serialization site can emit token material, and a
  regression test (`test/refresh-tokens-redaction.test.ts`) drives every CLI
  output path over canary JWTs asserting no token fragment reaches stdout or
  stderr. The one deliberate exception is unchanged: the loud-failure recovery
  path that prints freshly rotated tokens to stderr when the post-refresh disk
  write fails (CLAUDE.md "Token persistence safety", invariant 4).
- **`npm run setup` no longer writes over other MCP servers in `.mcp.json`.**
  The wizard replaced that file wholesale, deleting any other server entry a
  project had; it now merges, exactly as the headless `--install` already did.
- **`npm run setup`'s install prompts now write an absolute `node`, like
  `--install`.** The wizard's install step passed no command path, so every
  config it wrote launched the bare `"node"` — which starts the server only if
  Claude happens to launch with a PATH that includes node. Worse, it was a
  silent revert: a user who had fixed their configs with the headless
  `--install` (which probes `/opt/homebrew/bin/node`, `/usr/local/bin/node`,
  `/usr/bin/node`) and then re-ran `npm run setup` got the bare command back.
  The wizard now makes the same probe — it always runs in your own Terminal, so
  probing is unconditionally right there — and says so out loud on the rare
  fallback where no absolute node is found.
- **The wizard's checklist no longer un-ticks work you already finished.** A
  cancelled or refused *additional* login re-rendered the already-saved login's
  steps as pending — the "your work did not count" misread, on a screen whose
  whole job is to say what is done.
- **`npm run setup` on a second run no longer claims you have no logins.** Adding
  a login by re-running setup is the documented path, and cancelling the login
  prompt on such a run warned that nothing was configured — while working
  profiles sat on disk. It now names the logins that are saved, and keeps the
  warning for the case where there really are none. In the same stretch, the
  checklist's *you are here* marker stayed on the login steps while the wizard
  is still asking about logins (it jumped ahead to *Build the server*), and a
  migration nickname that is already taken re-prompts for another name instead
  of ending the run.
- **Setup failures always name a step to go back to.** A `--reauth` or
  `--discard-pending` refusal reported an empty step, leaving a driving agent
  with no part of SETUP.md to return to; both now key to *Save the login*.
  Exit 5 ("another saved login already holds this token") named the login to
  reconnect with a literal `<that login's nickname>` placeholder — it now names
  the actual login. A resume that finds nothing under the name you gave no
  longer offers a damaged staged pair as resumable, since no command can resume
  one; it names those separately, with the one command that clears them. That
  listing is now scoped to the verb that asked, too: a pair staged by `--reauth`
  is no longer offered to `--add-login` (or the reverse) as resumable — it is
  named with the verb that can actually resume it, in one step instead of two.
  Passing `--confirm-different-user` without `--distinct-login` was silently
  treated as no confirmation at all; it is now refused by name, like its mirror.
- **The setup doctor.** A lingering rescue file next to the base `.env` was
  dropped from the report whenever `profiles/` could not be read — hiding a
  token pair that may be the only live one. A staged pair whose markers are
  damaged reported `pass` while its only advice was "clear it"; it now warns.
  And durations under a minute no longer render as "expired just now ago".

### Security

- Credential files are written 0600-at-creation; a rescue-file lifecycle
  preserves rotated tokens through failed writes (adopt-newer,
  shred-superseded); token-hygiene tests sweep every headless verb's output
  streams.

## [2.2.0] - 2026-07-29

The Tier 2 release: 76 → 97 tools, opening every safely-verifiable FreshBooks
endpoint the frozen Node SDK never wrapped, through a new never-throw raw
layer with exhaustive pagination, loud integrity guards, and per-response
filter-verification echoes. Every number-producing tool was cross-footed
against the live API on every configured profile before shipping.

### Added

- **Tax writes** (`freshbooks_create_tax`, `freshbooks_update_tax`,
  `freshbooks_delete_tax`) and **estimate writes**
  (`freshbooks_create_estimate`, `freshbooks_update_estimate`,
  `freshbooks_delete_estimate`, `freshbooks_send_estimate`). 90 → 97 tools.
  Contracts transcribed from live go/no-go probes, then re-verified end to
  end through the production tools: creates require the fields the API's
  422s name (`customerid` — not clientid — plus `create_date` for
  estimates); updates are PARTIAL — the API merges, verified by fields
  surviving single-field PUTs; tax delete is HARD (permanent, 404s after),
  estimate delete is SOFT (`vis_state: 1`, restorable). Creating an
  estimate produces a draft and emails nothing; `freshbooks_send_estimate`
  is the only emailing action, requires an explicit `email_recipients`
  list, refuses (without any API call — tested) when it is missing or
  empty, and was verified with exactly one live send to the owner's own
  address. Invoice-profile writes do **not** ship: the Phase 6 gate
  concluded NO-GO (a create probe could auto-invoice a real client; see
  the go/no-go memo).

- **Eight entity read tools** for resources the frozen SDK never wrapped
  (raw snake_case fields; exhaustive listing with no `page` param):
  `freshbooks_list_estimates`/`freshbooks_get_estimate` (quotes; the get
  always passes `include[]=lines` — verified live that the API otherwise
  omits line items), `freshbooks_list_staff`/`freshbooks_get_staff_member`
  (closes a real hole — `freshbooks_create_expense` requires a `staff_id`
  no tool could produce; **the API's `api_token` credential field is
  stripped**, a live token was observed in it), `freshbooks_list_taxes`/
  `freshbooks_get_tax` (tax definitions), and
  `freshbooks_list_invoice_profiles`/`freshbooks_get_invoice_profile`
  (recurring-invoice templates). 82 → 90 tools. Envelope keys probed live
  on every configured profile (collection `staff` not `staffs`; single
  `tax` not `taxes`); bogus IDs verified to return clean 404 errors; empty
  collections are success, never errors. Per the no-guessed-filters
  doctrine, no search filters are offered on any of them.
- Written go/no-go memos for every write domain
  (`docs/superpowers/specs/2026-07-29-tier2-write-go-no-go.md`), each gated
  on a live artifact: **taxes GO** (full CRUD verified; merge-semantics
  PUT; hard DELETE), **estimates GO** (create requires `customerid` +
  `create_date`; merge-semantics PUT — lines survive; soft DELETE
  `vis_state: 1`; nothing emailed on create), **staff NO-GO permanent**
  (`create_staff` emails a real human), **invoice profiles NO-GO** (a
  create probe could auto-invoice a real client; no record exists to verify
  the single-item contract).

- **Six ledger report tools** the frozen FreshBooks Node SDK never wrapped,
  served raw (snake_case API fields) through the new raw-call layer:
  `freshbooks_report_balance_sheet` (point-in-time `as_of_date` + up to 3
  `compare_to` columns — the endpoint ignores start/end dates and the tool
  says so), `freshbooks_report_general_ledger`,
  `freshbooks_report_cash_flow`, `freshbooks_report_accounts_aging`,
  `freshbooks_report_expense_details`, and
  `freshbooks_report_trial_balance`. 76 → 82 tools. Every response echoes
  `params_the_server_actually_parsed` — the decoded `downloadToken.params`
  claim, the API's own record of which filters it honored (the raw JWT
  itself is stripped). A `detail: "summary"` default prunes nested
  `sub_accounts[]` to `sub_accounts_omitted: N` (~10x smaller payloads;
  `detail: "full"` keeps everything). Verified live by cross-footing on
  every configured profile: trial balance, balance sheet, and general
  ledger balance to the cent; cash-flow net change ties to the GL Cash
  movement; accounts-aging ties to the sum of unpaid invoices;
  expense-details ties record-for-record to `freshbooks_list_expenses`.

- `src/raw-call.ts` — the single, tool-free escape hatch for FreshBooks
  endpoints the frozen Node SDK never wrapped. Routes through the SDK's own
  private `call()` (which re-syncs the rotated OAuth token per request),
  resolves the client from the active profile context so callers can never
  cross accounts, and never throws: every failure returns a typed result
  (`api_error` / `envelope_drift` with the raw body echoed / `integrity` /
  `transport`). Exhaustive-pagination listing (`rawList`) computes
  completeness, refuses to return partial data on integrity failures (page
  echo mismatch, zero progress, mid-read errors, end-count mismatch), and
  marks budget stops with a first-key `WARNING_INCOMPLETE`. Not itself a tool
  — raw-backed tools arrive in later phases.
- `freshbooks_help topic=reports` — the report parameter support matrix,
  rendered live from `src/report-params.ts` (`REPORT_PARAMS`): per endpoint,
  the honored params (transcribed from the `downloadToken.params` evidence
  artifact), the proven-ignored params, wire-key mappings, and verification
  date. `test/report-params.test.ts` asserts every report tool's schema stays
  inside its entry.
- Every date-only tool param now carries a `YYYY-MM-DD` regex, which compiles
  into the JSON-Schema `pattern` — malformed dates are rejected client-side
  before any API call (24 params across 10 tool files).
- Test-suite typechecking: `npm run typecheck` (a sibling
  `tsconfig.test.json`), wired into both CI workflows; `npm run lint` now
  covers `test/` too.
- New guard tests: `test/tool-inventory.test.ts` (name uniqueness, the
  action-prefix annotation convention, raw-shape input schemas, the
  account-param boundary, a ban on JSON-Schema-unrepresentable zod types, and
  the raw-tier description marker), `test/doc-inventory.test.ts` (name-level
  doc↔registry sync in both directions), and `test/sdk-contract.test.ts`
  (pins `Client.prototype.call` arity 5 + exact-4.1.0, and enforces exactly
  one `new Client(` and one `.axios` site in `src/`).

- `freshbooks_report_profit_loss` accepts `cash_based` and `fiscal_year_view`;
  `freshbooks_report_tax_summary` accepts `cash_based`. FreshBooks reports default
  to an accrual basis, so cash-basis figures were previously unreachable through
  this server even though the endpoints have always supported them. Verified
  end-to-end against live data: on an account with one invoiced-but-unpaid
  invoice, cash-basis income is lower by exactly that invoice's outstanding
  balance (net of a separate other-income entry), and the two bases reconcile to
  the cent.
- `test/report-params.test.ts` locks in which optional params each report honors,
  and that an unset flag is omitted from the query string rather than sent as
  `false`.

### Fixed

- The staff tools' `api_token` stripping now also covers FAILURE paths: on
  envelope drift (or an API error with no structured detail) the raw body is
  echoed for the bug report, and it previously bypassed the success-path
  strip — a drifted staff response would have echoed live credentials. Both
  staff tools now deep-redact `api_token` (including nested carriers) across
  the entire result before rendering; regression tests pin every echo path.
- `.gitignore` now covers the whole per-pid lock family (`.server.lock*`),
  and a lock file that had slipped into the branch is untracked; a test
  asserts no lock file is ever tracked.
- `writeLock`'s crash-leftover sweep fails closed on a malformed sibling
  lock file (possibly a live server's mid-write) — only parseable, provably
  dead pids are swept.
- The server lock is now one file per pid (`.server.lock.<pid>`). A single
  shared `.server.lock` was last-writer-wins: with N servers running, the first
  to exit deleted the shared file and migration's "is a server running" guard —
  the invariant that prevents rotating a refresh token concurrently with a live
  server — reported no server while N−1 still held tokens. Freshness now scans
  the whole lock family and is true if any live pid holds one; legacy shared
  lock files are honored on read, never written.
- `tsc` no longer emits on type errors (`noEmitOnError`). `dist/` is what the
  installed MCP server runs and is gitignored, so a failing build silently
  replacing a known-good `dist/` could not be rolled back with `git revert`.
- `freshbooks_create_journal_entry`'s schema pointed at a top-level
  `subAccountId` on `freshbooks_list_journal_entry_accounts` results; the field
  exists only nested at `subAccounts[].subAccountId` (the parent level reads
  `undefined`).
- `freshbooks_list_journal_entry_accounts` no longer offers `page`/`per_page`.
  The endpoint ignores both and echoes `per_page = total` (verified live), so
  the params advertised a pagination contract that lied. Its description now
  states the all-in-one-response behavior and disambiguates the tool from
  `freshbooks_list_accounts` (logins) — it is the chart of accounts.
- Nine of twelve `freshbooks_delete_*` descriptions claimed the delete is
  "permanent and cannot be undone"; those nine are soft deletes
  (`PUT vis_state:1`, restorable in the FreshBooks UI). Only
  project/time_entry/other_income deletes are hard, and now say so explicitly.
- `@freshbooks/api` is pinned to exact `4.1.0` (was `^4.1.0`). The SDK froze
  there; the server's raw-endpoint layer depends on internals verified at that
  version.
- `freshbooks_report_payments_collected`'s `currency_code` filter had no effect.
  The endpoint parses the filter as the array param `currency_codes[]`; the
  handler sent the singular `currency_code`, which the API silently ignores —
  returning `ok: true` with unfiltered results and no error. The tool's own
  argument name is unchanged; only the wire key is corrected. (The 2.0.0 audit
  spotted that this filter was declared-but-unread and prescribed wiring it up
  as `currency_code`; that prescription was itself wrong, which turned one
  silent failure into another.)
- `CLAUDE.md` listed `client.taxes` under "Available resources on Client". The
  FreshBooks API has a Taxes resource but the Node SDK has never wrapped one, so
  the row pointed at a method that does not exist. Nothing in `src/` referenced
  it.

### Documentation

- List-tool descriptions no longer open with "Supports pagination, search
  filters, sorting, and includes." — 1.2KB of schema restatement in the
  highest-attention position; the schema itself is authoritative.
- CLAUDE.md gains a **doc-maintenance contract**: the map of every place the
  tool inventory lives, split into test-enforced, derived, and hand-written
  (rot-prone) sites.
- The annotation convention (`create_` tools deliberately carry none;
  prefix-free tools need a test allow-list entry) is documented in CLAUDE.md
  and the `freshbooks_help` conventions topic, matching the new test.
- `TOOL_AUDIT.md` is bannered as an executed historical snapshot, and its §9
  step 5 — which still prescribed the superseded `currency_code` wire key — is
  struck with a pointer to the correction. A fresh session following the doc's
  own "execute Section 9 top-to-bottom" instruction would have re-introduced
  the bug.
- The Claude-project system prompt no longer claims every list tool paginates
  and sorts; it names the exceptions and defers to each tool's schema.
- The error-handling doctrine is scoped by tier at all six sites (`CLAUDE.md`,
  `freshbooks_help` content): SDK-backed tools' errors THROW — the SDK's
  `call()` never returns `ok: false`, so the `response.ok` check is
  defense-in-depth — while raw-backed tools return a real `Result` whose `!ok`
  branch is the only error path.
- `CLAUDE.md` no longer lists "Chart of Accounts" as a never-wrapped resource:
  no such endpoint exists (404, probed live); `journal_entry_accounts` IS the
  chart of accounts. Prevents a duplicate tool.
- Documented how to determine which params a FreshBooks report endpoint actually
  honors: decode the `downloadToken` JWT in any report response and read its
  `params` claim, which echoes the set the server parsed. Unsupported params are
  silently dropped (`ok: true`, no error), so this is the only reliable check —
  and it doubles as a changelog for API options the frozen Node SDK never learned
  to send. Also records that report params serialize flat (`&key=value`) rather
  than `&search[key]=`, and that array params need a literal `[]` suffix.
- Documented four verified traps around journal entries and sub-accounts: custom
  sub-account names are returned as UUIDs with no endpoint exposing the display
  label; the `balance` field on the accounts endpoint is stale and must not be
  used (derive from `journal_entry_details` instead); deriving balances requires
  following pagination to the end, since a single page silently understates
  totals; and `subAccountId`/`accountSubName` are nested at `subAccounts[]`
  rather than on the parent record, where they read `undefined`.
- Recorded that webhooks (`client.callbacks`), online payment options
  (`client.paymentOptions`), and invoice share links are intentional exclusions
  rather than gaps, so tool-coverage audits stop re-proposing them.
- Added `docs/superpowers/specs/2026-07-28-tier2-sdk-unwrapped-endpoints-design.md`
  — the design for exposing FreshBooks endpoints the Node SDK never wrapped
  (estimates, staff, taxes, invoice profiles, and six ledger reports) via a single
  narrow `src/raw-call.ts` layer. Includes a live-probed endpoint truth table
  recording envelope keys and, critically, which params each endpoint accepts and
  silently ignores.

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
