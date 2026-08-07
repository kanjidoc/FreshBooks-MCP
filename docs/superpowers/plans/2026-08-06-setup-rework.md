# Setup Rework Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Version note:** v2 — rewritten after a 4-agent plan review (code feasibility,
spec fidelity, zero-context-executor simulation, human-outcome tracing).
Changes: Appendix A now carries the drafted Book content (titles + copy the
spec doesn't draft verbatim); the persona-string manifest test (T1) and wizard
transcript-order test (T18) pin the human outcomes; injectable path ctx for
all headless tests; mode-gated resumes; the rescue-adoption control flow fully
specified with a new `decodeJwtIat`; the docs-generation script; and the three
spec reconciliations (now landed as spec v3.2).

**Goal:** Implement spec v3.2 (`docs/superpowers/specs/2026-08-06-setup-rework-design.md`): the Book, a headless agent surface, security hardening, and a rewritten wizard — three independently shippable PRs.

**Architecture:** All setup knowledge lives in `src/setup-flow.ts` (pure data). A non-interactive core (`scripts/setup-core.ts`) does OAuth/discovery/persist work; the wizard (`scripts/setup.ts`) and headless dispatcher (`scripts/setup-headless.ts`) are thin surfaces over it. Profile writes flow only through the guarded writers. Docs are byte-enforced against the Book by drift tests plus a committed regeneration script.

**Tech Stack:** TypeScript strict, Node ≥18, ts-node (CLI), Vitest, zero new dependencies.

## Global Constraints (every task inherits these)

- **Zero new dependencies.** Argv parsing hand-rolled (`scripts/refresh-tokens.ts:32-60` precedent).
- **Node ≥18** (`package.json` engines).
- **Tokens never appear in stdout, stderr (success paths), argv, or JSON.** Sole sanctioned exception: `persistTokens`' last-resort print when even the rescue write fails (T13 test b).
- **Headless convention:** human-readable → stderr; `--json` → stdout; `--json` is a per-verb flag.
- **No surface serializes a caught error object or HTTP body** — allowlist envelope only.
- **Every profile write goes through `writeNewProfile` / `applyTokensToEnv`+`writeAtomic`.**
- **Copy rule:** user-facing strings come from exactly two sources — (1) the spec sections a task cites, verbatim, for strings the spec drafts (KICKOFF_PROMPT §ladder; the exit-8 question + directive §"Exit 8, fully drafted"; the extended re-ask script, pre-briefs, disclosure line, insertion script §install-config choreography; SECRETS_RULES rows + honesty notes §Secrets; the sentinel + gate sentences §Enforcement); (2) **Appendix A of this plan**, verbatim, for everything the spec describes but does not draft (step titles, humanScript sentences, successChecks, troubleshooting rows, docPhrase selections). Do not paraphrase either source. **Precedence on collision:** the spec's *titled verbatim blocks* (the list above) outrank Appendix A; the spec's *italicized fragments inside descriptive prose* are illustrative only and Appendix A outranks them. KICKOFF_PROMPT's canonical form uses logical lines (no mid-phrase hard wraps), so substring assertions hold.
- **"As plan v1" references** resolve to commit `9b0471e` (`git show 9b0471e:docs/superpowers/plans/2026-08-06-setup-rework.md`) — those task bodies remain normative where v2 doesn't amend them.
- **Step `summary` fields** are short plain-prose one-liners the implementer writes, guided by the spec step-table's summary cells — never copied verbatim from the table (its cells carry escapes, citations, and cross-references that must not enter the Book). Nothing pins summaries; they must contain no `--flags` beyond the allowlists and no markdown artifacts.
- **Phase-1 behavior freeze:** PR 1 is behavior-identical; the existing suite must pass unchanged.
- **Injectable paths for tests:** every headless entry point takes a `SetupPaths` ctx (T7) — tests never touch the developer's real `.env`/`profiles/`/Desktop config.
- **Commit style:** `feat:`/`fix:`/`test:`/`docs:` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. `npm run build && npm test && npm run lint` green before every commit.

## File Structure (final state; task labels correct)

```
src/
  setup-flow.ts        # NEW (T1) — the Book: pure data + KICKOFF_PROMPT,
                       #   SECRETS_RULES, SIDEBAR_TEXT, HEADLESS_VERBS
  migrate.ts           # MOD (T2 typed errors/opts; T3 markDistinctLogin)
  atomic-write.ts      # MOD (T13 0600 modes)
  freshbooks-client.ts # MOD (T13 rescue lifecycle + decodeJwtIat)
  docs/render-setup.ts # NEW (T15) — renderSetupStepMd/renderSetupTopic
  tools/help.ts        # MOD (T15) — setup topic + index line
  docs/content.ts      # MOD (T15) — overview list gains reports + setup
scripts/
  setup-core.ts        # NEW (T4) + pending ops (T6) + install writers (T11)
  setup-headless.ts    # NEW (T7) — dispatcher/verbs/doctor (T7-T12)
  setup.ts             # MOD — --headless delegation (T7); wizard re-render (T18)
  generate-setup-docs.ts # NEW (T16) — splices generated blocks into SETUP.md
test/
  setup-flow.test.ts (T1) · migrate-typed-errors.test.ts (T2)
  mark-distinct-login.test.ts (T3) · setup-core.test.ts (T4)
  pending-file.test.ts (T6) · headless-init.test.ts (T7)
  headless-add-login.test.ts (T8+T9) · headless-reauth.test.ts (T10)
  headless-install.test.ts (T11) · headless-doctor.test.ts (T12)
  rescue-lifecycle.test.ts (T13) · setup-hygiene.test.ts (T14)
  help-topics.test.ts (T15) · setup-flow-docs.test.ts (T16, extended T19)
  wizard-render.test.ts (T17+T18)
.gitignore (T6) · README.md (T16) · SETUP.md (T16, T19) · CLAUDE.md (T5, T19)
CHANGELOG.md (T5, T16, T20)
```

Build note: `scripts/` is outside the server `tsc` build; `src/setup-flow.ts`
is in `src/` because `src/docs/render-setup.ts` (compiled, served by
`freshbooks_help`) imports it — it must stay pure data with zero imports.
`SetupCtx.exists` is an injected function so the module never touches `fs`.

---

# Phase 1 — PR 1: the Book + core extraction (behavior-identical)

### Task 1: `src/setup-flow.ts` — the Book

**Files:** Create `src/setup-flow.ts`; Test `test/setup-flow.test.ts`

**Interfaces (Produces):**

```ts
export interface SetupCtx {
  projectDir: string;
  redirectUri: string;
  exists?: (path: string) => boolean;  // injected by CLI surfaces; optional so
                                       // the documentation render ctx omits it
}
export interface SetupStep { /* exactly spec §"Core concept": id, title, who,
  surfaces, appliesIf?, repeats?, summary, humanScript, agentGuidance,
  successCheck, check?, verbs?, docPhrases?, troubleshooting */ }
export const SETUP_FLOW: SetupStep[];      // 14 steps — ids, order, and ALL
                                           // field content per Appendix A + the
                                           // spec sections it cites
export const KICKOFF_PROMPT: string;       // spec §ladder, verbatim, logical lines
export const SECRETS_RULES: {              // spec §Secrets, verbatim
  rows: { credential: string; agentRungs: string; humanRung: string }[];
  selfTest: string;                        // the one-line self-test (spec §Enforcement rule b)
  honestyNotes: string[];
};
export const SIDEBAR_TEXT: string;         // the README no-web fallback, spec §Enforcement, verbatim
export const HEADLESS_VERBS: string[];     // canonical flag list — MUST include:
  // --headless --json --init --auth-url --add-login --reauth --install
  // --print-config --discard-pending --doctor --name --callback-url
  // --business-id --account-id --distinct-login --confirm-different-user
  // --client-id --client-secret --client-secret-file --client-secret-stdin
  // --command-path --trust-exec-path
export const DOC_CTX: SetupCtx;            // { projectDir: "<project folder>",
                                           //   redirectUri: "https://localhost/callback" }
                                           // the documentation render ctx (spec render rule a)
export const FOREIGN_FLAG_ALLOWLIST: string[]; // ["--profile","--scope","--version","--strip-components"]
export const EXIT8_QUESTION: string;       // spec §"Exit 8, fully drafted", verbatim
export const EXIT8_DIRECTIVE: string;      // ditto — referenced by save-login's
                                           // agentGuidance, imported by setup-headless (T9)
```

Authoring constraints (bind T15/T16 — stated here so the Book is written
compatibly): every `docPhrases[]` entry MUST be a substring of that step's
rendered fields (T16 asserts phrases inside byte-equal regions); the manual
Desktop/Code config JSON blocks live in `install-config`'s
humanScript/agentGuidance (they must render inside that fence, spec
§Enforcement); the dialog-budget range + countdown strings belong to
**`get-project`** (the first command step); `npm-install`'s troubleshooting
owns the MODULE_NOT_FOUND row; the wizard-handoff single-narrator line and the
paste-mismatch confirmation script live in the steps Appendix A assigns them
(`app-credentials` / `choose-claude`). `check()` returns `{ ok, detail }` —
detail strings are in Appendix A. `node-install` has **no** `check()` — its
check is the raw `node --version` command (bootstrap window, spec §Book
`check` comment); the doctor's node check (T12) is deliberately independent.
`build.surfaces = ["docs","wizard"]` — "headless precondition" is expressed
via `check()` consumed by `--doctor`, not a surface value.

- [ ] **Step 1: Portal probe (blocking, recorded).** Log into the owner FreshBooks account, open the Developer Portal, click Create an App, and record EVERY field on the form (labels, required/optional, the scope checkboxes' exact names) plus today's date. Write the results into Appendix A's `developer-app` entry (replacing its `PROBE:` markers). This is the REPORT_PARAMS discipline — the field list must be observed, never guessed.
- [ ] **Step 2: Write the failing test** — `test/setup-flow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SETUP_FLOW, KICKOFF_PROMPT, SECRETS_RULES, SIDEBAR_TEXT,
  HEADLESS_VERBS, FOREIGN_FLAG_ALLOWLIST } from "../src/setup-flow";

const IDS = ["choose-claude","get-project","node-install","npm-install","build",
  "developer-app","app-credentials","migrate-legacy","nickname","authorize",
  "save-login","install-config","verify","restart"];
const step = (id: string) => SETUP_FLOW.find(s => s.id === id)!;
// NOTE: docPhrases are deliberately EXCLUDED from allText — including them
// would make the substring assertions below vacuously true.
const allText = (s: any) => [s.title, s.summary, ...s.humanScript, s.agentGuidance,
  s.successCheck, ...s.troubleshooting.flatMap((t: any) => [t.symptom, t.fix])].join("\n");

describe("structure", () => {
  it("ids/order", () => expect(SETUP_FLOW.map(s => s.id)).toEqual(IDS));
  it("fields valid", () => { for (const s of SETUP_FLOW) {
    expect(["human","either"]).toContain(s.who);
    expect(s.surfaces.every((x: string) => ["wizard","docs","headless"].includes(x))).toBe(true);
    expect(s.humanScript.length).toBeGreaterThan(0);
    expect(s.agentGuidance).toBeTruthy(); expect(s.successCheck).toBeTruthy();
  }});
  it("repeats/appliesIf/build-surfaces", () => {
    expect(SETUP_FLOW.filter(s => s.repeats).map(s => s.id)).toEqual(["nickname","authorize","save-login"]);
    expect(SETUP_FLOW.filter(s => s.appliesIf).map(s => s.id)).toEqual(["migrate-legacy"]);
    expect(step("build").surfaces).toEqual(["docs","wizard"]);
  });
  it("every verbs[] entry and every --flag mentioned in any step text is in HEADLESS_VERBS", () => {
    for (const s of SETUP_FLOW) {
      for (const v of s.verbs ?? []) expect(HEADLESS_VERBS).toContain(v);
      for (const m of allText(s).match(/--[a-z-]+/g) ?? [])
        expect([...HEADLESS_VERBS, ...FOREIGN_FLAG_ALLOWLIST]).toContain(m);
      // FOREIGN_FLAG_ALLOWLIST = ["--profile","--scope","--version","--strip-components"]
      // — exported from src/setup-flow.ts; T16's fence sweep uses the SAME list.
      // --strip-components is a tar option inside the blessed get-project
      // command, not a verb; it must never enter HEADLESS_VERBS.
    }
  });
  it("docPhrases are substrings of their step's own text", () => {
    for (const s of SETUP_FLOW) for (const p of s.docPhrases ?? [])
      expect(allText(s)).toContain(p);
  });
});

describe("persona-string manifest (content pins — the strings the design exists for)", () => {
  const M: [string, string][] = [
    ["authorize",      "CAN'T BE REACHED"],
    ["authorize",      "Click once inside the address bar"],
    ["authorize",      "stay with me"],                       // agentGuidance (rungs 1-2 only)
    ["authorize",      "no harm done"],                       // closed-tab row
    ["authorize",      "sign-in link the setup program just printed"],
    ["app-credentials","never into this chat"],               // rung-3 secrets row
    ["app-credentials","I won't repeat it again"],            // shape-confirm
    ["app-credentials","designed to be handed to me"],        // rungs-1-2 reassurance (scam-moment fix)
    ["app-credentials","The setup program is the guide now"], // wizard handoff
    ["app-credentials","npm run setup"],                      // rung-3 wizard launch
    ["app-credentials","will not contain it"],                // secret-file pre-brief
    ["developer-app",  "leave it as-is"],
    ["developer-app",  "that's their sign-in check"],         // 2FA wall
    ["developer-app",  "Reveal (eye) toggle"],                // reveal beat, main path
    ["get-project",    "between eight and ten"],              // dialog range
    ["get-project",    "of about 9"],                         // countdown format
    ["node-install",   "press Cmd+Space, type Terminal"],     // Terminal opener
    ["nickname",       "I'll call this login main"],          // n=1 auto-pick
    ["save-login",     "including the long code"],            // auth-code pre-brief
    ["save-login",     "Which business is this for"],         // exit-6 labels-only relay
    ["save-login",     "the code lives minutes"],             // run-add-login-now rule
    ["install-config", "you never edit a file by hand"],
    ["install-config", "access keys for other connectors"],   // disclosure
    ["install-config", "select all, paste over everything, press Cmd+S"],
    ["install-config", "Want me to ask again?"],              // re-ask script
    ["migrate-legacy", "one-time key"],                       // plain-English gate
    ["restart",        "Our conversation is saved"],
    ["restart",        "open this same chat"],                // restored spec beat
    ["restart",        "paste the same kickoff prompt"],      // rung-3 failure line
    ["choose-claude",  "Dock"],                               // visual cue
    ["choose-claude",  "claude.ai/download"],                 // actionable honest stop
    ["choose-claude",  "looks like the project README"],      // paste-mismatch script
  ];
  it("kickoff rule 4 exception + rule 6 no-transmit survive edits", () => {
    expect(KICKOFF_PROMPT).toContain("isn't supported");
    expect(KICKOFF_PROMPT).toContain("transmits my token files");
  });
  for (const [id, phrase] of M)
    it(`${id} carries "${phrase}"`, () => expect(allText(step(id))).toContain(phrase));
  it("kickoff: six rules, pinned URL, heading+last-line quote-back", () => {
    expect(KICKOFF_PROMPT).toContain("https://github.com/kanjidoc/FreshBooks-MCP");
    for (const n of [1,2,3,4,5,6]) expect(KICKOFF_PROMPT).toMatch(new RegExp(`^${n}\\.`, "m"));
    expect(KICKOFF_PROMPT).toContain("quote back to me its opening heading and its final line");
  });
  it("secrets rules + self-test + sidebar", () => {
    expect(SECRETS_RULES.rows.map(r => r.credential)).toEqual(
      ["Client ID + Secret","Authorization code","Access/refresh tokens"]);
    expect(SECRETS_RULES.selfTest).toContain("asking permission to run things");
    expect(SIDEBAR_TEXT).toContain("copy button");
  });
});
```

- [ ] **Step 3: Run — FAIL** (module missing)
- [ ] **Step 4: Implement** from Appendix A + the cited spec sections. No fs imports; `check()` uses `ctx.exists!`.
- [ ] **Step 5: PASS + `npm run build` + full suite green** → **Step 6: Commit** — `feat: the Book — setup flow as data with persona-string manifest`

### Task 2: Typed errors in `src/migrate.ts`

As plan v1, with two corrections: opts type is `{ onSameAccount?: "warn" | "refuse" }` (no `distinctLogin` — spec v3.2), and the message-compat evidence is `test/migrate.test.ts`'s regexes (`/already exists/i`, `/refresh token/i`) plus the display at `scripts/setup.ts:471`; the frozen strings are `src/migrate.ts:186` and `:201`.

- [ ] Steps 1–5 as v1 (failing test → implement → suite → commit `feat: typed ProfileWriteError codes on the profile-write guards`).

### Task 3: `markDistinctLogin`

As plan v1 (fresh `readdirSync` scan — required by spec §Typed errors, NOT `getRegistry()`; the requirement itself is spec §Typed errors, historical trace Appendix B row RA-F4). Tests unchanged from v1 (group marking, discovery un-quarantine, idempotence, `.env.pending` decoy untouched).

- [ ] Steps 1–5 as v1; commit `feat: markDistinctLogin — group-wide quarantine opt-in helper`.

### Task 4: Core extraction — `scripts/setup-core.ts`

As plan v1, plus two additions the review demanded:

```ts
export function buildTokenClient(clientId: string, clientSecret: string,
  redirectUri: string, accessToken: string, refreshToken: string): Client;
// buildOAuthClient + assign client.accessToken/client.refreshToken (the
// src/freshbooks-client.ts:201 assignment pattern) — the blessed way T8/T9/T10
// build a Client on a staged pair. NOTE: Memberships.businessId is a STRING
// here (env-file serialization form); the server-side contract uses number —
// deliberate, commented.
export function assertNoForeignDuplicate(profilesDir: string, name: string,
  refreshToken: string): void;
// throws ProfileWriteError("DUPLICATE_TOKEN") if any OTHER profiles/*.env
// (endsWith(".env") filter — pendings invisible) carries refreshToken.
// Used by --reauth (T10).
export function replaceProfileTokens(profilePath: string, accessToken: string,
  refreshToken: string): void;
// applyTokensToEnv + writeAtomic + readTokenMarkers verify, AND — per spec
// §Security precedence — rmSync(`${profilePath}.rescue`, {force:true}) after a
// verified write. (T13's test f asserts this here.)
```

- [ ] Steps as v1 (stub-based tests incl. the `discoverMemberships` mapping test and `replaceProfileTokens` fixture; `vi.mock("../scripts/setup-core")` path form in later tasks). Commit `refactor: extract non-interactive setup core (behavior-identical)`.

### Task 5: Phase-1 docs + PR 1

As v1 (CLAUDE.md carve-out + tree) **plus** a CHANGELOG `## [Unreleased]` entry for PR 1 ("internal: setup flow extracted into a data-driven core; no behavior change"). Commit `docs: CLAUDE.md carve-out + changelog; open PR 1`.

---

# Phase 2 — PR 2: headless + agent path + security

### Task 6: Pending-file ops + `.gitignore`

As plan v1 (`PendingRecord {mode, stagedAt, accessToken, refreshToken}`; plain `writeFileSync(..., {mode:0o600})`, no bak/tmp; serialization = the two dotenv token lines + `# mode=` + `# staged=` comments, parseable by `parseProfileConfig` since only the two tokens are required, `src/profiles.ts:79`). Gitignore test follows the house precedent: `git check-ignore` subprocess on `profiles/x.env.pending` and `.env.rescue` (see `test/gitignore.test.ts`). Commit `feat: staged-pending ops + gitignore coverage for *.pending/*.rescue`.

### Task 7: Dispatcher + `SetupPaths` ctx + `--init` + `--auth-url`

**Files:** Create `scripts/setup-headless.ts`; Modify `scripts/setup.ts` (top of `main()`: `if (process.argv.includes("--headless")) { process.exitCode = await runHeadless(process.argv.slice(2)); return; }` — never `process.exit()`, which can truncate piped `--json` stdout before it flushes); Test `test/headless-init.test.ts`

**Interfaces (Produces):**

```ts
export interface SetupPaths {           // EVERY verb resolves paths through this —
  rootDir: string;                      // the injectable test seam (never the
  baseEnvPath: string;                  // developer's real files). Defaults:
  profilesDir: string;                  // repo root / .env / profiles/ /
  desktopConfigPath: string;            // resolveDesktopConfigPath() / .mcp.json
  mcpJsonPath: string;
  claudeJsonPath: string;               // default os.homedir()/.claude.json — the
                                        // doctor's Code user-scope check (T12)
}
export function defaultPaths(): SetupPaths;
export const EXIT = { OK:0, FAIL:1, USAGE:2, CODE_REJECTED:3, NAME_TAKEN:4, DUP_PAIR:5,
  BUSINESS_CHOICE:6, PRECONDITION:7, SAME_ACCOUNT:8, UNMIGRATED:9, INSTALL_FAILED:10,
  DISCOVERY_FAILED:11, REAUTH_MISMATCH:12 } as const;
export interface Emit { json: boolean }
export function emitOk(e: Emit, verb: string, fields: Record<string, unknown>): void;
export function emitErr(e: Emit, verb: string, exitCode: number, stepId: string,
  symptom: string, fix: string, message: string, extra?: Record<string, unknown>): void;
export async function runHeadless(argv: string[], paths?: SetupPaths): Promise<number>;
```

**Dispatcher-level preconditions (run before ANY verb):** if
`paths.baseEnvPath` exists, contains a non-empty `FRESHBOOKS_REFRESH_TOKEN=`
line (regex from `scripts/setup.ts:249`) and `!isMigrated(content)` →
`emitErr(..., EXIT.UNMIGRATED, "migrate-legacy", ...)` — **every verb refuses
on an unmigrated legacy `.env`** (spec: "headless verbs refuse", plural), not
just `--init`.

`--init`: `--client-id` + exactly one secret source. `--client-secret-file F`:
read the first line, trim, then **immediately `rmSync(F)` in a `finally`**
(unconditional; loud `console.error` + `EXIT.FAIL` if the rm throws) — the
spec-v3.2 read-once-then-delete choreography. `--client-secret-stdin`: one
line from stdin, trimmed. `--client-secret X`: stderr warning. Then
`writeEnvFile`-equivalent against `paths.baseEnvPath` with
`buildBaseEnvVars(id, secret, REDIRECT_URI, isMigrated(existing))`, mode 0600.
`--auth-url`: parseable base env required (else PRECONDITION, stepId
`app-credentials`); prints `{url}`; never opens a browser.

- [ ] **Step 1: failing tests** (tmp-dir `SetupPaths` fixtures; run via `runHeadless([...], paths)` capturing streams): init happy path; marker preservation; **legacy fixture → exit 9 for `--init` AND `--auth-url` AND `--add-login`**; secret-file shredded on success and on failure (failure forced via read-only `baseEnvPath` parent dir); argv-secret warns; auth-url exit 7; JSON envelope shapes; no secret in any stream.
- [ ] **Steps 2–4** → **Step 5: Commit** — `feat: headless dispatcher with injectable paths; --init and --auth-url`

### Task 8: `--add-login` — callback form, clean path

As plan v1, with the review's corrections stated plainly:
- **Save-opts rule:** every save on an UNCONFIRMED path passes
  `{ onSameAccount: "refuse" }`; ONLY the `--distinct-login
  --confirm-different-user` resume passes `{ onSameAccount: "warn" }` (and
  then calls `markDistinctLogin(paths.profilesDir, savedConfig.accountId)`).
- A thrown `ProfileWriteError("SAME_ACCOUNT")` at save → the exit-8 path
  **keeping the pending**.
- Clients on staged pairs via `buildTokenClient` (T4).
- [ ] Steps as v1 (stubbed core; assert exchange-not-called on exit 4; nothing staged on exit 3; pending survives a crashed save). Commit `feat: --add-login clean path with stage-before-discovery`.

### Task 9: `--add-login` — branches, resumes, short-circuit

As plan v1's contract, plus the review's rules — all normative:
- **Mode gate:** a resume (`--name` without `--callback-url`) first loads the
  pending and **requires `mode === "add"`**; a `mode:"reauth"` pending →
  USAGE 2 naming `--reauth --name N` (and vice-versa in T10). This closes the
  cross-verb shred hazard.
- **Mixed flags:** `--callback-url` combined with any resume-only flag
  (`--business-id`/`--account-id`/`--distinct-login`/`--confirm-different-user`)
  → USAGE 2.
- **Bare resume** re-runs discovery on the staged pair; **clean discovery
  proceeds to save → exit 0** (that is exit-11's recovery working); branch
  conditions re-emit their exits. The confirmed distinct-login resume
  **bypasses** the discover-stage same-account check (else branch 1 is
  unreachable) — the save-stage guard still runs with `"warn"`.
- **Pre-discovery short-circuit** (before everything, incl. the staged
  refresh): same-named profile exists AND its refresh token equals the
  pending's → shred, exit 0, no API call.
- **Expired staged access token** (decode via `decodeJwtExp`; refresh when
  `exp - now < 60`): refresh via `buildTokenClient(...).refreshAccessToken()`,
  then **immediately re-`stagePending` the rotated pair** before discovery;
  refresh failure → exit 3 with the discard-and-re-auth fix text.
- Exit-6/8/11 `symptom`/`fix` strings: from the Book (`save-login`
  troubleshooting, Appendix A). The exit-8 question and directive live as
  named exports in `src/setup-flow.ts` — `EXIT8_QUESTION` /
  `EXIT8_DIRECTIVE` (spec §"Exit 8, fully drafted", verbatim) — referenced by
  the `save-login` step's agentGuidance and **imported** by
  `setup-headless.ts`; tests assert the payload fields **strictly equal** the
  exports.
- [ ] **Step 1: failing tests — one per contract row (~17)** incl. the mode
  gate, mixed-flag rejection, clean-bare-resume-to-exit-0, and
  rotated-pair-rewrite (assert the pending file's tokens changed before the
  discovery stub ran).
- [ ] **Steps 2–4** → **Commit** — `feat: --add-login branches, mode-gated resume grammar, crash-idempotent short-circuit`

### Task 10: `--reauth` + `--discard-pending`

As plan v1, plus: mode gate (`mode:"reauth"` pendings only, mirror of T9);
the rescue shred lives inside `replaceProfileTokens` (T4), not the verb
handler; quarantine-persists sentence in the success output when the profile
is quarantined (string from Appendix A `save-login`/reauth troubleshooting);
`assertNoForeignDuplicate` before the replace; exit-12 keeps the pending; the
`.server.lock` warning text from the Book (`restart`-adjacent string, spec
§verb table verbatim).
- [ ] Steps as v1 + mode-gate test. Commit `feat: --reauth with set-containment + staging; --discard-pending`.

### Task 11: `--install` + `--print-config`

As plan v1, with the review's corrections:
- Path injection: `installDesktop(paths, commandPath?)` etc. — **no
  `CLAUDE_DESKTOP_CONFIG_PATH` env var**; tests pass a tmp `SetupPaths`.
- Targets: `desktop | code | mcp-json | both` (spec verb table — `mcp-json`
  writes only the project `.mcp.json`; `code` = CLI-if-present else mcp-json +
  the open-this-folder script; `both` = desktop + code, **one JSON object per
  target, one per line**).
- `selectCommandPath({ trustExecPath, override })`: override → it; trustExecPath
  → `process.execPath`; else probe `/opt/homebrew/bin/node`,
  `/usr/local/bin/node`, `/usr/bin/node`; else `"node"` + caveat. Flags
  `--command-path`/`--trust-exec-path` (both in HEADLESS_VERBS, T1).
- `--print-config <target>`: same selection rule; **never reads the existing
  config** (structural read-only claim); exit 0 payload
  `{target, path, configBlock}`.
- [ ] Steps as v1 (tmp fixtures; foreign-entry byte-preservation; invalid-JSON
  → exit 10 + block; `fs.readFileSync` spy scoped to the config-file paths, proving print-config reads no existing config — the dispatcher's exit-9 precondition legitimately reads `baseEnvPath` first).
  Commit `feat: --install/--print-config with command selection and exit-10 payloads`.

### Task 12: `--doctor`

As plan v1, with: `runDoctor(paths: SetupPaths)`; the fixture matrix gains
**malformed profile** (parse-fail file) per spec §Testing; the rescue-file
check flags **any** lingering `.rescue` (not only undecodable ones) and its
fix text names the force command (`npm run refresh-tokens -- --profile <n>`)
plus the self-heal note (a JWT-fresh file pair defers adoption up to ~10
minutes); the
`~/.claude.json` check's definition: a resolvable entry =
`mcpServers.freshbooks` object whose `command` is non-empty and whose `args[0]`
exists on disk (best-effort read of `paths.claudeJsonPath`); **content assertions** for the two agent-critical fix
texts (sandbox hypothesis; two-cause command warn) — verbatim from the Book
strings (Appendix A `verify` troubleshooting). Zero profiles → fail(stepId
`save-login`), exit 1.
- [ ] Steps as v1 + the added fixtures/assertions. Commit `feat: --doctor with Book-keyed checks`.

### Task 13: Security hardening — 0600 + rescue lifecycle

**Files:** Modify `src/atomic-write.ts`, `src/freshbooks-client.ts`; Test `test/rescue-lifecycle.test.ts`

**Interfaces (fully specified control flow — the review found the v1 sketch
contradicted its own test):**

```ts
// src/freshbooks-client.ts
export function decodeJwtIat(token: string): number | null;   // NEW — same shape as
  // decodeJwtExp (src/freshbooks-client.ts:31-41) but reads payload.iat
function rescuePathFor(filePath: string): string;             // `${filePath}.rescue`
function writeRescue(filePath: string, access: string, refresh: string): boolean;
  // two dotenv token lines (parseProfileConfig-compatible), writeFileSync mode 0600
function tryAdoptRescue(profile: ProfileState): boolean;      // returns adopted?
  // Called in refreshAndPersist AFTER preflightEnvFile (:183) and after
  // getOrCreateClient (:184 — it mutates client.*), BEFORE the U3 read (:194).
  // If rescue exists:
  //   iatR = decodeJwtIat(rescue.access);
  //   iatD = decodeJwtIat(readTokenMarkers(profile.filePath).access ?? "")
  //   — compare against the ON-DISK token, NEVER profile.config: in the
  //     same-process persist-failure case A10 (:164-165) already synced config
  //     to the rescue pair, so a config comparison reads "equal" and would
  //     shred the rescue while the DISK still holds the revoked pair — the
  //     exact lockout the rescue exists to prevent.
  //   — either undecodable → DO NOT adopt, DO NOT shred; console.error warning
  //     (doctor keeps flagging it; fail closed)
  //   — iatR <= iatD → superseded: rmSync rescue + warning; return false
  //   — iatR > iatD → adopt BOTH halves: applyTokensToEnv+writeAtomic+readTokenMarkers
  //     verify into profile.filePath, THEN profile.config.* AND client.accessToken/
  //     refreshToken = rescue pair (hand-rolled — do NOT recurse into persistTokens),
  //     rmSync rescue; return true. Write failure: keep rescue, throw (loud).
// refreshAndPersist flow change:
//   const adopted = tryAdoptRescue(profile);
//   if (adopted && isTokenFresh(profile.config.accessToken, bufferSeconds)) {
//     console.error(`[freshbooks] adopted rescue pair for "${profile.name}"; skipping refresh`);
//     return;                                    // the post-adoption early return —
//   }                                            // without it the U3 gate no longer
//                                                // fires and rotation would run anyway
//   … existing U3 read + rotation (a stale adopted pair correctly falls through
//   and rotates WITH the adopted refresh token — the overnight-restart case)
// persistTokens SUCCESS path: rmSync(rescuePathFor(profile.filePath), {force:true})
//   — the spec's every-guarded-write-shreds-rescue rule (replaceProfileTokens
//   carries it for reauth, T4).
// persistTokens FAILURE path: writeRescue first; print ONLY the path; the full-token
//   stderr print ONLY when writeRescue returned false (existing text kept).
```

`writeAtomic`: `writeFileSync(tmp, content, { mode: 0o600 })` + best-effort
`chmodSync(bak, 0o600)`. `scripts/setup.ts` `writeEnvFile`: mode 0600.

- [ ] **Step 1: failing tests** — (a) persist-failure creates `.rescue`
  (fixture: **a directory squatting at `<filePath>.tmp`** so `writeAtomic`'s
  rename fails while the rescue write, at a different name, succeeds), stderr
  has the path and NO tokens; (b) persist-failure AND rescue-write failure
  (squat both `.tmp` and `.rescue`) → sanctioned loud print (tokens present —
  the ONE allowed leak); (c) fresh rescue (iat now vs −1 day) → adoption:
  file+config+client hold the rescue pair, rescue gone, `refreshAccessToken`
  stub NOT called; (d) stale rescue (older iat) → shredded, warning, no adopt,
  rotation proceeds; (e) undecodable-iat rescue → kept, warned, not adopted;
  (f) `replaceProfileTokens` shreds a rescue (direct core-function test);
  (g) `persistTokens` success shreds a lingering rescue; (h) tmp/bak modes
  0600 (skip win32); (i) adopted-but-stale pair → rotation runs WITH the
  adopted refresh token (`refreshAccessToken()` takes no args — assert
  `client.refreshToken` equals the adopted token at stub call time).
- [ ] **Steps 2–4** → **Commit** — `feat: rescue-file lifecycle (adopt-newer, shred-superseded) + 0600 credential writes`

### Task 14: Token-hygiene sweep

As plan v1, plus the explicit note: the refresh CLIs' hygiene is already
covered by `test/refresh-tokens-redaction.test.ts` (landed `4f607fd`) — this
suite covers every `setup-headless` verb (success + failure fixtures + doctor
matrix + the `config.data` canary rejection) and asserts zero exceptions (the
sanctioned loud print is asserted in T13 test b only). Commit
`test: token-hygiene sweep across every headless verb`.

### Task 15: `renderSetupStepMd` + help topic

As plan v1, with the review's corrections: `renderSetupStepMd(step)` renders
with `DOC_CTX` (T1) and — per spec Enforcement rule (b) — for docs-surface
steps emits BOTH capability-keyed role headings, and for `app-credentials`
embeds the `SECRETS_RULES` rows table AND `selfTest` line in the block;
`appliesIf` steps open with the "shows this step only if" line. Topic-index
test exclusions (feasibility review): `renderIndexTopic()` must list every
enum topic EXCEPT `index`; the overview closing list must list every topic
except `index` and `overview` — this fails today for `reports` (the fix) and
after this task both lists include `setup`. Commit
`feat: help setup topic + renderSetupStepMd; fix overview topic-list omission`.

### Task 16: Docs generation + README/SETUP.md agent path + drift tests

**Files:** Create `scripts/generate-setup-docs.ts`, `test/setup-flow-docs.test.ts`; Modify `README.md`, `SETUP.md`, `test/doc-inventory.test.ts`

- **The generation workflow (review demanded one):**
  `scripts/generate-setup-docs.ts` — ts-node script importing `SETUP_FLOW` +
  `renderSetupStepMd`; for each docs-surface step, replaces the region between
  `<!-- setup-step:<id> BEGIN -->` and `<!-- setup-step:<id> END -->` in
  SETUP.md (region = the lines strictly between the marker lines; markers each
  on their own line; region ends with exactly one trailing newline). Run it
  after every Book edit; the drift test verifies the committed result by
  calling the SAME renderer — no hand-pasting ever.
- README: `KICKOFF_PROMPT` in a fenced block; directly below it the
  expected-heading line (drift test: the quoted heading **equals SETUP.md's
  first `#` line**, read live by the test — rot-proof against T19's rewrite)
  and `SIDEBAR_TEXT` (containment-tested).
- SETUP.md: fences per docs-surface step (generated); appendix retitled
  **"Appendix — manual setup (humans only)"** with the drift-tested literal
  gate sentence *"Installing agents must never use this section — it handles
  raw tokens."* scoped to the token-exchange section (the manual config blocks
  render inside the `install-config` fence via the Book, T1); the sentinel
  line `— end of setup guide —` last; the tool total stated exactly once in
  `doc-tool-count`'s matchable form; **a link to README's kickoff prompt
  instead of a duplicate**.
- Drift tests (full list): fence-pairs ↔ ids both directions + order;
  byte-equality per region via the renderer; docPhrases in-region; README
  contains KICKOFF_PROMPT + SIDEBAR_TEXT, and the line immediately following
  the kickoff code fence matches `Claude's first reply should quote: "<H>"`
  where `<H>` == SETUP.md's live first `#` line (anchored, not bare
  containment); **SETUP.md does NOT contain KICKOFF_PROMPT** (link, not
  duplicate); sentinel last line; gate sentence present; scoped verb sweep
  (fenced regions only; allowlist = `FOREIGN_FLAG_ALLOWLIST`, the same export
  T1 uses); doc-inventory split (SETUP.md → no-unregistered-names class).
- [ ] **Steps: write tests (FAIL) → write generator → generate + author framing prose → green (incl. doc-tool-count) → Commit** — `docs: generated agent-path SETUP.md + README kickoff; drift tests + generator` → CHANGELOG entry → **Open PR 2**.

---

# Phase 3 — PR 3: wizard + human path

### Task 17: `formatPrompt` + `renderChecklist`

As plan v1; note per review: `renderChecklist` takes `doneIds` computed by the
wizard from each step's `check(ctx)` (single-sourcing — the wizard never
re-implements a check that exists on the Book step). Commit
`feat: prompt formatter + append-only checklist renderer`.

### Task 18: Wizard re-render — orchestrator with injected I/O

**Files:** Modify `scripts/setup.ts`; Test extend `test/wizard-render.test.ts`

The review (human-outcomes F2) requires the wizard's SEQUENCING to be
machine-verified. Restructure `main()` into
`runWizard(io: { ask(q: string): Promise<string>; out(line: string): void }, paths: SetupPaths)`
— the real `main()` wires readline + console; tests drive `runWizard` with a
scripted `ask` stub and capture `out` calls in order. The flow (spec Surface
1): migration gate (Book `migrate-legacy` text) → credentials (Book
`app-credentials` humanScript incl. the never-into-this-chat line at the
prompt) → per-login loop: nickname (motivated, availability pre-checked) →
auth URL + **just-in-time checklist printed AT the paste prompt** →
`validateCallbackPaste` loop (hint on scheme-less paste) → save (same-account
confirm → `markDistinctLogin`) → summary → checklist reprint → base env →
build (STEP 4 kept) → install prompts (STEP 5 kept) → **restart parting note
rendered from the Book, printed last**. No raw stacks: the top-level catch
prints message + the failing step's troubleshooting pointer.

- [ ] **Step 1: failing transcript-order tests:**

```ts
const t = await runScripted([...answers]);       // helper: runWizard with stubs, returns out[] joined
const idx = (s: string) => { const i = t.indexOf(s);
  expect(i, `missing: ${s}`).toBeGreaterThanOrEqual(0); return i; };  // no vacuous −1 ordering
// All asserted strings are Book/Appendix-A-owned (wizard prompt literals
// "Name this login", "Paste the full address here", "DONE!" are drafted in
// Appendix A) except the auth-URL prefix, which is stub-owned:
expect(idx("Name this login")).toBeLessThan(idx("https://auth.freshbooks.com"));
expect(idx("CAN'T BE REACHED")).toBeGreaterThan(idx("https://auth.freshbooks.com"));
expect(idx("CAN'T BE REACHED")).toBeLessThan(idx("Paste the full address here"));
expect(t).toContain("never into this chat");
expect(idx("Our conversation is saved")).toBeGreaterThan(idx("DONE!"));
expect(t).toContain("That was only part of the address");   // validator hint (canonical form)
// no-raw-stack: a run whose stubbed core throws prints the step's
// troubleshooting fix and no stack frames:
expect(tFailing).not.toMatch(/^\s+at /m);
```

- [ ] **Steps 2–4** (implement reorder; stubs make the OAuth/core calls fake via `vi.mock`) → **Commit** — `feat: wizard rendered from the Book with transcript-order tests`

### Task 19: Human-path docs + honesty + full drift + probe

As plan v1, plus content pins (human-outcomes F7): `test/setup-flow-docs.test.ts`
gains substring asserts for the two honesty sentences ("15 minutes if Claude
can run commands", "35–40") in SETUP.md's framing prose; the account-ID probe
records into the Book's `save-login` troubleshooting (replacing Appendix A's
recorded interim sentence) and regenerates the fences. Commit
`docs: human-path SETUP.md, honesty pins, probed account-ID pointer`.

### Task 20: Release hygiene

As plan v1 (CHANGELOG complete; full suite; **Open PR 3**; no version bump).

---

## Appendix A — Book content (the canonical strings this plan owns)

Rules: text in quotes is **verbatim Book content** — copy exactly. Items
marked *(spec §X)* are NOT restated here — copy them verbatim from that spec
section. `PROBE:` markers are filled by T1 Step 1 (never guessed) — **probe
completed 2026-08-06; no `PROBE:` marker remains, and the Book carries the
observed portal content.** Each step lists: Title · humanScript (H) ·
agentGuidance (A) · successCheck (SC) · docPhrases (DP) · troubleshooting (TR).

**choose-claude** — Title: "Which Claude will you use?"
H: "Do you open Claude as its own app from your Dock or taskbar, or in a browser tab?" · "If you chat at claude.ai in a browser tab: this server runs on your computer, and a browser-only Claude isn't supported for chatting with it. Download the Claude desktop app from claude.ai/download, then come back and continue from here — this guide gets you ready for it."
A: Ask the target question exactly; never infer the target from your own runtime. If the answer is claude.ai-web, deliver the isn't-supported script honestly (kickoff rule 4's exception). If the user pastes SETUP.md instead of you fetching it, confirm the paste by quoting its opening heading and final line — and if you received the wrong file say: "that looks like the project README — I need the file called SETUP.md; on the repository page click it, then use the copy button."
SC: "You know which Claude the server will be installed into."
DP: ["Dock", "isn't supported", "looks like the project README"]
TR: symptom "Claude can't read the web" → fix: the README sidebar text *(spec §Enforcement — SIDEBAR_TEXT)*.

**get-project** — Title: "Get the project onto the computer"
H: "Download: on the repository page click Code → Download ZIP, unzip it, and remember where the folder is. Mac tip: to point Terminal at it later, type cd, then a space, then drag the folder onto the Terminal window — then press Enter. Windows: type cd, a space, paste the folder's path from the Explorer address bar, then press Enter."
A: "I'll ask your approval between eight and ten times during this install — each time, I'll tell you first what the dialog will say and why it's safe." (state this BEFORE the first command; number every later pre-brief "approval N of about 9"; if the degraded path adds dialogs, say so and restate the remaining count). Fetch without git: `mkdir FreshBooks-MCP && curl -L https://github.com/kanjidoc/FreshBooks-MCP/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 -C FreshBooks-MCP`. Re-extracting over an existing folder is credential-safe (`.env`/`profiles/` are not in the tarball).
SC: "A folder containing package.json exists." check(): `ctx.exists(projectDir + "/package.json")`, detail "package.json present/missing at <project folder>".
DP: ["between eight and ten", "drag the folder onto the Terminal window"]
TR: "git asks to install developer tools" → "You don't need git — use the download command above (or the ZIP)."

**node-install** — Title: "Install Node.js (the engine)"
H: "Open Terminal: press Cmd+Space, type Terminal, press Enter (Windows: open the Start menu, type cmd, press Enter)." · "First check: type `node --version` and press Enter. If it prints a version of 18 or higher, skip the rest of this step. If it says command not found — that's the expected answer, not something broken; it just means Node isn't installed yet." · "Install: go to nodejs.org, click the big LTS button, open the downloaded file, and keep clicking Continue. Your Mac will ask for your password — that's the normal installer, not me. Then check again."
A: Run the check yourself where you can; relay the install steps verbatim and wait. (No `check()` — this step's check is the raw command; the doctor's node check is deliberately independent.)
SC: "`node --version` prints v18 or higher."
DP: ["that's the expected answer", "that's the normal installer, not me"]
TR: "still command not found after installing" → "Close the Terminal window completely and open a new one — it reads the new installation only on startup."

**npm-install** — Title: "Install the building blocks and build"
H: "In the project folder run: `npm install && npm run build` — one command, a few minutes. Near the end npm may print a line about vulnerabilities; that's a routine npm notice, not a problem with your setup."
A: One pre-briefed approval for the combined command.
SC: "It ends without red ERR lines; a dist folder now exists." check(): `ctx.exists(projectDir+"/node_modules")`, detail "node_modules present/missing".
DP: ["routine npm notice"]
TR: "Cannot find module 'ts-node'... MODULE_NOT_FOUND" → "npm install hasn't run (or didn't finish) in this folder — run `npm install` and retry."

**build** — Title: "Build the server"
H: "If you ran the combined command above, this already happened. Otherwise: `npm run build`."
A: Normally folded into npm-install's combined command.
SC: "dist/index.js exists." check(): `ctx.exists(projectDir+"/dist/index.js")`, detail "dist/index.js present/missing".
DP: [] · TR: "Cannot find module .../dist/index.js" → "Run `npm run build` in the project folder."

**developer-app** — Title: "Create your FreshBooks app connection"
H: "Sign in at freshbooks.com with your normal FreshBooks email — if FreshBooks emails you a code, that's their sign-in check, not part of this setup." · "Open the Developer Portal: my.freshbooks.com/#/developer, click Create New App." · "Application name: My Claude Connection — the name doesn't matter." · "The form asks for an Application Type — choose Private App (\"Not listed in the app store\")." · "The Description box is optional (140 characters max) — any short sentence works, try: Lets me manage my own FreshBooks from Claude." · "Scopes control what your connection can reach. The form starts with user:profile:read already added; click Add Scope and add every scope that starts with user: — one at a time, 46 more. It is a few minutes of clicking, one time, and it is what lets every FreshBooks feature work from chat." · "Set the Redirect URI to exactly: https://localhost/callback — then read it back to yourself character by character." · "Any field these steps don't mention: leave it as-is." · "After saving, the page shows your Client ID and Client Secret. The Client Secret is hidden behind a Reveal (eye) toggle — click it before copying." · "Already created this app once? Open it instead of creating another — click the Reveal (eye) toggle, and confirm the Redirect URI is still exactly https://localhost/callback." · "Keep this page open — the next step needs both values." (portal form observed live 2026-08-06)
A: Relay one numbered item at a time; wait for confirmation each time.
SC: "The app page shows a Client ID and a revealed Client Secret, and the Redirect URI reads exactly https://localhost/callback."
DP: ["leave it as-is", "that's their sign-in check", "https://localhost/callback"]
TR: "the form shows something these steps don't mention" → "Read any red text to Claude first, then the labels of the boxes you're asked to fill, top to bottom — skip menus and banners."

**app-credentials** — Title: "Hand over the app credentials"
H (rung-3 variant): "In the same Terminal window type `npm run setup` and press Enter — the setup program starts and asks its questions right there." · "Copy the Client ID and Client Secret from the portal page and paste these only into the setup window — never into this chat." · (the secrets table): *(spec §Secrets — SECRETS_RULES rows, self-test, honesty notes, and the secret-file choreography paragraph as amended in v3.2)*
A (rungs 1–2): The reassurance line, delivered at exactly the paste prompt: "The portal tells you to keep this secret — correct. This is the one credential designed to be handed to me: I'll pass it straight to the setup program, never repeat it, and it can't touch your books by itself." Then the secret-file pre-brief: "one longer command; your secret is read from a scratch file the setup program deletes itself — the dialog will not contain it." Confirm receipt by shape, never echo: "that looks right — about 32 characters — I won't repeat it again." If the user volunteers the secret in chat on rung 3: acknowledge, never repeat it, and offer rotation — before the credentials are entered into the setup program, rotate freely; after, rotate and then redo this step. Rung-3 wizard handoff (this is the first wizard-owned stretch): "The setup program is the guide now — follow its questions; I'll stand by until it prints DONE! or something surprises you." Never pre-narrate the wizard's prompts.
SC: "The setup program (or --init) reports the credentials saved."
DP: ["never into this chat", "I won't repeat it again", "The setup program is the guide now"]
TR: "pasted value much shorter than ~32 characters" → "The paste truncated — reveal the secret again and copy the whole value."

**migrate-legacy** — Title: "Move an older single-login setup into a named profile"
H: "You have tokens from an older version of this project stored in the main .env file; the setup moves them into their own profile file, keeping everything you had." · "Before saying yes: fully quit Claude (and any other program running this FreshBooks server). Here's why, in plain terms: FreshBooks hands out a one-time key that gets swapped for a new one every time it's used. If two programs hold the same key and both try to use it, FreshBooks locks the whole chain and you'd have to reconnect from scratch. Quitting first makes sure only the setup holds the key." · "Answering no just skips the move for now — nothing is deleted."
A: Headless verbs refuse this state (exit 9); tell the user to run `npm run setup`, wait for their confirmation, then resume with `--doctor`.
SC: "The wizard prints Migrated existing tokens → profiles/<name>.env."
DP: ["one-time key", "nothing is deleted"]
TR: "migration says a server appears to be running" → "Something still holds the tokens — fully quit Claude Desktop (Cmd+Q) and any Claude Code sessions, then re-run `npm run setup`."

**nickname** — Title: "Name this login"
H: "Pick a short nickname for this FreshBooks login — lowercase letters and digits, like acme. From then on, when you have more than one login, you'll use it in chat: 'list unpaid invoices for acme'. With a single login you'll never need to type it."
A: First login: choose `main` yourself and inform ("I'll call this login main — you'd only ever type it if you add a second account"); ask only when profiles already exist. Validate + check availability BEFORE issuing the auth URL.
SC: "The name is accepted (no already-exists message)."
DP: [] · TR: "name already taken" → "That login may already be connected — ask Claude to run the setup doctor, and to reconnect it if needed."

**authorize** — Title: "Sign in and approve the connection"
H: "1. Open the sign-in link the setup program just printed — copy it into your browser (or hold Cmd and double-click it). 2. Sign in (use a private/incognito window if connecting a second account) and click Allow. 3. Your browser will land on a page that CAN'T BE REACHED — that's normal and means it worked. The address bar now holds a one-time code. 4. Click once inside the address bar so the whole address highlights, press Cmd+C (Ctrl+C on Windows), and paste it back."
A: Issue `--auth-url` only after the nickname is validated; never open a browser yourself. After relaying the checklist, add (rungs 1–2 only — an approval dialog follows the paste there): "After you paste, stay with me — I need one more approval from you within a minute or two."
SC: "You pasted a long address starting with https://localhost/callback?code=..."
DP: ["CAN'T BE REACHED", "Click once inside the address bar", "stay with me"]
TR: "Closed the tab before copying?" → "Click the sign-in link again and re-Allow — no harm done." · "the wizard says the address looks incomplete" → "That was only part of the address — click once in the address bar so the whole thing highlights, then copy again."

**save-login** — Title: "Save the login"
A: Run `--add-login` immediately upon receiving the pasted address — the code lives minutes. Pre-brief its approval dialog: "the dialog will show the address you just pasted, including the long code — that's expected; it works only once and only with this approval." If it asks which business (exit 6): relay labels only, numbered, never IDs — "Which business is this for: (1) …, (2) …?" — and map the answer to `--business-id` yourself. If it reports the company is already connected (exit 8): relay the question exactly *(spec §"Exit 8, fully drafted")* and obey its directive.
H: "The setup finds this login's account details and saves them into its own profile file."
SC: "It prints the login's nickname, company, and account ID (never tokens)."
DP: ["including the long code", "Which business is this for", "the code lives minutes"]
TR: "exit 11 / could not look up the account details" → "Retry first — lookups usually fail transiently. If it keeps failing, ask Claude to run the setup doctor." *(T19's probe appends the where-to-find-your-Account-ID sentence here — user-safe interim text ships until then.)* · "quarantined profile mentioned" → "Two profiles share one company; the extra safety stays on until the duplicate is resolved — the doctor explains which file to remove or mark."

**install-config** — Title: "Connect the server to your Claude"
H + A: *(spec §"The install-config choreography" — ALL of it verbatim: the pre-brief, the range/countdown rules, the extended re-ask script, the disclosure line, the two-branch merge protocol, the self-contained insertion script, the rung-2 mandatory confirmation incl. absent-entry-means-virtualized)* plus H: the manual Desktop and Code config JSON blocks (current content of SETUP.md's manual sections, updated paths — these render inside this fence and are the degraded path's raw material).
SC: "Claude's config lists the freshbooks server (the install prints the exact file path it wrote)."
DP: ["you never edit a file by hand", "access keys for other connectors", "select all, paste over everything, press Cmd+S", "Want me to ask again?", "changes nothing on disk"]
TR: "Edit Config opened a folder window, not an editor" → "That's right — double-click the highlighted file and it opens in TextEdit."

**verify** — Title: "Check everything"
H: "Ask Claude to run the setup doctor — or in Terminal, from the project folder: `npx ts-node scripts/setup.ts --headless --doctor`. Every line should say pass."
A: Run `--doctor`; read failing checks' fix texts aloud; act only within them.
SC: "Doctor exits with all checks passing."
DP: []
TR: "config entry missing but a previous session said install succeeded" → "The write was virtualized by the sandbox — use the manual Edit Config route now; do NOT re-run --install." · "command isn't an absolute path" → "Either a legacy entry (re-run --install) or the deliberate sandbox fallback ('node') — the doctor's line says which."

**restart** — Title: "Restart Claude and say hello"
H (Desktop): "Our conversation is saved — nothing is lost when you quit. 1. Quit Claude completely: Cmd+Q, not just closing the window (Windows: quit from the system-tray icon). 2. Reopen it and open this same chat. 3. The first time a FreshBooks tool runs you'll see one more permission dialog — Allow it. 4. Type: List my recent FreshBooks invoices." (Code): "Start a new session in this folder; if asked to enable the freshbooks server, say yes; then type: List my recent FreshBooks invoices."
A: Deliver the ENTIRE parting note before the user restarts (your session may end with it). Failure lines, per rung — rung 2: "open a new chat in this folder and paste: Run the FreshBooks setup doctor and follow SETUP.md's troubleshooting for whatever it reports." · rung 3: "open a new chat, paste the same kickoff prompt you started with, and add: The install finished but the test failed after restart."
SC: "Claude lists your invoices."
DP: ["Our conversation is saved", "open this same chat", "paste the same kickoff prompt", "Cmd+Q"]
TR: "no FreshBooks tools after restart" → "Make sure you fully quit (Cmd+Q) — then check the doctor; its config check names the file and path to inspect."

**Wizard prompt literals — a standalone Appendix A section, not part of the restart step (owned here; T18's transcript test asserts them):**
the nickname prompt prints the step title "Name this login"; the paste prompt
is "Paste the full address here (it starts with https://localhost/callback):";
the completion banner is "DONE!". Windows note for `install-config`'s
insertion script: the Mac string is canonical and pinned; the rendered block
appends "(Windows: the file opens in Notepad — select all, paste, Ctrl+S)".

---

## Self-review (v2)

- **Spec coverage re-check:** the 13 round-1 fidelity gaps each landed: SECRETS_RULES-in-block (T15 + T16 tests), plural exit-9 (T7 dispatcher), mcp-json target (T11), general rescue-shred (T13 persistTokens-success + T4 replaceProfileTokens), exit-6 relay + immediately (Appendix A save-login + T1 manifest), sidebar drift (T16), kickoff link-not-duplicate (T16), malformed fixture (T12), quarantine-persists (T10 + Appendix A), exit-11 fix text (Appendix A), PR-1 CHANGELOG (T5), refresh-CLI hygiene note (T14), wizard no-raw-stack (T18).
- **Reconciliations:** all three landed in spec v3.2; `--trust-exec-path` in HEADLESS_VERBS (T1); env-var override replaced by `SetupPaths` (T7/T11/T12); citation labels fixed (T3, T14 now cite §Typed errors / §Security hardening "Hygiene tests" + §Testing).
- **Placeholder scan:** the three deliberation residues are flattened; the only `PROBE:` markers are in Appendix A `developer-app` with an owning, blocking probe step (T1 Step 1) — a specified data-collection step, not a placeholder; the exit-11 pointer carries drafted interim text with its PR-3 replacement step (T19). *(Both probes have since completed — developer-app 2026-08-06, the account-ID pointer 2026-08-07 — and both now ship as observed text; no `PROBE:` marker and no interim text remains.)*
- **Type consistency:** `SECRETS_RULES` shape is `{rows, selfTest, honestyNotes}` everywhere; `tryAdoptRescue` returns boolean matching its flow and tests; `runHeadless(argv, paths?)` threading matches T12's `runDoctor(paths)` and T10's lock check; file-structure task labels corrected.
