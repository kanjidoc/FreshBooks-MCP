# Setup Rework spec v2 — Round-2 review findings (6 agents, 2026-08-06)

Review of spec **v2** (commit `8fe50d0`) by: architecture verifier, security
verifier, disposition auditor, installing-agent simulator, and re-runs of both
personas (Dana rung 3, Marcus rung 2). Each read the round-1 archive and
verified against source, blind to each other.

## SESSION STATE — PARKED (read this first on resume)

- **Done:** v1 spec (`a19bd81`) → round-1 review (71 findings, archived) →
  live token-leak fix (`4f607fd`) → v2 rewrite with full disposition table
  (`8fe50d0`) → this round-2 review (archived below).
- **Scoreboard:** all four round-1 verdict-holders now say
  **yes-with-listed-fixes** (none said that about v1). Round-1 blockers all
  verified closed; every v2 file:line citation independently confirmed
  accurate; disposition audit: 71/71 rows present, 60 VERIFIED, 9 PARTIAL,
  2 MISLABELED, 0 MISSING. Dana: "meaningfully better." Marcus: ~36–38
  touchpoints (was ~42), abandonment points 2 → 1 conditional.
- **Remaining work is concentrated in four zones** (see the v3 worklist at
  the end of this file): (1) `--reauth` shipped without the staging/lock
  discipline v2 invented for `--add-login`; (2) the rescue/pending credential
  files got mechanics but not lifecycles; (3) the deny-twice and
  virtualized-sandbox branches of `install-config` can still strand a
  by-the-book agent; (4) render/schema seams (per-rung secrets text,
  byte-equality vs interpolation, wizard build step, exit-11 resume loop).
- **Next steps on resume:** write v3 against the worklist (same method:
  verify-while-writing, update Appendix A with round-2 IDs) → commit →
  round-3 TARGETED verify (arch+security on the four zones; short
  ergonomics re-sim of the two install-config branches; personas only if
  their steps changed materially) → consolidated final report to Tony.
- **Nothing is implemented yet** — PRs 1–3 remain unstarted by design; the
  only landed code is `4f607fd`.

---

## Agent R2-A — Architecture verifier

**RA-F1. MAJOR — `--reauth` re-imports the burned-code bug.** Staging is
specified only for `--add-login`; `--reauth` has the same exchange→discover
shape with no staging, no discovery-failure exit, no resume form. A
`users.me()` blip after exchange drops the minted pair. Fix: same
`.env.pending` staging + resume form (verify-accountId runs off the staged
pair), or an explicit ruling that reauth discovery failure = fresh auth, with
the asymmetry justified; exit-table row either way.

**RA-F2. MAJOR — `--reauth` vs a running server is unspecified.** The U3
adopt guard (`src/freshbooks-client.ts:194-210`) rescues the common case, but
(a) if the re-authed access token has itself expired when the server next
refreshes, `isTokenFresh` fails and the server rotates its OLD in-memory
family, silently overwriting the re-auth via `persistTokens`; (b) TOCTOU
between adopt-read and persist-write. Migration refuses under a live lock for
the same class (`src/migrate.ts:104-110`); reauth states no lock discipline.
Fix: state the ruling — check `.server.lock` (warn/refuse) or document
reliance on U3 + the stale-adopt revert window + "restart the server after
re-auth" in humanScript/troubleshooting.

**RA-F3. MAJOR — Crash between save and shred-pending = specified dead-end
loop.** Resume then exits 4 (name taken) forever while doctor's remedy is the
resume command. Also falsifies exit 4's "no code spent" on the resume path.
Fix: mirror `runMigration`'s U10 (`src/migrate.ts:127-139`): pending pair ==
saved same-name profile's pair → save already done: shred, exit 0.

**RA-F4. MINOR — `markDistinctLogin` enumeration unspecified; a
`getRegistry()`-based implementation regresses A1** (memoized snapshot misses
the just-written file → it gets quarantined). Fix: fresh directory scan at
call time, run after the new profile lands, idempotent per the `:156` regex,
verified via `readTokenMarkers`; note the legacy base-`.env` profile can never
be a group member (exists only when `profiles/` is empty).

**RA-F5. MINOR — A5 over-claimed: doctor's zero-profiles semantics still
unstated** (and `check-tokens` uses exit 2 for it, colliding with setup's
usage-error 2). Fix: zero profiles = failing/warning check keyed to
`save-login`, exit 1, never 2.

**RA-F6. MINOR — Verb-token sweep false-fails on legitimate foreign flags**
(`--profile`, `--scope`, `--version` are in SETUP.md today and the rewrite
keeps them). Fix: scope the sweep to setup fenced regions or a data-driven
allowlist.

**RA-F7. MINOR — Exit 5's gloss describes a path that can't occur** (a fresh
exchange mints a fresh token; already-connected is detected by exit 8
pre-save). Keep the guard as defense-in-depth; reword the row; let exit 8
carry the "already connected?" framing.

**RA-F8. MINOR — Undefined states:** resume with a `--name` that has no
pending (define exit 2 + list existing pendings); the pending's writer (if
writeAtomic, shred must remove `.pending.bak`/`.pending.tmp`); resume with an
expired staged access token (refresh via staged refresh token, or exit 11 —
say which).

**RA-F9. NIT — Doctor's command-resolvable check false-passes legacy bare
`"node"` entries** (resolves in doctor's shell, not the GUI context). Treat
non-absolute `command` as warn → "re-run `--install`".

**RA-F10. NIT — stdin temp-file location unspecified** — mandate a gitignored
path.

**RA-F11. NIT — Exit 7's `node_modules` leg is unreachable** (ts-node can't
start without it). Reword to `.env`/build; MODULE_NOT_FOUND troubleshooting
owns the rest.

**Citation audit: every v2 file:line citation verified accurate; no drift.**
PR 1 verified genuinely behavior-identical as specced (message-compat typed
errors, warn-default opts, unused marker helper, preserved re-exports;
`discoverMemberships` can keep the wizard prompt sequence verbatim; the
Client-construction carve-out is correctly identified). RESOLVED: A1 (modulo
RA-F4's implementation note), A2/E1/C1 (for `--add-login` — fully), A3, A4,
A6, A7, A8, S2/E7/C2, C5/S3/E3/M-F5; A5 partial; C3 resolved-as-verb,
reopened as RA-F1/F2. **Verdict: yes-with-listed-fixes; nothing rises to
blocker; no design change required — spec text only.**

## Agent R2-S — Security verifier

**RS-F1. HIGH — The legacy `default` profile's rescue file lands at repo root
as `.env.rescue`, which is NOT gitignored** (`filePath` for the legacy profile
IS the base `.env`, `src/profiles.ts:203-213`; `.gitignore` matches `.env`,
`*.bak`, `*.tmp` — nothing matches `.rescue`). Live tokens in a committable
root path, created on the flow's worst day. Fix: add `*.rescue` (and
`*.pending` for depth) to `.gitignore` in the PR that introduces the writer;
spec says so.

**RS-F2. HIGH — Rescue file has no lifecycle; the next server start burns the
rescue pair.** After a rescue write the profile file still holds the revoked
pair; restart → `ensureFreshTokens` rotates with the revoked refresh token →
family revocation can destroy the rescue pair too. Rescue-first is quieter
than the scream it replaces, making unattended restart-before-recovery MORE
likely. Doctor never checks `.rescue`; no deletion owner. Fix:
preflight/refresh fails closed — or auto-adopts — when `<filePath>.rescue`
exists (retry the rescue pair's write; shred on verified success); doctor
check (age + fix); named deletion owner.

**RS-F3. MEDIUM-HIGH — The per-rung secrets rule cannot be represented by the
Book schema; rendered SETUP.md will carry only the rung-3 half**
(`renderSetupStepMd` emits humanScript but not agentGuidance; an obedient
rung-2 agent reads a byte-tested doc instructing the OPPOSITE of its designed
flow — the scam-moment contradiction recreated at the doc layer). Fix: render
both labeled variants into the generated block ("If Claude is driving… / If
you are doing every step by hand…") — include agentGuidance for docs-surface
steps or add a per-rung field; move the secrets table into Book data so drift
tests cover it.

**RS-F4. MEDIUM — Pending pair's true lifetime is unbounded and unstated**
(refresh tokens don't expire until used/revoked; a pending abandoned under a
retried different name lingers forever). Fix: staleness threshold (warn
>24h), `--discard-pending --name N`, doctor fix text offers
discard-and-fresh-auth, honest note that discard doesn't revoke server-side.

**RS-F5. MEDIUM — Pending overwrite via the writeAtomic ceremony would strand
a live pair in `.pending.bak`.** Fix: pendings are plain 0600 `writeFileSync`
with no bak/tmp ceremony, or the shred removes the siblings.

**RS-F6. MEDIUM — Exit-8 payload hands the agent the ready-to-paste bypass
incantation next to the MUST-NOT sentence; the negative branch is
unscripted; the residual is unstated.** Fix: drop the ready-to-paste resume
command from the machine payload (keep in SETUP.md troubleshooting for
humans); one honest sentence (norm, not mechanism — raises the cost of
reflexive compliance, cannot stop a noncompliant agent; wrong confirmation
un-quarantines a possibly superseded family); script the "No" branch (shred
pending, point at `--reauth`).

**RS-F7. LOW-MEDIUM — stdin temp-file choreography underspecified and its
headline claim overstated** (file tools can't create 0600 atomically; failed
delete leaves the secret at rest, undetected; the file-write tool displays the
content into the transcript anyway). Fix: canonical gitignored path
(`<projectDir>/.client-secret.tmp` — covered by `*.tmp`); prefer
`--client-secret-file <path>` where the CLI reads-uses-shreds and
delete-failure is a loud CLI error; doctor knows the canonical name; reword
the claim ("never in argv/ps/history; appears once in the file-write — same
exposure class as the user's own paste").

**RS-F8. LOW — S7 wording: the tmp must be CREATED 0600**
(`writeFileSync(tmp, content, {mode:0o600})`) — rename preserves the tmp's
mode; a chmod-after leaves a window.

**RS-F9. LOW — Honesty note tense** — the durable transcript residue is the
app-credential pair; one sentence on its long-term weight (converts a future
token-file leak into full API access; enables a convincing re-consent phish).

**RS-F10. NOTE — `--json` payload sweep: clean.** Add one hygiene fixture
whose stubbed exchange-rejection error embeds a canary in `config.data` to
prove the allowlist projection drops it.

RESOLVED: S2, S3, S4, S5 (as designed; RS-F1/F2 are the machinery's own new
holes), S6 (as designed; RS-F6 residual), S7 (RS-F8 nit), S8, S10; S1 = PR 0;
S9 present verbatim. **Verdict: yes-with-listed-fixes; RS-F1, RS-F2, RS-F3
must fold in before PR 2.**

## Agent R2-D — Disposition auditor

Archive contains **71** findings (not 61); Appendix A has exactly 71 rows in
order — **nothing silently dropped**. Counts: **60 VERIFIED · 9 PARTIAL ·
2 MISLABELED · 0 MISSING.**

Non-VERIFIED rows (each fixable with a sentence or two): **A4** (no repetition
marker — add `repeats?: "per-login"` to nickname/authorize/save-login);
**A5** (zero-profiles semantics — exit 1, never 2, failing `save-login`
check); **S6** (MUST-NOT rule relocated to payload silently; agentGuidance
should repeat it); **S8** (exit 5's dropped-grant consequence unacknowledged);
**C11** (the spec body itself still labels only Surfaces 1–2 — the guided-docs
surface needs its `Surface 3` heading or the numbering dropped); **P7**
(Windows path-copy equivalent dropped); **M-F1** (merge choreography's
two-branch protocol missing; "appendix adopts it" claimed but absent from the
body); **M-F4** (truncated-secret-paste troubleshooting row absent); **M-F10**
(in-flow dialog-count statement unscripted); **M-F7 MISLABELED** (closed-tab
"no harm done" row claimed, absent); **M-F9 MISLABELED** ("agent runs
--add-login immediately" claimed, absent).

New contradictions v2 introduced: **N1 HIGH** — "resume forms re-run
discovery" defeats the exit-11 escape hatch (the `--account-id` resume exists
BECAUSE discovery fails; must skip discovery — IDs are the user's assertion).
**N2 MED-HIGH** — `build` isn't a `wizard`-surface step but today's wizard
builds (`scripts/setup.ts:568-579`); either add `wizard` to build's surfaces
or state the wizard no longer builds and docs cover it. **N3 MED** —
byte-equality vs interpolation: `renderSetupStepMd` must render the
documentation ctx (symbolic placeholders; redirectUri constant); only
wizard/headless interpolate live values. **N4 MED** — install-config says
"target from choose-claude" but choose-claude never runs on the wizard
surface; wizard asks its own STEP-5 questions. **N5 MED** — doctor's printed
resume command is underivable (branch flag depends on which exit staged);
define the bare resume: `--add-login --name N` alone re-runs discovery on the
staged pair and re-emits the branch exit. **N6 LOW-MED** — `who` docstring
overclaims ("human" = essential action performed by a human by capability OR
recorded policy; may still carry supporting verbs). **N7 LOW** — exit-8 JSON
extras omit the promised MUST-NOT directive field. **N8 LOW** — exit 7's
`node_modules` leg unreachable (= RA-F11). **N9 LOW** — exit 5's gloss
outstrips its detector (= RA-F7); also specify `--reauth` for multi-business
(set-containment) and blank stored accountId (skip with warning). **N10
LOW** — "the approval dialog never displays the secret" claims one win too
many (the file-write's own rendering shows it; net exposure unchanged).

**Verdict: yes-with-listed-gaps; fix N1/N2 before PR 1 freezes the schema.**

## Agent R2-E — Installing-agent simulator

**R2-1. BLOCKER — Deny→degrade has no lawful source for the config block;
the appendix gate creates a catch-22.** A denied dialog means the writer
never ran — no exit-10 payload exists; the only in-Book manual config block
lives in the appendix the agent is forbidden to use; kickoff rule 5 forbids
inventing it. Verbatim-stuck. Also the merge choreography (confirmed-empty →
full file; else user pastes current contents, agent returns merged whole) was
compressed out. Fix: (a) a read-only `--print-config <target>` verb emitting
the exit-10 payload shape at exit 0, named in the deny branch; (b) scope the
appendix gate to the token-exchange section only (or move config blocks
inside the `install-config` fenced region); (c) spell the two-branch merge
script in the step.

**R2-2. BLOCKER — Silent sandbox virtualization is now an infinite loop.**
Path+mtime is self-confirming inside the same overlay; "when a sandbox is
suspected" has no test; the cross-session cycle is doctor→re-run
install→virtualized again, forever. Fix: on rung 2 the Edit-Config visual
confirmation after `--install desktop` is MANDATORY, not suspicion-gated;
doctor's missing-config fix text carries the sandbox hypothesis ("if a prior
session reported success, the write was virtualized — use the manual route,
do NOT re-run --install").

**R2-3. MAJOR — `process.execPath` written from inside a sandbox poisons the
host config** (sandbox-private node path; doctor's resolvability check
resolves inside the same sandbox — false pass). Fix: define rung-2 command
selection (probe standard host paths / `--command-path` override from user-
read `command -v node` / fall back to `"node"` with caveat); state execPath
must not be trusted when possibly sandboxed.

**R2-4. MAJOR — `--reauth` breaks for the two-business login and re-imports
the burned-grant class** (accountId-equality undefined against a membership
LIST → membership[0] false exit 12 → unbreakable loop; no staging/resume; exit
11's "(pending staged)" is false for reauth). Fix: set-containment matching;
same staging + resume symmetry (or documented accepted burn with scripted
fresh-auth recovery).

**R2-5. MAJOR — Exit 8's verbatim question is never drafted; ambiguous
replies have no standard; the negative branches are untaught** (wrong
business → resume with corrected `--business-id` — permitted by the grammar,
never stated; wrong login → incognito re-auth, new exchange overwrites the
pending — mechanics-only, not agent-facing; no clean abandon without an
improvised rm). Fix: draft the question in the Book (plain words, yes/no-able);
ambiguity rule ("anything short of a clear yes is a no — re-ask once, then
--doctor"); three-branch recovery in the exit-8 row; optional
`--discard-pending`.

**R2-6. MAJOR — Save/shred crash livelock** (= RA-F3; adds: resume hitting
NAME_TAKEN with a DIFFERENT token needs its own mapping — exit-5 semantics).

**R2-7. MODERATE — `--install code` is two writers with no selection rule;
"both" unhandled; doctor's config check has no target notion.** Fix: encode
the wizard's decision tree (`scripts/setup.ts:595-608`) — CLI present → user
scope, else mcp-json + "open this folder" script; "both" → invoke per target;
doctor reports per-location info, fails only when NO location carries a
resolvable entry.

**R2-8. MODERATE — get-project leaves projectDir undefined** (tarball
extracts to `kanjidoc-FreshBooks-MCP-<sha>/`; `{{projectDir}}` feeds
everything incl. the re-entry incantation). Fix: literal URL, expected
extracted name, canonical location/rename (`tar xz --strip-components=1` into
a named dir), a `check()` asserting `package.json`, and a note that
re-extraction is credential-safe (`.env`/`profiles/` not in the tarball).

**R2-9. MODERATE — `who:"human"` on node-install contradicts kickoff rule 3
for the check half; the first three steps sit outside `check()` machinery**
(no verb runs pre-npm-install). Fix: `who` governs the ACTION, checks always
agent-runnable; bless the raw bootstrap commands in the Book.

**R2-10. MINOR — Restart step is target-dependent** (Cmd+Q/reopen is Desktop;
Code = new session + `.mcp.json` enable prompt; re-entry line presumes a
folder-scoped chat). Per-target variants via interpolation or appliesIf.

**R2-11. MINOR — Choreography holes:** stdin framing (single line, trim
newline), shell-quoting `--callback-url` (contains `?code=`), whether
`--json` is per-verb flag or default — verb table shows no example
invocations.

**R2-12. MINOR — No "I already have a developer app" branch** (reuse: open
app, reveal secret, confirm redirect URI unchanged — one paragraph).

**R2-13. MINOR — Exit 11's human fallback missing the "where do I find my
account ID" pointer; stale staged access token heals on first startup refresh
— tell the agent so it doesn't misread the state.**

RESOLVED: E1, E3, E4, E5, E6, E7, E9, E10, E11 (8 outright + E11-as-adopted);
E2 partial (R2-2/R2-3), E8 partial (R2-1). **Verdict: yes-with-listed-fixes;
rung 1 completes by the book once R2-4..R2-8 land; rung 2's deny-twice and
virtualized branches are today a hard no (R2-1, R2-2) — both fixable with
spec text plus one small read-only verb.**

## Agent R2-P3 — Dana re-run (rung 3)

**DA-F1. BLOCKER (conditional: web fetch off/fails) — The paste-SETUP.md
fallback is load-bearing and unscripted** (she'll Cmd+A the rendered README,
not SETUP.md; nobody teaches the file click + copy button; Claude working
blind can't catch the substitution). Fix: a drift-tested three-line sidebar
in README under the kickoff ("click the file named SETUP.md, press the copy
button — two overlapping squares — paste here") + a Book fallback script:
Claude confirms the paste by quoting its opening heading AND final line,
naming the mismatch if it got the README.

**DA-F2. MAJOR — Rule 1's heading-quote has no verifier and proves only the
head of the file** (fabrication passes; truncated fetch quotes the real
heading while missing the troubleshooting table and restart script). Fix:
README prints "Claude's first reply should quote: <heading>" beside the
kickoff (drift-tested); SETUP.md gains a drift-tested final sentinel line;
rule 1 asks for opening heading + last line.

**DA-F3. MAJOR — Rule 5's escape hatch is unscoped on large screens**
("read me exactly what you see" is unanswerable on a portal dashboard). Fix:
scoping lives in each step's troubleshooting fix text — developer-app's:
"read any red text first, then the labels of the boxes you're asked to fill,
top to bottom — skip menus and banners."

**DA-F4. MAJOR — The restart failure re-entry line is rung-2-shaped; rung 3's
aftermath is a dead end** (no folders, no acting agent, no kickoff rules in
the fresh chat). Fix: per-rung failure line; rung 3's variant: "open a new
chat, paste the same kickoff prompt you started with, and add: 'The install
finished but the test failed after restart.'" — rule 1 re-anchors the new
session; the doctor becomes a dictated Terminal command.

**DA-F5. MAJOR — choose-claude phrasing unspecified; the claude.ai-web answer
collides with kickoff rule 4** (forbidden from saying it can't be done — an
unresolvable loop for an unsupported target). Fix: docPhrases with visual
cues ("own app from your Dock, or in a browser tab?") + a scripted honest
stop; rule 4 gains "…unless SETUP.md itself says your setup isn't supported."

**DA-F6. MINOR — Kickoff rule 2 vs the single-narrator handoff** (a literal
Claude keeps interjecting between wizard prompts). Fix: handoff docPhrase —
"while the setup program is asking you questions, it is the guide"; make the
wizard-handoff step one that SETUP.md marks as hers, so rule 2 delegates
cleanly.

**DA-F7. MINOR — Fetched-doc vs on-screen wizard skew** (chat-Claude
pre-narrates `appliesIf` steps her wizard never shows). Fix: conditional
steps' generated blocks open with "The setup program shows this step only
if…"; agentGuidance: never pre-narrate the wizard's prompts.

**DA-F8. MINOR — Volunteered-secret rotation offer is unordered** (rotating
after `.env` is written breaks refresh). Fix: before credentials are entered,
rotate freely; after, rotate then redo the credentials step.

**DA-F9. NIT — Rung-3 command consolidation unspecified** (npm install/build:
one Terminal trip or two — pick one).

RESOLVED: P4, P6, P7, P8 fully; P1, P3, P5, P9 fixed-with-named-residual;
P2 structurally addressed but conditional (DA-F1/F2). **Verdict: yes — works,
meaningfully better; v2 placed a pre-written sentence at nearly every
formerly-unannounced moment; remaining pain concentrates at the two seams v2
itself created (read-the-book ritual, post-restart failure re-entry).**

## Agent R2-P2 — Marcus re-run (rung 2)

**M2-F1. MAJOR — Degraded config path: the COMPLETE file has no specified
source and the Edit-Config door is mis-modeled** (it reveals the file in
Finder — not a paste target; the double-click-into-TextEdit beat is
unscripted; merge input needs a second outside-folder permission or the
user-pastes-current-contents choreography, which v2 compressed out — a
synthesized "complete" file silently wipes existing MCP entries). Fix: script
the full degraded choreography in agentGuidance (read-only peek pre-briefed
as "changes nothing"; Finder-reveal sentence; select-all paste-over; Cmd+S);
humanScript + docPhrases carry the beats; appendix adopts them.

**M2-F2. MAJOR — The upfront dialog count is claimed fixed but anchored
nowhere in the body — and the honest floor is 9–10, not 8** (a dialog past
the promised number lands near the scariest write and detonates trust). Fix:
anchor a RANGE ("between eight and ten") in the first pre-brief's docPhrase;
number each dialog ("approval 5 of about 9"); promote install+build combining
and single-dialog stdin to the default agent path.

**M2-F3. MAJOR — The re-ask-once line names the benefit of allowing but not
the cost of denying** (~60/40 flip). Fix: extend the script verbatim — open
non-judgmentally, bound the alternative ("I'll walk you through pasting one
file in Claude's Settings screen instead — about five extra minutes. Or
approve once and I do it in five seconds. Want me to ask again?").

**M2-F4. MINOR — stdin choreography is single-dialog only if the Book blesses
the exact compound** (file tools can't chmod; naive = three dialogs):
`chmod 600 f && cat f | npx ts-node scripts/setup.ts --headless --init
--client-id <id> --client-secret-stdin; rm -f f` — cleanup unconditional;
pre-brief "the dialog will not contain your secret."

**M2-F5. MINOR — The auth code appears inside the `--add-login` approval
dialog un-pre-briefed** (the flow trained "secrets never appear in dialogs").
Fix: one docPhrased pre-brief sentence ("the dialog will show the address you
pasted including the long code — expected; it works only once").

**M2-F6. MINOR — Exit 6 has a payload but no relay script** (labels only,
numbered, never IDs); exit 8's verbatim question must be beginner-answerable
("Is this a different person's FreshBooks login for the same company, or are
you reconnecting the login you already added?").

**M2-F7. MINOR — The FreshBooks login wall (password + emailed 2FA) before
the portal is unclaimed.** One humanScript line.

**M2-F8. MINOR — Tarball extraction dir unpinned** (= R2-8): Book-bless
`--strip-components=1` + a `check()`.

RESOLVED: M-F3, M-F4 (spec level), M-F5, M-F6, M-F7, M-F8, M-F9 (exceeded —
staging made every post-exchange pause free); M-F1 mostly (M2-F1 residual),
M-F2 mostly (M2-F2/F3 residuals), M-F10 partial. **Verdict: yes with three
honest asterisks now said out loud; touchpoints ~36–38 best / ~48–50 branch
(was ~42 / 55+); round-1's two probable abandonment points gone; one
conditional one remains (the degraded config path as currently specced).**

---

## v3 WORKLIST (consolidated, deduplicated — work this top to bottom)

**Blocker/High tier:**
1. `--reauth` gets the full `--add-login` discipline: staging, resume forms,
   set-containment accountId matching (multi-business), blank-accountId rule,
   live-server ruling (lock check or documented U3 reliance + restart advice),
   exit-11 symmetry. [RA-F1, RA-F2, R2-4, N9]
2. Rescue-file lifecycle: `*.rescue`/`*.pending` in `.gitignore`; preflight
   fail-closed/auto-adopt on `<file>.rescue` present; doctor check; named
   deletion owner. [RS-F1, RS-F2]
3. install-config deny/sandbox branches: `--print-config <target>` read-only
   verb; appendix gate scoped to the token-exchange section; two-branch merge
   choreography scripted (incl. Finder-reveal beat, read-only peek pre-brief,
   TextEdit select-all-paste); mandatory rung-2 Edit-Config visual
   confirmation; doctor's sandbox-hypothesis fix text; rung-2 command-path
   selection rule (no naked `process.execPath` from a sandbox). [R2-1, R2-2,
   R2-3, M2-F1, disposition M-F1]
4. Save/shred crash idempotency (U10 mirror: pending == saved profile pair →
   shred, exit 0; NAME_TAKEN with different token → defined mapping). [RA-F3,
   R2-6]
5. Per-rung secrets renderable into SETUP.md: generated blocks carry both
   labeled variants (or a per-rung field); secrets table moves into Book
   data. [RS-F3]
6. Exit-11/resume-discovery contradiction: `--account-id` resume SKIPS
   discovery; define the bare resume (`--add-login --name N` re-runs
   discovery on the staged pair, re-emits the branch exit) as doctor's
   printed command. [N1, N5]
7. Wizard build step: add `wizard` to `build`'s surfaces or state the wizard
   no longer builds. [N2]
8. Read-the-book ritual verifiers: README prints the expected heading beside
   the kickoff; SETUP.md final sentinel line; rule 1 quotes heading + last
   line; scripted paste-fallback sidebar. [DA-F1, DA-F2]

**Major tier:** exit-8 verbatim question drafted + ambiguity rule + three-
branch recovery + payload directive field + drop ready-to-paste command from
machine payload [R2-5, RS-F6, N7, M2-F6]; escape-hatch scoping via per-step
troubleshooting [DA-F3]; per-rung/per-target restart variants + rung-3
failure re-entry (re-paste the kickoff + one sentence) [DA-F4, R2-10];
choose-claude phrasing + unsupported-target honest stop + rule-4 amendment
[DA-F5]; `--install code` decision tree + "both" + doctor per-location
semantics [R2-7]; get-project pinning (URL, `--strip-components=1`, check(),
credential-safe re-extract note) [R2-8, M2-F8]; dialog-count range +
per-dialog countdown anchored in docPhrases [M2-F2, disposition M-F10];
re-ask script extension [M2-F3]; byte-equality renders the documentation ctx
[N3]; install-config target source on the wizard surface [N4]; who-semantics
sentence + bootstrap-window blessing [N6, R2-9]; pending lifecycle bounds +
`--discard-pending` + plain-writeFileSync ruling [RS-F4, RS-F5, RA-F8];
stdin: prefer `--client-secret-file` (CLI reads-uses-shreds), canonical
gitignored path, single-dialog compound blessed, honest claim rewording
[RS-F7, N10, M2-F4, RA-F10].

**Minor/nit tier:** doctor zero-profiles exit-1 rule [RA-F5, A5]; verb-sweep
scoping/allowlist [RA-F6]; exit-5 reword + dropped-grant note [RA-F7, N9,
S8]; exit-7 node_modules leg removed [RA-F11, N8]; legacy bare-"node" doctor
warn [RA-F9]; `repeats?: "per-login"` [A4]; Surface-3 heading [C11]; Windows
path-copy line [P7]; truncated-secret troubleshooting row [M-F4]; closed-tab
"no harm done" row + agent-runs-immediately sentence (the two MISLABELED
rows) [M-F7, M-F9]; auth-code-in-dialog pre-brief [M2-F5]; 2FA login-wall
line [M2-F7]; tmp created 0600 [RS-F8]; honesty-note durable-residue sentence
[RS-F9]; config.data canary fixture [RS-F10]; markDistinctLogin fresh-scan
note [RA-F4]; wizard-handoff delegation clause + no-pre-narration [DA-F6,
DA-F7]; rotation-ordering sentence [DA-F8]; rung-3 command consolidation
[DA-F9]; developer-app reuse branch [R2-12]; exit-11 account-ID-location
pointer + stale-token heal note [R2-13]; stdin framing/quoting/`--json`
default examples [R2-11]; S6 agentGuidance repetition [disposition S6].
