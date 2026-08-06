# Setup Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec v3.1 (`docs/superpowers/specs/2026-08-06-setup-rework-design.md`, commit `d0b6a50`): a single-sourced setup flow ("the Book") rendered by a rewritten interactive wizard, a headless agent-driven CLI surface, and drift-tested docs — in three independently shippable phases (PR 1: Book + core; PR 2: headless + agent path + security hardening; PR 3: wizard + human docs).

**Architecture:** All setup knowledge lives in `src/setup-flow.ts` (data). A non-interactive core (`scripts/setup-core.ts`) does the OAuth/discovery/persist work; the wizard (`scripts/setup.ts`) and the headless dispatcher (`scripts/setup-headless.ts`) are thin surfaces over it. All profile writes keep flowing through the guarded writers in `src/migrate.ts`. Docs are enforced by drift tests against the Book.

**Tech Stack:** TypeScript strict, Node ≥18, ts-node (CLI), Vitest, zero new dependencies.

## Global Constraints (from the spec — every task inherits these)

- **Zero new dependencies.** Argv parsing is hand-rolled (`scripts/refresh-tokens.ts:32-60` precedent).
- **Node ≥18** (`package.json` engines): no `util.styleText`, no `structuredClone`-dependent tricks needed.
- **Tokens never appear in stdout, stderr (success paths), chat-visible argv, or JSON** — the only exception is the last-resort loud-failure print in `persistTokens` when even the rescue write fails.
- **Headless convention:** human-readable → stderr; `--json` → stdout. `--json` is a per-verb flag.
- **No handler/CLI ever serializes a caught error object or HTTP body.** Error output goes through the allowlist envelope only.
- **Every profile write goes through `writeNewProfile` / `applyTokensToEnv`+`writeAtomic`** — no third write path.
- **Verbatim user-facing copy** (KICKOFF_PROMPT, SECRETS_RULES, step scripts, the exit-8 question, parting notes, pre-briefs) is **copied from the spec sections cited in each task** — the spec is the source of truth for strings; do not paraphrase. Where a task says "spec §X", open the spec and copy.
- **Behavior freeze in Phase 1:** PR 1 must be behavior-identical (same prompts, same messages, same exit codes) — verified by the existing test suite passing unchanged.
- **Commit style:** `feat:`/`fix:`/`test:`/`docs:` prefixes, one logical change per commit, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` footer.
- Run `npm run build && npm test && npm run lint` before every commit step; a task is not done with any of the three failing.

## File Structure (final state)

```
src/
  setup-flow.ts        # NEW — the Book: SetupCtx, SetupStep, SETUP_FLOW,
                       #       KICKOFF_PROMPT, SECRETS_RULES (data only; no I/O)
  migrate.ts           # MODIFIED — ProfileWriteError, writeNewProfile opts,
                       #            markDistinctLogin
  atomic-write.ts      # MODIFIED — 0600 modes
  freshbooks-client.ts # MODIFIED — rescue-file write + adoption
  docs/render-setup.ts # NEW — renderSetupStepMd + the help `setup` topic
  tools/help.ts        # MODIFIED — register `setup` topic + index lines
  docs/content.ts      # MODIFIED — overview topic list (+ fix `reports` omission)
scripts/
  setup-core.ts        # NEW — buildAuthUrl, exchangeCode, discoverMemberships,
                       #       saveProfile, replaceProfileTokens, pending-file ops
  setup-headless.ts    # NEW — verb dispatcher, exit codes, JSON envelopes, doctor
  setup.ts             # MODIFIED — wizard rendered from the Book (Phase 3);
                       #            --headless delegation (Phase 2); re-exports kept
test/
  setup-flow.test.ts             # NEW (T1)
  migrate-typed-errors.test.ts   # NEW (T2)
  mark-distinct-login.test.ts    # NEW (T3)
  setup-core.test.ts             # NEW (T4)
  pending-file.test.ts           # NEW (T7)
  headless-init.test.ts          # NEW (T8)
  headless-add-login.test.ts     # NEW (T9/T10)
  headless-reauth.test.ts        # NEW (T11)
  headless-install.test.ts       # NEW (T12)
  headless-doctor.test.ts        # NEW (T13)
  rescue-lifecycle.test.ts       # NEW (T14)
  setup-hygiene.test.ts          # NEW (T15)
  setup-flow-docs.test.ts        # NEW (T16, extended T20)
  wizard-render.test.ts          # NEW (T18)
.gitignore             # MODIFIED (T7) — *.pending, *.rescue
README.md, SETUP.md, CLAUDE.md, CHANGELOG.md — per docs tasks
```

Dependency/build note: `scripts/` is not part of the server `tsc` build (only
`src/` compiles into `dist/`); `scripts/setup-core.ts` may construct a
FreshBooks `Client` (pre-profile OAuth) — that is the CLAUDE.md carve-out
recorded in T5. `src/setup-flow.ts` lives in `src/` because
`src/docs/render-setup.ts` (compiled, served by `freshbooks_help`) imports it;
it must stay pure data (no fs/network/ts-node-only imports).

---

# Phase 1 — PR 1: the Book + core extraction (behavior-identical)

### Task 1: `src/setup-flow.ts` — the Book

**Files:**
- Create: `src/setup-flow.ts`
- Test: `test/setup-flow.test.ts`

**Interfaces:**
- Produces: `SetupCtx { projectDir: string; redirectUri: string }`;
  `SetupStep` exactly as spec §"Core concept" (fields: `id, title, who,
  surfaces, appliesIf?, repeats?, summary, humanScript, agentGuidance,
  successCheck, check?, verbs?, docPhrases?, troubleshooting`);
  `SETUP_FLOW: SetupStep[]` (14 steps, ids and order exactly per spec §"The
  step list": `choose-claude, get-project, node-install, npm-install, build,
  developer-app, app-credentials, migrate-legacy, nickname, authorize,
  save-login, install-config, verify, restart`);
  `KICKOFF_PROMPT: string` (spec §ladder, rules 1–6 verbatim);
  `SECRETS_RULES` (spec §Secrets table as
  `{ credential: string; agentRungs: string; humanRung: string }[]` plus the
  honesty-note strings); `HEADLESS_VERBS: string[]` (the canonical flag list:
  `--init, --auth-url, --add-login, --reauth, --install, --print-config,
  --discard-pending, --doctor, --headless, --json, --name, --callback-url,
  --business-id, --account-id, --distinct-login, --confirm-different-user,
  --client-id, --client-secret, --client-secret-file, --client-secret-stdin,
  --command-path`).
- Consumes: nothing (pure data module — no fs, no network).

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-flow.test.ts
import { describe, it, expect } from "vitest";
import { SETUP_FLOW, KICKOFF_PROMPT, SECRETS_RULES, HEADLESS_VERBS } from "../src/setup-flow";

const IDS = ["choose-claude","get-project","node-install","npm-install","build",
  "developer-app","app-credentials","migrate-legacy","nickname","authorize",
  "save-login","install-config","verify","restart"];

describe("the Book", () => {
  it("has exactly the spec's steps, in order, with unique ids", () => {
    expect(SETUP_FLOW.map(s => s.id)).toEqual(IDS);
  });
  it("every step has non-empty scripts and a valid who/surfaces", () => {
    for (const s of SETUP_FLOW) {
      expect(["human","either"]).toContain(s.who);
      expect(s.surfaces.length).toBeGreaterThan(0);
      for (const surf of s.surfaces) expect(["wizard","docs","headless"]).toContain(surf);
      expect(s.humanScript.length).toBeGreaterThan(0);
      expect(s.agentGuidance.length).toBeGreaterThan(0);
      expect(s.summary).toBeTruthy();
      expect(s.successCheck).toBeTruthy();
    }
  });
  it("repeats is set on exactly the per-login steps", () => {
    const repeating = SETUP_FLOW.filter(s => s.repeats === "per-login").map(s => s.id);
    expect(repeating).toEqual(["nickname","authorize","save-login"]);
  });
  it("every verbs[] entry is a known flag", () => {
    for (const s of SETUP_FLOW) for (const v of s.verbs ?? [])
      expect(HEADLESS_VERBS).toContain(v);
  });
  it("kickoff prompt carries the six numbered rules and the pinned URL", () => {
    expect(KICKOFF_PROMPT).toContain("https://github.com/kanjidoc/FreshBooks-MCP");
    for (const n of [1,2,3,4,5,6]) expect(KICKOFF_PROMPT).toMatch(new RegExp(`^${n}\\.`, "m"));
    expect(KICKOFF_PROMPT).toContain("quote back to me its opening heading and its final line");
  });
  it("secrets rules cover the three credential rows", () => {
    expect(SECRETS_RULES.rows.map((r: any) => r.credential)).toEqual([
      "Client ID + Secret","Authorization code","Access/refresh tokens"]);
  });
  it("migrate-legacy is the only appliesIf step; build is a wizard step", () => {
    expect(SETUP_FLOW.filter(s => s.appliesIf).map(s => s.id)).toEqual(["migrate-legacy"]);
    expect(SETUP_FLOW.find(s => s.id === "build")!.surfaces).toContain("wizard");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run test/setup-flow.test.ts` → module not found)
- [ ] **Step 3: Implement `src/setup-flow.ts`.** Interfaces verbatim from spec §"Core concept" (including the `who` docstring, the `check()` bootstrap-window comment, and `repeats`). Populate all 14 steps: `id/title/who/surfaces/appliesIf/repeats/verbs` structurally per the spec's step-list table; `summary/humanScript/agentGuidance/successCheck/docPhrases/troubleshooting` strings **copied from the spec's step-list rows and choreography sections** (§install-config choreography, §restart, §Secrets, exit-8 drafted question into `save-login.agentGuidance`). `KICKOFF_PROMPT` verbatim from §ladder. `SECRETS_RULES` as `{ rows: [...], honestyNotes: [...] }` from §Secrets. `check?` implementations in Phase 1 only where pure (`get-project`: `existsSync(join(ctx.projectDir,"package.json"))`; `build`: `existsSync(join(ctx.projectDir,"dist","index.js"))`; `npm-install`: `existsSync(join(ctx.projectDir,"node_modules"))`) — wait, those use fs: keep the *module* pure by taking an injected `{ exists(path: string): boolean }` in `SetupCtx`; default wiring happens in the CLI surfaces. Add `exists: (p: string) => boolean` to `SetupCtx` and use only `ctx.exists`.
- [ ] **Step 4: Run test — PASS.** Also `npm run build` (module must compile into `dist/` cleanly) and full `npm test` (nothing else may change).
- [ ] **Step 5: Commit** — `feat: add src/setup-flow.ts — the Book (setup flow as data)`

### Task 2: Typed errors in `src/migrate.ts`

**Files:**
- Modify: `src/migrate.ts` (the guard block at `:179-203`)
- Test: `test/migrate-typed-errors.test.ts`

**Interfaces:**
- Produces: `export class ProfileWriteError extends Error { constructor(public readonly code: "NAME_TAKEN" | "DUPLICATE_TOKEN" | "SAME_ACCOUNT", message: string) }`;
  `writeNewProfile(profilesDir, rawName, config, opts?: { onSameAccount?: "warn" | "refuse" })` — `distinctLogin` handling is NOT here (it belongs to callers via `markDistinctLogin`, Task 3). Default `onSameAccount: "warn"` reproduces today's `console.warn` + write (`src/migrate.ts:190-196`); `"refuse"` throws `ProfileWriteError("SAME_ACCOUNT", …)` **before** writing.
- Consumes: nothing new. **Messages must remain byte-identical** for the existing throws (`NAME_TAKEN` ← `:199-203` text, `DUPLICATE_TOKEN` ← `:184-188` text) — `scripts/setup.ts:471` and tests match on message text.

- [ ] **Step 1: Failing test**

```ts
// test/migrate-typed-errors.test.ts (fixture helpers: tmp dir + two profile files,
// reuse the fixture style from the existing migrate tests)
it("NAME_TAKEN and DUPLICATE_TOKEN throws carry codes with unchanged messages", () => {
  // existing-name case
  try { writeNewProfile(dir, "acme", cfgB); throw new Error("no throw"); }
  catch (e: any) {
    expect(e).toBeInstanceOf(ProfileWriteError);
    expect(e.code).toBe("NAME_TAKEN");
    expect(e.message).toContain("already exists — refusing to overwrite");
  }
});
it("onSameAccount:'refuse' throws SAME_ACCOUNT before writing; default still warns and writes", () => {
  expect(() => writeNewProfile(dir, "acme2", sameAccountCfg, { onSameAccount: "refuse" }))
    .toThrowError(expect.objectContaining({ code: "SAME_ACCOUNT" }));
  expect(existsSync(join(dir, "acme2.env"))).toBe(false);        // refused BEFORE write
  writeNewProfile(dir, "acme2", sameAccountCfg);                  // default: warns, writes
  expect(existsSync(join(dir, "acme2.env"))).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL** (ProfileWriteError not exported)
- [ ] **Step 3: Implement.** Add the class; wrap the two existing `throw new Error(...)` sites keeping their exact strings; insert the `refuse` branch inside the same-account scan loop before `writeAtomic` is reached.
- [ ] **Step 4: Full suite green** (`npm test` — the existing migrate/setup tests prove message-compat).
- [ ] **Step 5: Commit** — `feat: typed ProfileWriteError codes on the profile-write guards`

### Task 3: `markDistinctLogin`

**Files:**
- Modify: `src/migrate.ts` (append)
- Test: `test/mark-distinct-login.test.ts`

**Interfaces:**
- Produces: `export function markDistinctLogin(profilesDir: string, accountId: string): string[]` — returns the files it marked. **Fresh `readdirSync` scan at call time** (never `getRegistry()` — spec Appendix C / RA-F4), filter `endsWith(".env")`, parse via `parseProfileConfig`, match `config.accountId === accountId`, skip files already matching `/^#\s*freshbooks-distinct-login\b/m` (the exact regex from `src/profiles.ts:156`), append the line `# freshbooks-distinct-login\n` via `writeAtomic(path, content + marker)`, then verify each marked file's tokens via `readTokenMarkers` (throw on mismatch).
- Consumes: `writeAtomic`, `readTokenMarkers` (`src/atomic-write.ts`), `parseProfileConfig` (`src/profiles.ts`).

- [ ] **Step 1: Failing test** — fixtures: three files sharing accountId `A1` (one already marked), one file with accountId `A2`, one `.env.pending` decoy:

```ts
it("marks every unmarked member of the accountId group and nothing else", () => {
  const marked = markDistinctLogin(dir, "A1");
  expect(marked.sort()).toEqual(["alpha.env", "beta.env"]);           // gamma was pre-marked
  for (const f of ["alpha.env","beta.env","gamma.env"])
    expect(readFileSync(join(dir,f),"utf8")).toMatch(/^#\s*freshbooks-distinct-login\b/m);
  expect(readFileSync(join(dir,"other.env"),"utf8")).not.toMatch(/distinct-login/);
  expect(readFileSync(join(dir,"stray.env.pending"),"utf8")).not.toMatch(/distinct-login/);
});
it("marked files still parse and keep their tokens; discovery un-quarantines the group", () => {
  markDistinctLogin(dir, "A1");
  const res = discoverProfiles(dir, join(dir, "unused-base.env"));
  for (const p of res.profiles.values()) expect(p.quarantined).toBe(false);
});
it("is idempotent", () => {
  markDistinctLogin(dir, "A1");
  expect(markDistinctLogin(dir, "A1")).toEqual([]);
});
```

- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS + full suite** → **Step 5: Commit** — `feat: markDistinctLogin — group-wide quarantine opt-in helper`

### Task 4: Core extraction — `scripts/setup-core.ts`

**Files:**
- Create: `scripts/setup-core.ts`
- Modify: `scripts/setup.ts` (replace inlined logic with core calls; KEEP `buildBaseEnvVars`, `serializeEnv`, and all current exports in place — `test/setup-decoupling.test.ts:2` imports from `../scripts/setup`)
- Test: `test/setup-core.test.ts`

**Interfaces (Produces — Phase 2/3 rely on these exact signatures):**

```ts
export interface Memberships { user: { firstName?: string; lastName?: string; email?: string };
  list: { label: string; accountId: string; businessId: string }[] }
export function buildOAuthClient(clientId: string, clientSecret: string, redirectUri: string): Client; // CLAUDE.md carve-out (T5)
export function buildAuthUrl(client: Client): string;                       // wraps getAuthRequestUrl()
export function extractCodeFromUrl(urlString: string): string | null;       // MOVED from setup.ts (same body, scripts/setup.ts:71-82)
export async function exchangeCode(client: Client, code: string):
  Promise<{ accessToken: string; refreshToken: string }>;                   // throws on rejection (caller maps to exit 3)
export async function discoverMemberships(authed: Client): Promise<Memberships>; // pure users.me() read — NO prompts (the signature redesign, spec A6): maps businessMemberships[] exactly as scripts/setup.ts:330-353 does today, label = business name ?? "(unnamed business)"
export function saveProfile(profilesDir: string, name: string, config: ProfileConfig,
  opts?: Parameters<typeof writeNewProfile>[3]): string;                    // pass-through to writeNewProfile (PR 1: NO added behavior)
export function replaceProfileTokens(profilePath: string, accessToken: string, refreshToken: string): void;
  // applyTokensToEnv + writeAtomic + readTokenMarkers verify (the persistTokens pattern,
  // src/freshbooks-client.ts:145-170, minus client/config state) — used by --reauth in Phase 2
```

- Consumes: `Client` from `@freshbooks/api`; `writeNewProfile`, `applyTokensToEnv` (move? NO — import from `src/freshbooks-client.ts`, already exported), `writeAtomic`, `readTokenMarkers`.

- [ ] **Step 1: Failing tests** — stub the Client (plain object with `getAuthRequestUrl`, `getAccessToken`, `users.me`):

```ts
it("discoverMemberships maps the membership shape to {label, accountId, businessId}", async () => {
  const authed: any = { users: { me: async () => ({ ok: true, data: { firstName: "A",
    businessMemberships: [ { business: { name: "Studio", accountId: "acc1", id: 7 } },
                           { business: { accountId: "acc2", id: 9 } } ] } }) } };
  const m = await discoverMemberships(authed);
  expect(m.list).toEqual([
    { label: "Studio", accountId: "acc1", businessId: "7" },
    { label: "(unnamed business)", accountId: "acc2", businessId: "9" }]);
});
it("exchangeCode surfaces SDK rejection as a throw with no token in the message", async () => {
  const client: any = { getAccessToken: async () => { throw Object.assign(new Error("invalid_grant"),
    { config: { data: "client_secret=SHOULDNOTAPPEAR" } }); } };
  await expect(exchangeCode(client, "x")).rejects.toThrow("invalid_grant");
});
it("replaceProfileTokens swaps only the two token lines and verifies", () => { /* tmp profile fixture */ });
```

- [ ] **Step 2: FAIL** → **Step 3: implement core; rewire `scripts/setup.ts`:** `addLogin()` keeps its exact prompt sequence but calls `buildOAuthClient`/`buildAuthUrl`/`extractCodeFromUrl`/`exchangeCode`; `discoverIds()` becomes a thin prompt loop around `discoverMemberships` (same console output, byte-for-byte — copy the current template strings). `saveProfile` used in place of the direct `writeNewProfile` call.
- [ ] **Step 4: PASS + full existing suite green (behavior freeze).**
- [ ] **Step 5: Commit** — `refactor: extract non-interactive setup core (behavior-identical)`

### Task 5: Phase-1 docs — CLAUDE.md carve-out

**Files:**
- Modify: `CLAUDE.md` — (a) "Client is constructed in exactly one place" invariant gains the carve-out sentence: *"Exception: pre-profile OAuth clients during setup are constructed via `buildOAuthClient` in `scripts/setup-core.ts` — the invariant governs the serving path (`src/`), where `getOrCreateClient` remains the only site."* (b) Project-structure tree gains `src/setup-flow.ts`, `scripts/setup-core.ts`.
- Test: none (doc-inventory/doc-tool-count unaffected — verify by running them).

- [ ] **Step 1: Edit CLAUDE.md** → **Step 2: `npm test` green** → **Step 3: Commit** — `docs: CLAUDE.md — setup-core Client carve-out + structure` → **Step 4: Open PR 1** (`feat/setup-rework-book`), body summarizing behavior-identity + the spec link.

---

# Phase 2 — PR 2: headless surface + agent path + security hardening

### Task 6: Pending-file module + `.gitignore`

**Files:**
- Create: pending ops in `scripts/setup-core.ts` (append)
- Modify: `.gitignore` (add `*.pending` and `*.rescue` after the `*.tmp` line)
- Test: `test/pending-file.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PendingRecord { mode: "add" | "reauth"; stagedAt: string;
  accessToken: string; refreshToken: string }
export function pendingPath(profilesDir: string, name: string): string;  // `${profilesDir}/${name}.env.pending`
export function stagePending(profilesDir: string, name: string, rec: PendingRecord): void;
  // plain writeFileSync(path, serialize(rec), { mode: 0o600 }) — NO bak/tmp ceremony (spec RS-F5).
  // Serialization: dotenv lines FRESHBOOKS_ACCESS_TOKEN/REFRESH_TOKEN + comment lines
  // `# mode=add` / `# staged=<iso>` (dotenv ignores comments; parse with parseProfileConfig + regexes)
export function loadPending(profilesDir: string, name: string): PendingRecord | null;
export function shredPending(profilesDir: string, name: string): void;   // rmSync force:true
export function listPendings(profilesDir: string): { name: string; mode: string; ageMs: number }[];
```

- [ ] **Step 1: Failing tests** — round-trip; 0600 mode (skip on win32: `it.skipIf(process.platform === "win32")`); invisibility: a staged pending never appears in `discoverProfiles` results (not even `broken`) and never trips `writeNewProfile`'s duplicate-token scan (stage a pending whose refresh token equals a would-be profile's; `writeNewProfile` succeeds); `listPendings` ages.
- [ ] **Step 2: FAIL** → **Step 3: implement + edit `.gitignore`** → **Step 4: PASS; also `git check-ignore profiles/x.env.pending .env.rescue` both match** (assert in test via `git check-ignore` spawn or by reading `.gitignore` for the two literals — use the literal-read variant, no subprocess).
- [ ] **Step 5: Commit** — `feat: staged-pending file ops + gitignore coverage for *.pending/*.rescue`

### Task 7: Headless dispatcher skeleton + error envelope + `--init` + `--auth-url`

**Files:**
- Create: `scripts/setup-headless.ts`
- Modify: `scripts/setup.ts` — first line of `main()`: if `process.argv.includes("--headless")`, delegate to `runHeadless(process.argv)` and return its exit code (wizard untouched otherwise)
- Test: `test/headless-init.test.ts`

**Interfaces:**
- Produces:

```ts
export const EXIT = { OK:0, FAIL:1, USAGE:2, CODE_REJECTED:3, NAME_TAKEN:4, DUP_PAIR:5,
  BUSINESS_CHOICE:6, PRECONDITION:7, SAME_ACCOUNT:8, UNMIGRATED:9, INSTALL_FAILED:10,
  DISCOVERY_FAILED:11, REAUTH_MISMATCH:12 } as const;
export interface Emit { json: boolean }
export function emitOk(e: Emit, verb: string, fields: Record<string, unknown>): void;   // stdout JSON | stderr human
export function emitErr(e: Emit, verb: string, exitCode: number, stepId: string,
  symptom: string, fix: string, message: string, extra?: Record<string, unknown>): void;
  // NEVER receives/serializes an Error object — call sites pass err.message only (allowlist envelope, spec §--json)
export async function runHeadless(argv: string[]): Promise<number>;
```

`--init` per spec verb table: parse `--client-id` + exactly one secret source;
`--client-secret-file F` → unlink-and-recreate F at 0600 before read? NO —
re-read the spec: the CLI **reads** the agent-written file; "unlinks-and-
recreates at 0600 before reading" means: `const secret = readFileSync(F,"utf8").split("\n")[0].trim(); rmSync(F); writeFileSync(F, secret, {mode:0o600}); …use…; rmSync(F, {force:true})` — simpler and equivalent: read once, `rmSync` immediately (shred-on-read), keep the secret only in memory; the 0600 recreate is pointless once shredded. **Implement: read → immediate rmSync (unconditional, in a finally) → use.** Loudly `console.error` + exit FAIL if the rm throws. `--client-secret-stdin` → read one line from stdin. `--client-secret X` → warn on stderr. Legacy guard: if `.env` exists, contains `FRESHBOOKS_REFRESH_TOKEN=` non-empty (regex from `scripts/setup.ts:249`) and `!isMigrated(content)` → `emitErr(..., EXIT.UNMIGRATED, "migrate-legacy", ...)` **before any write**. Otherwise `writeEnvFile(buildBaseEnvVars(id, secret, REDIRECT_URI, isMigrated(existing)))`.
`--auth-url`: requires parseable `.env` with client id/secret (else PRECONDITION, stepId `app-credentials`); prints `{url}` / plain URL; **never** calls `openBrowser`.

- [ ] **Step 1: Failing tests** — capture stdout/stderr (vitest `vi.spyOn(console, ...)` + a `run(argv)` that returns the exit code, mirroring `scripts/refresh-tokens.ts:114`'s testable-run pattern): init writes `.env` with only the 3 creds + marker preservation; legacy-token fixture → exit 9, `.env` untouched; secret-file shredded even when init fails (name-collision on nothing — force failure via unwritable dir fixture); `--client-secret` argv path warns; auth-url exit 7 without `.env`; JSON envelopes match the shapes; **no secret string in any captured stream** for the file/stdin paths.
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS + suite** → **Step 5: Commit** — `feat: headless dispatcher, --init (exit-9 legacy guard, secret-file transport), --auth-url`

### Task 8: `--add-login` — callback form, clean path

**Files:**
- Modify: `scripts/setup-headless.ts`
- Test: `test/headless-add-login.test.ts`

**Interfaces:**
- Consumes: T4 core (`exchangeCode`, `discoverMemberships`, `saveProfile`), T6 pending ops, T2 `ProfileWriteError`, T3 `markDistinctLogin`.
- Produces: the `addLogin(argv, emit)` verb handler. Order per spec state machine: (1) `normalizeProfileName` + availability (`existsSync(profilesDir/name.env)`) → NAME_TAKEN exit 4 **before** exchange, fix text per spec exit table ("already yours? run --doctor; reconnecting? use --reauth"); (2) `exchangeCode` → CODE_REJECTED exit 3 on throw; (3) `stagePending(mode:"add")` **before** discovery; (4) `discoverMemberships` with a Client built on the staged pair; (5) single membership + no same-account collision → `saveProfile` → `shredPending` → `emitOk` `{name, company, accountId, businessId, profilePath}`.

- [ ] **Step 1: Failing tests** (stubbed core via vitest `vi.mock` of `./setup-core`): clean path emits ok and no pending remains; name-taken exits 4 with NO exchange call (assert stub not called); exchange throw exits 3 with nothing staged; crash simulation (make save throw generic) leaves the pending on disk.
- [ ] **Step 2–4: FAIL → implement → PASS** → **Step 5: Commit** — `feat: --add-login clean path with stage-before-discovery`

### Task 9: `--add-login` — branch exits + resume forms + short-circuit

**Files:**
- Modify: `scripts/setup-headless.ts`
- Test: extend `test/headless-add-login.test.ts`

**Interfaces (Produces — behavior contract, spec state machine + exit table):**
- Multi-membership → stage kept, exit 6, payload `memberships: [{label, accountId, businessId}]`.
- Same-account (any membership accountId ∈ existing profiles' accountIds — fresh scan) → stage kept, exit 8, payload `{existingProfile, confirmQuestion, directive}` (strings verbatim from spec §"Exit 8, fully drafted"; NO resume command in payload).
- Discovery throw → stage kept, exit 11.
- **Resume forms** (`--name` present, no `--callback-url`): no pending → USAGE exit 2 listing `listPendings` names. **Pre-discovery short-circuit first:** if `profiles/<name>.env` exists and its refresh token equals the pending's → `shredPending`, exit 0 (no network). Then: expired staged access token (decode via `decodeJwtExp` from `src/freshbooks-client.ts`) → refresh via staged refresh token (Client.refreshAccessToken) and **immediately `stagePending` the rotated pair** before proceeding; refresh failure → exit 3 + fix "stale grant — --discard-pending and re-auth". `--account-id A [--business-id B]` → **skip discovery**, save with asserted ids. `--business-id B` alone → re-discover, pick the matching membership (absent → USAGE 2). `--distinct-login` requires `--confirm-different-user` (else USAGE 2); on save: `saveProfile(..., { onSameAccount: "warn" })` then `markDistinctLogin(profilesDir, accountId)`. Bare resume → re-run discovery on staged pair, re-emit the branch exit. Save-stage backstop: catch `ProfileWriteError` — NAME_TAKEN + same-token-as-pending → shred, exit 0; NAME_TAKEN different-token / DUPLICATE_TOKEN → shred, exit 5 with the amended fix text (spec exit table); SAME_ACCOUNT (refuse mode, only reachable without the confirmed flag) → exit 8 path.

- [ ] **Step 1: Failing tests** — one test per row above (12 tests), all with mocked core + tmp profiles dir; assert exact exit codes, payload fields, pending presence/absence after each, and that `--account-id` resume performs zero discovery calls.
- [ ] **Step 2–4: FAIL → implement → PASS** → **Step 5: Commit** — `feat: --add-login branch exits, resume grammar, crash-idempotent short-circuit`

### Task 10: `--reauth` + `--discard-pending`

**Files:**
- Modify: `scripts/setup-headless.ts`
- Test: `test/headless-reauth.test.ts`

**Interfaces (spec verb table row):** name must exist (else USAGE 2 pointing at `--add-login`); exchange → stage `mode:"reauth"`; discover; **set-containment** (stored accountId ∈ membership accountIds; blank stored accountId → skip with stderr warning); mismatch → exit 12, pending KEPT; discovery throw → exit 11, pending kept; resume = `--reauth --name N` (no discovery-skip form — deliberate, spec exit-11 row); match → `replaceProfileTokens` (T4) + **shred `<profilePath>.rescue` if present** (precedence rule) + duplicate-token guard vs OTHER profiles (scan, reuse `writeNewProfile`'s loop logic via a small exported `assertNoForeignDuplicate(profilesDir, name, refreshToken)` added to `setup-core`) + shred pending + emitOk. Server-lock check first: `isServerLockFresh(lockPathFor(rootDir))` → stderr warning verbatim from spec ("restart Claude after re-auth…"), never refuse. `--discard-pending --name N`: shred + `{name, discarded:true}` + the honest no-server-side-revoke note in human output.

- [ ] **Step 1: Failing tests** — happy 2-business containment pass; mismatch → 12 + pending kept; blank accountId → warn + proceed; lock-fresh fixture (write `.server.lock` with own pid) → warning present, exit 0; rescue file present → shredded after replace; discard-pending round trip; reauth on nonexistent name → 2.
- [ ] **Step 2–4** → **Step 5: Commit** — `feat: --reauth with set-containment + staging, --discard-pending`

### Task 11: `--install` + `--print-config`

**Files:**
- Modify: `scripts/setup-headless.ts`, `src/mcp-config.ts`
- Test: `test/headless-install.test.ts`

**Interfaces:**
- `src/mcp-config.ts`: `buildClaudeServerConfig(projectDir, commandPath?: string)` — `command: commandPath ?? "node"` (default unchanged for existing callers).
- `selectCommandPath(opts: { assumeSandbox: boolean; override?: string }): { command: string; caveat?: string }` in `setup-headless.ts`: override wins; else non-sandbox → `process.execPath`; else probe `["/opt/homebrew/bin/node","/usr/local/bin/node","/usr/bin/node"]` via `existsSync` → first hit; else `"node"` + caveat string. `--headless` runs pass `assumeSandbox: true` unless `--trust-exec-path` (rung-1 agents set it; documented in agentGuidance) — simpler: flag `--command-path <abs>` and `--trust-exec-path`; default probes.
- `--install desktop`: reuse `upsertClaudeDesktopConfig` logic but returning structured results — refactor `scripts/setup.ts:131-153` into `setup-core.ts` `installDesktop(projectDir, commandPath?): { ok: true; path: string; mtimeMs: number } | { ok: false; reason: string }` (wizard calls it too — keep wizard output identical). Invalid existing JSON → `ok:false` → exit 10 with `{configBlock, path}`. `--install code`: `claude` CLI present (`isClaudeCliAvailable`, moved to core) → add-json path; else write `.mcp.json` + emit the open-this-folder script line; failures → exit 10. `both` → run desktop then code, one JSON object per line each. `--print-config <target>`: exit 0, `{target, path, configBlock}` — **no read of existing config**; same `selectCommandPath`.
- [ ] **Step 1: Failing tests** — tmp HOME fixture for the desktop path (point `resolveDesktopConfigPath` via env override — add `CLAUDE_DESKTOP_CONFIG_PATH` env override to `src/config-paths.ts`, test-only, documented in-code); merge preserves foreign `mcpServers` entries byte-identical; invalid-JSON fixture → exit 10 + block in payload; print-config never opens the existing file (spy on fs.readFileSync scoped); `both` emits two lines; probe order.
- [ ] **Step 2–4** → **Step 5: Commit** — `feat: --install/--print-config with command selection and exit-10 payloads`

### Task 12: `--doctor`

**Files:**
- Modify: `scripts/setup-headless.ts`
- Test: `test/headless-doctor.test.ts`

**Interfaces:** `runDoctor(ctx): { ok: boolean; checks: Check[] }`, `Check = { id, stepId, status: "pass"|"warn"|"fail", detail, fix }`. Checks, each keyed per spec `--doctor` row: node ≥18 (`process.versions.node`); node_modules; `dist/index.js`; `.env` presence/format (parse, never echo values); unmigrated-legacy → fail(stepId `migrate-legacy`); per-profile `inspectTokenHealth` + registry quarantine (fresh `discoverProfiles`, not the memoized registry); pendings via `listPendings` (>24 h → warn, fix = bare resume or `--discard-pending`); `.rescue` scan (each profile path + base `.env`) → fail with the adopts-or-clears fix text; `.client-secret.tmp` lingering → warn; config entries (desktop file read-if-present, `.mcp.json`, `~/.claude.json` best-effort) — per-location info, fail only if none resolvable, missing-config fix carries the sandbox-hypothesis text verbatim (spec); non-absolute command → warn (two-cause text), absolute-missing → fail; configured dist path exists; 0600 perms on `.env`/profiles (warn; skip win32). Zero profiles → fail(stepId `save-login`), overall exit 1 never 2.
- [ ] **Step 1: Failing tests** — fixture matrix per spec Testing section: healthy / expiring / unmigrated / stale pending (both modes) / rescue present / secret-tmp / missing build / relative command / absolute-missing command / zero profiles. Assert stepIds, statuses, exit codes, and **no token substrings in output** (canary fixtures).
- [ ] **Step 2–4** → **Step 5: Commit** — `feat: --doctor with Book-keyed checks`

### Task 13: Security hardening in `src/` — 0600 + rescue lifecycle

**Files:**
- Modify: `src/atomic-write.ts` (`writeAtomic`: `writeFileSync(tmp, content, { mode: 0o600 })`; after `copyFileSync` bak: `chmodSync(bak, 0o600)` in try/catch no-op), `src/freshbooks-client.ts` (`persistTokens` + `refreshAndPersist`), `scripts/setup.ts` (`writeEnvFile` mode)
- Test: `test/rescue-lifecycle.test.ts`

**Interfaces (spec §Security hardening, all three rules):**

```ts
// freshbooks-client.ts additions
function rescuePathFor(filePath: string): string;                    // `${filePath}.rescue`
function writeRescue(filePath: string, access: string, refresh: string): boolean; // 0600; false on failure
function tryAdoptRescue(profile: ProfileState): void;
// called in refreshAndPersist AFTER preflightEnvFile(:183), BEFORE the U3 read (:194):
// if rescue exists: parse; compare decodeJwtExp/iat of rescue.access vs profile.config.accessToken
//   — newer → (a) applyTokensToEnv+writeAtomic+verify into profile file,
//             (b) profile.config.* = rescue pair AND client.accessToken/refreshToken = rescue pair,
//             (c) rmSync rescue;
//   — equal/older → rmSync rescue + console.error warning (superseded), never adopt.
// persistTokens failure path: writeRescue first; print ONLY the path; full-token stderr
// print ONLY when writeRescue returned false (keep existing text for that last resort).
```

- [ ] **Step 1: Failing tests** — (a) persist-failure (unwritable profile file fixture) creates `.rescue`, stderr has the path and NO tokens; (b) persist-failure AND unwritable rescue dir → the existing loud print fires (tokens allowed here — assert present, this is the sanctioned exception); (c) adoption: profile file holds old pair, rescue holds newer pair (fixture JWTs with iat now vs -1d) → after `refreshIfNeeded` with stubbed SDK, file + config + client all hold the rescue pair, rescue gone, NO `refreshAccessToken` call (assert stub); (d) stale rescue (older iat) → shredded with warning, no adopt; (e) `writeAtomic` tmp created 0600 (statSync mode check, skip win32); (f) `replaceProfileTokens` (reauth) shreds a rescue (integration with T10's hook — assert via the core function directly).
- [ ] **Step 2–4** → **Step 5: Commit** — `feat: rescue-file lifecycle + 0600-at-creation credential writes`

### Task 14: Token-hygiene sweep suite

**Files:**
- Create: `test/setup-hygiene.test.ts`

**Contract (spec §Security testing):** canary-JWT fixtures (3-segment base64url, distinctive bodies) driven through EVERY headless verb's success AND failure paths (stubbed core), capturing stdout+stderr, asserting via the 8-char sliding-window method (copy the helper from `test/refresh-tokens-redaction.test.ts`) that no canary substring appears — including `--doctor` on the full fixture matrix and one exchange-rejection whose error object embeds a canary in `error.config.data` (proves the envelope projection drops it). The sanctioned exception (T13 test b) is asserted in T13, not here — this suite must have zero exceptions.

- [ ] **Steps: write (FAIL if any leak) → fix any leaks found → PASS → Commit** — `test: token-hygiene sweep across every headless verb`

### Task 15: `renderSetupStepMd` + help `setup` topic

**Files:**
- Create: `src/docs/render-setup.ts`
- Modify: `src/tools/help.ts` (enum + sections + `renderIndexTopic` line), `src/docs/content.ts` (overview closing list: add `reports` AND `setup` — fixes the standing omission)
- Test: extend `test/setup-flow.test.ts` + a new topic-index test file `test/help-topics.test.ts`

**Interfaces:**

```ts
export function renderSetupStepMd(step: SetupStep): string;
// Deterministic markdown per spec §Enforcement render rules: documentation ctx
// (symbolic "<project folder>"; literal redirect URI); heading = step.title;
// "The setup program shows this step only if …" prefix when appliesIf;
// capability-keyed role headings ("If Claude can run commands on your computer:" /
// "If you are typing every command yourself:"); successCheck; troubleshooting table.
export function renderSetupTopic(): string;  // all docs-surface steps + KICKOFF_PROMPT + SECRETS_RULES table
```

- [ ] **Step 1: Failing tests** — snapshot-free structural asserts: render contains the two capability headings for a docs step; appliesIf prefix only on `migrate-legacy`; `renderSetupTopic()` contains every docs-surface step title; `test/help-topics.test.ts`: every `sections` enum key appears in `renderIndexTopic()` and in the overview's closing list (this FAILS today for `reports` — the fix lands here).
- [ ] **Step 2–4** (annotation note: `freshbooks_help` already allow-listed in `test/tool-inventory.test.ts` — unchanged) → **Step 5: Commit** — `feat: help setup topic + renderSetupStepMd; fix overview topic-list omission`

### Task 16: README + SETUP.md agent path + scoped drift test

**Files:**
- Modify: `README.md` (kickoff fenced block + expected-heading line + no-web sidebar, copy from spec §Enforcement), `SETUP.md` (insert `<!-- setup-step:<id> BEGIN/END -->` fenced generated blocks for the docs-surface steps — content = `renderSetupStepMd` output committed verbatim; retitle + gate the token-exchange appendix section; move manual config blocks inside the `install-config` fence; append the sentinel line; keep the tool-total sentence matching `test/doc-tool-count.test.ts`'s pattern exactly once)
- Create: `test/setup-flow-docs.test.ts`

**Drift test (spec §Enforcement, scoped for PR 2):**

```ts
it("every docs-surface step has exactly one fence pair, in Book order", ...);
it("every fence id in SETUP.md matches a live Book id", ...);
it("each fenced region equals renderSetupStepMd(step) byte-for-byte", ...);
it("docPhrases appear inside their step's region", ...);
it("README contains KICKOFF_PROMPT verbatim + the expected-heading line", ...);
it("SETUP.md ends with the sentinel line and carries the appendix gate sentence", ...);
it("all --flags inside setup fences are in HEADLESS_VERBS (allowlist: --profile, --scope, --version)", ...);
```

Also: split `test/doc-inventory.test.ts` — add a second describe for SETUP.md asserting only no-unregistered-names.

- [ ] **Steps: write drift test (FAIL) → rewrite README/SETUP.md until green → full suite (doc-tool-count must stay green — adjust the total sentence placement, not the tuple) → Commit** — `docs: agent-path SETUP.md with committed generated blocks + README kickoff; drift tests` → **Open PR 2** (`feat/setup-rework-headless`). CHANGELOG entry under Unreleased.

---

# Phase 3 — PR 3: wizard re-render + human path

### Task 17: `prompt()` helper + checklist renderer

**Files:**
- Modify: `scripts/setup.ts` (replace `ask`/`isYes` call sites progressively), new pure functions co-located
- Test: `test/wizard-render.test.ts`

**Interfaces:**

```ts
export function formatPrompt(question: string, def: "yes" | "no" | null): string;
// "yes" → `${question} (Enter = yes, n = no): `   "no" → `${question} (y = yes, Enter = no): `
export function renderChecklist(steps: SetupStep[], ctx: SetupCtx, doneIds: string[], currentId: string, loginCount: number): string;
// append-only block: ✓ done / ▶ current / ○ pending, appliesIf-filtered,
// per-login steps annotated "(login N)" when loginCount > 1
```

- [ ] **Step 1: failing tests for both renderings + filtering/repeats** → **2–4** → **5: Commit** — `feat: prompt formatter + append-only checklist renderer`

### Task 18: Wizard re-render from the Book

**Files:**
- Modify: `scripts/setup.ts` — `main()` flow reordered per spec Surface 1: nickname-before-OAuth (availability pre-check via `normalizeProfileName` + exists), just-in-time OAuth checklist printed AT the paste prompt (strings from the Book's `authorize` step), paste validator (scheme-less/query-less input → the spec's "part of the address" message, then re-prompt), plain-English migration gate (Book `migrate-legacy` humanScript), same-account confirm → `saveProfile(..., {onSameAccount:"warn"})` + `markDistinctLogin`, per-login summary, checklist printed at each stage boundary. STEP 4 build and STEP 5 install prompts KEPT (Book `build`/`install-config` wizard surface). All prompts via `formatPrompt`.
- Test: extend `test/wizard-render.test.ts` with the pure pieces (paste validator function `validateCallbackPaste(input): { ok: true; code: string } | { ok: false; hint: string }` extracted and unit-tested); decoupling test untouched and green.

- [ ] **Steps: extract validator (test-first) → reorder main() → manual smoke: `npm run setup` reaches the auth-url print with a test .env then Ctrl-C (document expected transcript in the commit body) → full suite → Commit** — `feat: wizard rendered from the Book — nickname-first, just-in-time OAuth copy`

### Task 19: SETUP.md human path + honesty + full drift

**Files:**
- Modify: `SETUP.md` (human framing prose outside fences: per-rung time honesty + touchpoint floor in limitations; incognito tip; Desktop tool-cache row in beginner words; troubleshooting completion incl. closed-tab row, truncated-secret row), `CLAUDE.md` (three-surface contract + doc-maintenance rows verbatim from spec §Docs impact), `docs/claude-project-system-prompt.md` if tool names shifted (none should)
- Modify: `test/setup-flow-docs.test.ts` — un-scope to the full assertion set.
- **Probe step (manual, blocking):** the exit-11 "where to find your account ID" pointer — run one live `freshbooks_get_client`-style check of the FreshBooks web UI (owner account), record the location + date in the Book's `save-login` troubleshooting entry (REPORT_PARAMS discipline; do NOT guess).
- [ ] **Steps: prose edits → probe + record → drift tests green → doc-tool-count/doc-inventory green → Commit** — `docs: human-path SETUP.md, honesty sections, CLAUDE.md contract`

### Task 20: Release hygiene

- [ ] CHANGELOG Unreleased entries complete for all three PRs; `npm run build && npm test && npm run lint` clean; **Open PR 3** (`feat/setup-rework-wizard`). No version bump (release is a separate decision per CLAUDE.md).

---

## Self-review (author, per writing-plans)

- **Spec coverage:** every spec section maps: Book/enforcement → T1/T15/T16/T19; ladder+kickoff → T1/T16; secrets → T1/T7/T14; Surface 1 → T17/T18; Surface 2 verbs → T7–T12; state machine → T8/T9; typed errors → T2/T3; install choreography → T11 (+Book strings T1); doctor → T12; security → T6/T13/T14; docs impact → T5/T15/T16/T19; testing section → T14 + per-task suites; sequencing → the three phases. Gap check: exit-8/exit-6 relay scripts live in Book strings (T1) and are exercised by T9's payload tests — covered.
- **Placeholders:** none found (verbatim-copy rule replaces string duplication by design, stated in Global Constraints).
- **Type consistency:** `saveProfile` opts type = `writeNewProfile`'s (T2) via `Parameters<>`; `PendingRecord` consistent across T6/T8/T9/T10; `EXIT` names match spec codes 0–12; `selectCommandPath` consumed by both `--install` and `--print-config` (T11).
