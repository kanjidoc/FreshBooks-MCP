# Multi-Account Support via Named Profiles — Design

**Date:** 2026-06-30
**Status:** Approved design, pending implementation plan
**Author:** brainstorming session (kanjidoc)

## Problem

The server today serves exactly one FreshBooks login. All credentials live in a
single `.env`: the OAuth app creds (`CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI`),
one access/refresh token pair, and one `FRESHBOOKS_ACCOUNT_ID` /
`FRESHBOOKS_BUSINESS_ID`. Every tool reads those single values via the zero-arg
globals `getFreshBooksClient()`, `getAccountId()`, `getBusinessId()`
(`src/freshbooks-client.ts:273-309`).

The owner now has **3–4 separate FreshBooks logins** (distinct email/password
accounts — e.g. their own business plus client/entity logins they were granted
access to). These are *not* business memberships under one login, so each has its
**own** access/refresh token pair. The single-`.env` model cannot represent them.

## Goals

- Use 3–4 (growable) separate FreshBooks logins through one MCP server.
- Pick the target login **explicitly per request** — no mutable "active account"
  state that could drift and cause a write to the wrong company.
- Preserve every existing token-safety invariant (preflight, atomic write,
  `.bak`, post-write verify, single-flight, loud failure) — per login.
- Keep the public/shareable single-login experience working unchanged.
- Concentrate the change; leave the 17 resource tool files untouched.

## Non-Goals

- A mutable "switch and it sticks" active profile. (Explicitly rejected in favor
  of per-call selection.)
- Running one server instance per login (rejected: 225–300 tools in context).
- Multi-login support for the OAuth *app* itself — `CLIENT_ID`/`CLIENT_SECRET`/
  `REDIRECT_URI` are shared across all logins (one developer app authorizes many
  FreshBooks users).
- Any change to FreshBooks SDK call shapes inside the resource tools.

## Key Decisions

| Decision | Choice |
|---|---|
| Topology | One server, N **profiles** (one per login) |
| Selection | Explicit `account` parameter on every API tool |
| `account` requiredness | Optional in schema; **enforced when ≥2 profiles** configured. A lone-profile install may omit it. |
| Resolution mechanism | Central schema injection + `AsyncLocalStorage` (Option A) — resource tool files untouched |
| Profile storage | `profiles/<name>.env`, one dotenv file per login; name = filename stem |
| Existing `.env` | **Migrated** into `profiles/<name>.env`; base `.env` keeps only shared app creds |

## Current State (what changes, what doesn't)

**Changes (concentrated):**
- `src/freshbooks-client.ts` — singleton client + `process.env`-based token logic
  becomes per-profile.
- `src/tools/with-refresh.ts` — the central wrapper gains schema injection +
  per-call profile resolution.
- `src/profiles.ts` — **new** registry + async context.
- `src/tools/accounts.ts` — **new** `freshbooks_list_accounts` tool.
- `src/tool-registry.ts` — register the new tool; exempt account-free tools.
- `scripts/setup.ts`, `scripts/refresh-tokens.ts` — multi-profile.
- `src/load-env.ts` — still loads base `.env` (app creds only).
- docs, `.gitignore`, `.env.example`, tests.

**Unchanged:**
- All 17 resource tool files (`invoices.ts`, `clients.ts`, … `reports.ts`).
  Their handlers keep calling the zero-arg `getFreshBooksClient()` /
  `getAccountId()` / `getBusinessId()`; those now resolve the per-call profile
  from async context.
- `src/server.ts`, `src/query-helpers.ts`, `src/date-helpers.ts`, `src/version.ts`.

This is feasible because `SdkMcpToolDefinition` exposes `inputSchema` as a plain
mutable property (the raw Zod shape) and `withTokenRefresh` already wraps every
tool. The wrapper can therefore both extend the schema and intercept args
centrally.

## Architecture

### Profile store — `profiles/<name>.env`

```
FreshBooks-MCP/
├── .env                      # SHARED app creds only: CLIENT_ID, CLIENT_SECRET, REDIRECT_URI
│                             # (+ optional FRESHBOOKS_DEFAULT_PROFILE for lone-profile convenience)
├── profiles/                 # gitignored — one file per login
│   ├── acme.env              # ACCESS_TOKEN, REFRESH_TOKEN, ACCOUNT_ID, BUSINESS_ID
│   ├── beta.env
│   └── gamma.env
```

Each `profiles/*.env` has the same four token/ID markers the old `.env` carried.
The profile **name** is the filename stem. This deliberately reuses the existing
file-based token machinery so the atomic-write/preflight/`.bak`/verify/loud-
failure guarantees apply per profile with no reinvention.

Profiles are parsed **in-memory** with `dotenv.parse()` — never loaded into
`process.env`, because all profiles share the same variable names and would
collide. `process.env` continues to hold only the shared app creds (loaded by
`src/load-env.ts` from base `.env`).

### `src/profiles.ts` (new) — registry + async context

Responsibilities:
- **Discovery:** on first use, scan `profiles/` for `*.env`; build
  `Map<name, ProfileState>`.
- **ProfileState:** `{ name, filePath, config: {accessToken, refreshToken,
  accountId, businessId}, client: Client | null, refreshInFlight: Promise<void> | null }`.
- **Resolution:** `resolveProfile(name): ProfileState` — throws a typed
  `UnknownProfileError` (carrying the list of valid names) if not found.
- **Context:** an `AsyncLocalStorage<{ profile: ProfileState }>`. Helpers:
  - `runInProfile(name, fn)` — `als.run({ profile: resolveProfile(name) }, fn)`.
  - `currentProfile(): ProfileState` — reads ALS; throws if called outside a
    profile context (a programming error, surfaced loudly).
- **Counts:** `profileNames(): string[]`, `profileCount(): number` — used by the
  wrapper to enforce "required when ≥2".
- **Default:** `defaultProfileName(): string | null` — the lone profile's name,
  or `FRESHBOOKS_DEFAULT_PROFILE` if set.

ProfileState mutability is confined to lazy `client` construction and the
per-profile `refreshInFlight` single-flight handle; the resolved config tokens
are updated in place after a successful refresh.

### `src/freshbooks-client.ts` — generalized per-profile

- `getFreshBooksClient()` → builds/caches the `Client` for `currentProfile()`
  from shared app creds + that profile's tokens. The module-level `fbClient`
  singleton is removed; the client is cached on the `ProfileState`.
- `getAccountId(): string` / `getBusinessId(): number` → read
  `currentProfile().config`. Same throw-if-missing behavior, scoped to the
  resolved profile.
- Token refresh becomes per-profile and operates on a `ProfileState`:
  - `refreshIfNeeded(profile)` — JWT-expiry check against the profile's in-memory
    access token (not `process.env`).
  - `refreshAndPersist(profile)` — single-flight **per profile**
    (`profile.refreshInFlight`), so two profiles can refresh concurrently while a
    single profile never double-rotates.
  - `preflightEnvFile(profile.filePath)` / `persistTokens(profile.filePath, …)` —
    the existing atomic write + `.bak` + post-write verify + loud-failure logic,
    parameterized by the profile's file path. On success it updates
    `profile.config` and `profile.client.accessToken/refreshToken` (no
    `process.env` mutation).
- `inspectTokenHealth(profile)` → per-profile health for the
  `freshbooks_list_accounts` tool and the `check-tokens` CLI.
- `ensureFreshToken()` (startup) → iterate all profiles, refresh-if-needed each.

### `src/tools/with-refresh.ts` — the central hinge

The wrapper does three things, in order, for every API tool:

1. **Schema injection (build time):**
   ```ts
   inputSchema: { ...toolDef.inputSchema, account: accountField }
   ```
   `accountField = z.string().optional().describe("Which configured FreshBooks
   login to act on (see freshbooks_list_accounts). Required when more than one
   account is configured.")`.

2. **Resolution + validation (call time):** read `args.account`.
   - If omitted and `profileCount() >= 2` → return `isError` text:
     `"This server has multiple FreshBooks accounts configured (acme, beta,
     gamma). Pass account=<name> to choose one."` — **never throw**.
   - If omitted and exactly one profile → use `defaultProfileName()`.
   - If present but unknown → return `isError` listing valid names.
   - Strip `account` from args before calling the handler (handlers don't declare
     it).

3. **Refresh + run:** `runInProfile(name, async () => { await
   refreshIfNeeded(profile); return originalHandler(strippedArgs, extra); })`.
   Refresh failures are swallowed and logged exactly as today — the handler still
   runs and surfaces the real 401 if the token is truly dead.

Tools that make **no** FreshBooks API call (`freshbooks_help`, and the new
`freshbooks_list_accounts`, which resolves profiles itself) are wrapped without
account injection/resolution. Mechanism: a small `withoutAccount` set, or a
second wrapper variant, applied in `tool-registry.ts`.

### `src/tools/accounts.ts` (new) — `freshbooks_list_accounts`

- Read-only (`readOnlyHint: true`), **no** `account` parameter.
- Returns, per configured profile: name, `accountId`, `businessId`, company/
  business name (from a cached `users.me()` lookup per profile), and token health
  (`expirySeconds`, `expired`, `needsRefresh`).
- This is the discovery surface: how the user/Claude learn the valid `account`
  values. Its description tells callers to run it first when unsure.

## Data Flow (a single tool call)

```
Claude calls mcp__freshbooks__freshbooks_list_invoices { account: "acme", page: 1 }
        │
        ▼
withTokenRefresh wrapper
  ├─ read args.account = "acme"
  ├─ resolveProfile("acme")  ──► UnknownProfileError? → isError(list names)
  ├─ refreshIfNeeded(acme)   ──► per-profile single-flight; writes profiles/acme.env if rotated
  └─ runInProfile("acme", () => originalHandler({ page: 1 }))
            │  (AsyncLocalStorage active)
            ▼
      listInvoices handler (UNCHANGED)
        ├─ getFreshBooksClient()  → currentProfile()=acme → acme's Client
        └─ getAccountId()         → acme's accountId
            │
            ▼
      FreshBooks SDK → response → JSON text result
```

Two read-only tools targeting different profiles can run in parallel; each gets
its own ALS context and its own profile client. No shared mutable selection.

## Error Handling

- Tool handlers still **never throw** (unchanged contract).
- The wrapper converts resolution problems (`account` missing-when-required,
  unknown name) into `isError` results with actionable text listing valid names.
- A profile file missing token markers → loud, **profile-scoped** failure
  (existing preflight refusal, now naming which profile).
- `currentProfile()` called outside a context is a programming error → throws at
  startup/dev time, not in production tool calls (the wrapper always establishes
  context first).

## Token Refresh Isolation

- Single-flight is **per profile** (`ProfileState.refreshInFlight`). Concurrent
  calls to the same profile share one refresh; different profiles refresh
  independently.
- Write-back targets that profile's own file atomically; a failed write prints
  the new tokens to stderr tagged with the profile name.
- Startup `ensureFreshToken()` refreshes each profile that is near expiry.

## Setup & Migration

`npm run setup`:
- **Migration (one-time):** detect a legacy `.env` containing tokens + IDs;
  prompt for a profile name; move `ACCESS_TOKEN`/`REFRESH_TOKEN`/`ACCOUNT_ID`/
  `BUSINESS_ID` into `profiles/<name>.env`; rewrite base `.env` to keep only the
  shared app creds. Idempotent (skips if already migrated).
- **Add a login:** run the OAuth flow with the shared app creds, call
  `users.me()`, and when `businessMemberships.length > 1` let the user pick which
  business this profile maps to (fixing the current "take `[0]`" limitation at
  `scripts/setup.ts:287-293`); write `profiles/<name>.env`.
- **Loop:** offer to add another login.

`npm run refresh-tokens` / `npm run check-tokens`:
- Iterate all profiles. `--check-only` prints each profile's expiry; the default
  refreshes each profile that needs it. Optional `--profile <name>` to target one.

## Security

- `profiles/` (and `profiles/*.env`, `*.env.bak`, `*.env.tmp`) added to
  `.gitignore`. Verify nothing under `profiles/` is ever tracked.
- Base `.env` no longer holds tokens — only the shared app creds — but stays
  gitignored regardless.
- `.env.example` documents the split: app creds in `.env`, per-login token files
  in `profiles/` created by `npm run setup`.

## Testing

- **profiles.ts:** discovery of `profiles/*.env`; name derivation; in-memory parse
  (no `process.env` mutation); `resolveProfile` unknown → typed error; default
  resolution for lone profile.
- **with-refresh:** schema gains `account`; missing-account-with-≥2-profiles →
  `isError` listing names; unknown name → `isError`; lone-profile omission →
  resolves default; `account` stripped before handler; ALS context established.
- **freshbooks-client (per-profile):** two profiles refresh independently;
  single-flight per profile; write-back hits the correct file; post-write verify;
  loud failure path names the profile.
- **accounts tool:** lists all profiles with health; no `account` param required.
- **doc-tool-count:** tool total 75 → 76; update the watched files
  (`test/doc-tool-count.test.ts` set) so the test passes.
- Existing tests (`load-env`, token health) updated for the app-creds-only `.env`.

## Documentation Updates

- `README.md`, `SETUP.md` — the profiles model, adding/listing logins, the
  `account` parameter, migration step.
- `freshbooks_help` content (`src/docs/content.ts`) — multi-account architecture
  and conventions; `render-tools.ts` picks up the new tool automatically.
- `CLAUDE.md` — env-var table split (app creds vs per-profile), the `account`
  convention, the new tool, updated tool count, token-persistence section
  rewritten for per-profile stores.
- `docs/claude-project-system-prompt.md` — note the `account` parameter and tool
  count if it states a total.

## Build Sequence (for the implementation plan)

1. `src/profiles.ts` — registry + ALS (pure, unit-tested in isolation).
2. `src/freshbooks-client.ts` — per-profile client + refresh; helpers read ALS.
3. `src/tools/with-refresh.ts` — schema injection + resolution + per-profile
   refresh; account-free variant for help/list_accounts.
4. `src/tools/accounts.ts` + register in `src/tool-registry.ts`.
5. `scripts/setup.ts` migration + add-login; `scripts/refresh-tokens.ts`
   multi-profile.
6. `.gitignore`, `.env.example`.
7. Docs + doc-tool-count file updates.
8. Tests throughout; `npm run build` + `npm test` green.

## Audit-Driven Amendments (binding — supersede the sections above)

A 38-agent adversarial audit (2026-06-30) verified this design against the real
codebase. **The core approach is validated** — `tool()` does not eagerly compile
the zod shape, so wrapper-time `inputSchema` injection IS exposed to MCP clients,
and an `AsyncLocalStorage` value set around the awaited handler IS visible inside
it (both proven via a real `listTools()`/`callTool()` round-trip on
`@anthropic-ai/claude-agent-sdk@0.2.141`). All 74 API handlers read the IDs
synchronously at the top of their bodies, so ALS covers the whole surface; the
exempt set (`help`, `list_accounts`) is exactly right. The feared shared
`.tmp`/`.bak` collision is NOT real as long as `writeAtomic` keeps deriving those
names from its path argument.

The following amendments are **required before implementation** and override the
corresponding sections above where they conflict.

### A1 — Single Client per profile (HIGH; correctness)
There must be exactly one `getOrCreateClient(profile: ProfileState)` that BOTH
the refresh path and `getFreshBooksClient()` call; a `Client` is constructed
nowhere else. The SDK `Client` mutates its own `accessToken`/`refreshToken`
(`@freshbooks/api/.../APIClient.js:515-516`), so two `Client` objects for one
profile diverge: a refresh rotates token state on one while the handler keeps the
other holding the now-revoked refresh token → permanent lockout. `profile.client`
identity must be stable across refresh and handler within a call. Note the
ordering bug this fixes: the wrapper refreshes *before* the handler, but
`profile.client` is built lazily *inside* the handler — so `persistTokens`
updating `profile.client.*` would dereference null on first refresh. Refresh must
go through `getOrCreateClient(profile)`, not a lazily-null field.

### A2 — Migration is the highest-risk operation; make it transactional (CRITICAL + HIGH)
- **Atomic ordering (CRITICAL):** `mkdir profiles/` and verify → write
  `profiles/<name>.env` via the existing atomic tmp+rename+post-write-verify path
  and re-read to confirm → **only then** strip the token lines from base `.env`
  (also atomically). Never strip first; never write the profile file
  non-atomically. An interrupt at any point must leave at least one usable copy
  of the (un-rotated) refresh token.
- **Quiesce (HIGH):** the running server is itself a writer of `.env`. Migration
  must require the server stopped (detect a lock file / instruct quiesce) and
  re-read the freshest token pair from `.env` immediately before the move. A
  concurrent rotation otherwise copies a just-revoked token into the profile.
- **Durable idempotency marker (HIGH):** do not infer "already migrated" from the
  presence of tokens in `.env` (that is identical to the partial-failure
  residue). Write an explicit marker (e.g. `FRESHBOOKS_MIGRATED=1` /
  `FRESHBOOKS_DEFAULT_PROFILE`) as the last step and key the skip on it. Refuse to
  overwrite an existing profile file, and never overwrite a profile whose on-disk
  token is newer than the source.
- **Build/dist order (HIGH):** the launcher runs compiled `dist/`, but migration
  runs from `ts-node` source. Setup must print and enforce: stop client →
  `npm run build` → migrate → restart. A1-style version/capability check should
  refuse migration unless the new code is what will run.
- **Backup secrecy (HIGH):** any pre-migration backup of the token-bearing
  `.env` must use an already-ignored name (`.bak`/`.tmp`) or live inside the
  ignored `profiles/` dir; shred it after the profile file verifies.

### A3 — Backward compatibility: implicit legacy profile + never-throw (HIGH)
- When `profiles/` is empty but base `.env` still carries tokens+IDs (an
  un-migrated in-place upgrade, or a stale `dist/` reading a stripped `.env`),
  the server must **auto-adopt the legacy base `.env` as an implicit default
  profile** so existing single-login installs keep working unchanged. This single
  fix also neutralizes the dist-skew outage in A2.
- The wrapper must wrap the **entire** account-resolution + `runInProfile`
  invocation in try/catch and return `isError` on any thrown resolution error
  (unknown name, zero profiles, bad `FRESHBOOKS_DEFAULT_PROFILE`). Today only
  `refreshIfNeeded` is guarded and the handler call is unguarded — a resolution
  throw from the wrapper level would escape the per-tool try/catch and kill the
  agent loop. Resolve+validate the name in step 2 (before `runInProfile`).

### A4 — Do not gate startup on N refreshes (HIGH)
`ensureFreshToken()` is awaited before `transport.connect()`. Iterating N
profiles serially can exceed the MCP client's init timeout (one slow/hung/
rate-limited refresh fails the whole server and removes all ~76 tools); a naive
`Promise.all` instead bursts N concurrent OAuth POSTs into rate limits. Connect
first, then refresh profiles in the background with a per-profile try/catch (lazy
pre-call refresh already covers correctness), or cap startup with a hard
per-profile timeout well under the init budget. Sequential, isolated, non-blocking.

### A5 — Discovery must validate, not just glob (MEDIUM)
`profileCount()` gates the "account required when ≥2" rule, so a leftover/corrupt
`*.env` (an empty stub, `acme copy.env`, an editor backup) silently flips a
healthy single-profile server into account-required mode and advertises a dead
profile. Discovery must validate each candidate (all four markers present +
parses) before admitting it to the registry/count; malformed files are logged and
excluded (or surfaced by `list_accounts` as "broken"), never counted.

### A6 — Profile-name normalization is required, not an open question (MEDIUM)
The owner's macOS filesystem (APFS) is case-insensitive: `Acme.env` and
`acme.env` are the **same file**, so adding both silently clobbers one login's
tokens → lockout. Enforce one normalization (lowercase stems + restricted
charset) at **write time** (reject/normalize, detect case-insensitive collision
before writing) and **resolution time** (case-insensitive lookup).

### A7 — Detect duplicate logins across profiles (MEDIUM)
Two profile files carrying the same refresh token (a copied file, or the same
login added twice) guarantee that one gets permanently locked out on the other's
next rotation. Setup and registry discovery must detect duplicate refresh tokens
/ duplicate `accountId` and refuse or warn loudly.

### A8 — Per-profile maintenance entry points + bundled skill (MEDIUM)
`refreshTokensNow()`, `ensureFreshToken()`, and `inspectTokenHealth()` are the
real callers behind the `refresh-tokens`/`check-tokens` CLIs and the bundled
`freshbooks-token-refresh` skill, and they currently bind to base `.env` via the
zero-arg, ALS-less path. After this change they would crash (calling the
ALS-backed `getFreshBooksClient()` with no context) or misreport "no tokens"
(inspecting the stripped base `.env`) — triggered by the exact per-profile 401
symptom this design creates. Rewrite them to take an explicit `ProfileState` /
iterate the registry, and update/version-gate the bundled skill to target
`profiles/` and a named profile. (`scripts/refresh-tokens.ts`,
`scripts/setup.ts`, the `freshbooks-token-refresh` skill.)

### A9 — `list_accounts` acquires clients explicitly (MEDIUM)
`freshbooks_list_accounts` is wrapped account-free (no ALS context) yet must build
a per-profile `Client` and refresh to fetch `users.me()`/health. It must iterate
the registry and call `getOrCreateClient(profile)` directly — never the ALS-backed
`getFreshBooksClient()`.

### A10 — JWT read source + process.env backstop (LOW/MEDIUM)
- `profile.config.accessToken` must be the single authoritative read/write target
  and must be updated even on the persist-failure path, or the expiry decode
  desyncs from the SDK-mutated client token and churns extra rotations.
- `load-env.ts` uses `override: true`; after migration, base `.env` must contain
  **no** residual token/ID lines, or `process.env` silently repopulates and any
  un-converted reader gets a stale value instead of a loud failure.

### A11 — Tests that lock these invariants in
- Real `listTools()` asserts `account` is in the exposed JSON schema (not just
  `Object.keys(def.inputSchema)`); concurrent `callTool()` for two profiles each
  observes its own ALS profile.
- Two profiles return different `accountId`/`businessId` under their respective
  ALS contexts (proves A1/process.env conversion).
- Zero-profile and bad-default tool calls return `isError` and never reject (A3).
- `git check-ignore profiles/<name>.env` succeeds; no migration backup name
  escapes ignore (A2/secrets).
- `writeAtomic` tmp/bak paths are always profile-file-relative, never a shared
  constant.
- Discovery excludes malformed/duplicate/case-colliding files (A5/A6/A7).

## Open Questions

- `users.me()` company-name caching strategy for `list_accounts` (TTL vs.
  per-process memo) — implementation detail, settle in the plan.
- Whether the implicit-legacy-profile (A3) should auto-name itself `default` or
  prompt — settle in the plan; default to `default`.
