# Setup Rework spec v3 — Round-3 targeted verification (3 agents, 2026-08-06)

Targeted verification of spec **v3** (`1815822`) — scoped to the four round-2
fix zones plus overall coherence, not a full re-review. All three verdicts:
**yes-with-fixes, zero blockers.** Every fix below is folded into **v3.1**
(same spec file; Appendix C maps them).

## Agent R3-A — Architecture verifier

Confirmed-closed: all 25 round-2 IDs in the four zones, including the two
subtle planted questions — the U10-mirror idempotent resume works despite
`writeNewProfile`'s scan-before-exists order (the dup-token scan skips the
same-name file, `src/migrate.ts:181`, so a crashed save surfaces as
NAME_TAKEN and the same-token comparison is reachable), and the reauth
live-server rationale is mechanically correct (a dead family throws before
persist; a live one is U3-adopted). Every v3-new citation verified accurate;
8/8 Appendix B spot-checks body-real.

Findings: **A-1 MAJOR** — rescue adoption as written was file-only; a rescue
older than ~12h fails `isTokenFresh` at the U3 gate and rotation then runs
with the revoked in-memory refresh token, burning the rescue family in the
exact unattended-restart case the mechanism exists for → adoption must also
set `profile.config`/client (after preflight `:183`, before the U3 read
`:194`). **A-2 MEDIUM** — the expired-staged-pair refresh rotates the staged
family but nothing wrote the rotated pair back to the pending → a later
staged exit strands a dead pair → rewrite the pending immediately. **A-3..A-6
LOW** — TOCTOU folded into the reauth warning rationale; resume entry point
made explicit (availability gate is callback-form-only); exit-5 recovery
amended for the server-rotation race (healthy profile → just
`--discard-pending`); doctor's non-absolute-command warn must not tell rung-2
users to re-run `--install` (which reproduces the deliberate `"node"`
fallback). **A-7..A-10 NIT** — citation split (`:595-602`, `:565`,
`:219-227`); exit-11 `--account-id` marked add-login-only; resume-flag
composability; `--install both --json` one-object-per-target + rescue
force-now ~10-min no-op self-heal clause.

## Agent R3-S — Security verifier

Confirmed-closed: RS-F1..RS-F10, each in the body with implementable
specificity; mode-marker lines clean (no secret material anywhere in doctor
output or JSON); exit-8 `directive` + honesty sentence present and accurate;
`--print-config` clean by construction (`buildClaudeServerConfig` is
`{command, args}`, no env block).

Findings: **N3-1 MEDIUM-HIGH** — rescue-vs-reauth precedence was unspecified:
persist-failure → user re-auths (the natural recovery) → next refresh
unconditionally adopts the STALE rescue over the fresh pair and rotates it →
the deliberate re-auth silently reverted, or a live pair overwritten by a
dead one → (1) every successful verified guarded write shreds `<file>.rescue`
as superseded; (2) adopt only when the rescue pair is NEWER than the on-disk
pair (access-token `iat` comparison), else shred-with-warning. **N3-2
MEDIUM** — the rung-2 command-selection rule was bound only to `--install`;
`--print-config` is the lawful source precisely in the sandboxed/denied case
→ same rule bound to it. **N3-3 MEDIUM** — the degraded merge protocol has
the user paste their whole Desktop config into chat; real configs carry OTHER
servers' API keys in env blocks → disclosure line, foreign-entries
byte-identical rule, never quote env values back, and state that
`--print-config` never reads the existing config. **N3-4 LOW-MED** — "If
Claude is driving" is the wrong discriminator for a rung-3 reader whose
Claude drives the conversation but can't act → capability-keyed headings +
a one-line self-test. **N3-5 LOW** — secret-file residuals: honest sentence
for the write→chmod window; unlink-and-recreate at 0600 (a plain chmod won't
fix a crash-leftover default-mode file); state run-from-`{{projectDir}}`.

## Agent R3-E — Dark-branch simulator

Five journeys under v3's kickoff rules: **deny-twice degraded install —
completes** (two scripting seams: branch-(a) lacked the insertion
choreography branch-(b) has; Edit-Config navigation from Settings →
Developer was never scripted). **Virtualized sandbox — completes** (one
seam: the rung-2 bullet needed "entry absent = virtualized → degraded path,
never re-run `--install`" stated at the confirmation moment, not only in
doctor's fix text). **Reauth — completes** (one moderate: persistent
discovery failure had no exit; RULED in v3.1 — deliberately no
`--account-id` skip for reauth, since containment IS the wrong-account
protection; retry-later / `--discard-pending` guidance instead). **Exit-8
three branches — completes** (nit: the question now offers the wrong-business
branch; directive keyed to "a clear 'different person'"). **Crash-resume —
did NOT complete as specified (the round's one MAJOR):** the U10-mirror
idempotent exit 0 sat at the save stage, but resume passes discovery first
and the just-saved profile's own accountId fires the exit-8 branch — the
promised exit 0 was unreachable, detouring through a self-referential exit-8
question and a needless full re-auth → fixed with the pre-discovery
same-pair short-circuit (equals-pending refresh token → shred, exit 0, no
API call). Confirmed-closed: R2-1, R2-2, R2-4, R2-5, M2-F1, M2-F2, M2-F3;
R2-6 confirmed only WITH the short-circuit (now in v3.1).

## Outcome

v3.1 (this same day) folds in every finding above — see the spec's
Appendix C. Convergence across rounds: 71 findings/5 blockers (v1) → 61/2
branch-blockers (v2) → ~21/0 blockers, 2 majors both in v3's own newest
machinery (v3) → all closed in v3.1. A final single-agent amendment check ran
after v3.1 (see the addendum below if present).
