# Version single-source-of-truth + anti-rot — Design

- **Date:** 2026-05-22
- **Status:** Design approved; revised after multi-agent review; pending final spec review
- **Branch:** `versioning-single-source-of-truth`
- **Ships as:** `2.1.1` (patch — see Rollout)

## Problem

The version `2.1.0` is correct in `package.json` and `CHANGELOG.md`, and
`src/server.ts` already derives the MCP `initialize`-handshake version from
`package.json`. The failures are all at the edges:

- **GitHub is stale.** The git tag and GitHub Release sit at `v2.0.0`; nothing
  creates new ones. The merged PR branch was *named* `v2.1.0`, but a branch
  name is not a tag — GitHub's "latest release" tracks tags only.
- **An installed-MCP user cannot ask the version.** It exists only in the
  handshake, exposed by no tool.
- **Same-class rot, already happening.** `freshbooks_help`'s `overview` topic
  hardcodes "75 tools"; the count is also hardcoded across `README.md`,
  `SETUP.md`, `package.json`'s description, and the Claude-project prompt.
  `TOOL_AUDIT.md` already says "74 tools" — proof the rot is real.

## Goal

`package.json` → `"version"` is the single source of truth. The three
audiences — a user with the MCP installed, someone on GitHub, and the MCP
itself — all see it correctly, and it **cannot rot** because every other
appearance is *derived* or *guarded by a test*, never silently copied.

## Non-goals

- Publishing to the npm registry. This project stays clone-and-run.
- A network call from the MCP server to detect whether a newer version
  exists. The `version` topic reports the *installed* version only; Claude
  checks GitHub on demand if the user asks "am I up to date?".
- A project-local release skill. Decided against — a `CLAUDE.md` section is
  the chosen guidance mechanism.
- An executable self-update MCP tool. Decided against — updating is handed off
  as a paste-ready Claude Code prompt (see Component 2).
- Rewriting historical records. `CHANGELOG.md` entries for past releases and
  `TOOL_AUDIT.md` are point-in-time snapshots; their numbers stay frozen.

## Design

### Component 1 — `src/version.ts` (new): the single reader

One module performs the `require("../package.json")` and exports the version.
Every other module imports from it, so a hardcoded version literal has nowhere
left to live.

```typescript
// src/version.ts — the ONLY place package.json's version is read.
// `require` (not a JSON `import`): package.json sits outside tsconfig's
// rootDir (src/); an `import` would pull it into compilation and break the
// build. From dist/version.js, `../package.json` resolves to the package
// root — identical to resolving from src/ under ts-node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { version: string };

/** The server's version, straight from package.json (the single source of truth). */
export function getVersion(): string {
  return pkg.version;
}
```

`src/server.ts` is refactored to `import { getVersion } from "./version"` and
use `version: getVersion()`, dropping its own `require` and the explanatory
comment (which moves to `version.ts`). Behaviour is identical — `getVersion()`
returns exactly what the old inline `require` produced. *(Confirmed by review:
`tsconfig.json` has `rootDir: "src"` and `include: ["src/**/*"]`, so a new
`src/version.ts` compiles cleanly to `dist/version.js`; the `eslint-disable`
directive is required and already used at `server.ts:10` and
`render-tools.ts:23`.)*

`version.ts` deliberately does **not** read the tool count — it stays tiny and
free of any dependency on the tool registry. The count is handled in
Component 2.

### Component 2 — `freshbooks_help` version surface

A new `version` topic is added to the `freshbooks_help` tool.

- `src/tools/help.ts`: add `"version"` to the `topic` Zod enum, and add a
  `version` entry to the `sections` map. The map's type is already
  `Record<string, string | (() => string)>` (confirmed at `help.ts:50`), so a
  function-valued topic needs no type change — `tools` already works this way.
- `TOPIC_INDEX` (a module-local `const` in `help.ts`, not exported — confirmed)
  becomes a function: it shows the installed version on its first line and
  lists `version` among the topics.
- `src/docs/content.ts`: `TOPIC_OVERVIEW` becomes a function
  `renderOverviewTopic()`; a new `renderVersionTopic()` renders the `version`
  topic. The five topics needing neither datum (`architecture`,
  `authentication`, `extending`, `conventions`, `troubleshooting`) stay as
  static `const` strings. `help.ts` is the only importer of `content.ts`
  (confirmed) and must be updated in lockstep — the TypeScript compiler
  enforces this.

**⚠ Circular-import constraint (review finding — must follow).** `content.ts`
**cannot** add a top-level `import { allTools } from "../tool-registry"`: the
cycle `tool-registry → help.ts → content.ts` already exists, and Node's
CommonJS loader would non-deterministically return `{}` for the registry on
first load. `src/docs/render-tools.ts:24` already solves the identical problem
with a **lazy `require("../tool-registry")` inside the render function**.
`renderOverviewTopic()` and `renderVersionTopic()` MUST do the same — obtain
the tool count via a lazy `require` at call time, never a top-level import.
The version comes from a normal top-level `import { getVersion } from "../version"`
(`version.ts` has no registry dependency, so no cycle).

**`version` topic content** (exact text; `<version>` / `<count>` interpolated):

```
# FreshBooks MCP — Version

- **Installed version:** <version>
- **Registered tools:** <count>

This is the version of the FreshBooks MCP server currently running. It comes
from `package.json` — the single source of truth — so it always matches the
installed code.

## How to update

This server is installed by cloning its Git repository, so updating means
pulling the latest code and rebuilding. The reliable way is to let Claude Code
do it:

1. Open a terminal in your `FreshBooks-MCP` folder.
2. Run `claude` to start Claude Code.
3. Paste this prompt:

   > Update this FreshBooks MCP server to the latest version. Pull the latest
   > from git, run `npm install` and `npm run build`, then tell me what
   > changed (from CHANGELOG.md) and remind me to fully reload Claude Desktop.

4. When it finishes, fully quit and reopen Claude Desktop (or your MCP client)
   so it restarts the server with the new code.

Latest releases: https://github.com/kanjidoc/FreshBooks-MCP/releases
```

A paste-ready Claude Code prompt is used instead of raw shell commands so the
messy parts — a dirty working tree, merge conflicts, summarising the
changelog — are handled by a Claude that can reason about them. In Claude
Code, Claude can run those steps itself; in Claude Desktop (no shell), Claude
relays the prompt for the user to paste into a terminal.

### Component 3 — `.github/workflows/release.yml` (new): release automation

Triggers on push to `main`. Reads `package.json`'s version `V`; if tag `vV`
already exists it is a no-op (so ordinary commits never release); otherwise it
creates tag `vV` and a GitHub Release whose body is the `CHANGELOG.md` section
for `V`.

**Security & correctness** (revised per the security review — all items below
are required, not optional):

- A "safe by construction" header comment, matching `ci.yml`'s, stating: the
  version originates from in-repo `package.json` (not from any `github.event.*`
  payload) and is semver-gated before use.
- `permissions: contents: write` at the **job** level — the minimum to push a
  tag and create a Release; every other scope drops to `none`.
- The version is **validated against strict semver** (`^[0-9]+\.[0-9]+\.[0-9]+$`)
  before any use; a non-conforming or empty value aborts the run. A
  strict-semver string provably contains no shell metacharacters. (Prerelease
  suffixes like `-rc.1` are intentionally rejected — this project ships only
  final releases.)
- The version is passed to later steps via `env:` and referenced as
  `"$VERSION"` in shell — never interpolated as `${{ }}` into a `run:` body.
- `concurrency: { group: release, cancel-in-progress: false }` at the workflow
  level. **Required:** without it, two near-simultaneous pushes to `main` race
  the tag-existence check (a TOCTOU window) and both try to push tag `vV`; the
  loser fails with a red ❌ on `main` for a release that already succeeded.
  `cancel-in-progress: false` is critical — a release must never be cancelled
  mid-`git push`/`gh release create`.
- `set -euo pipefail` at the top of every multi-line `run:` block.
- Git committer identity is configured (`github-actions[bot]`) before tagging —
  a fresh runner has none, and an annotated `git tag -a` would otherwise fail.
- A comment at the `git push` step records *why* this cannot recurse: the tag
  is pushed with the default `GITHUB_TOKEN`, and GitHub suppresses workflow
  runs for `GITHUB_TOKEN`-initiated events — **do not swap in a PAT** without
  re-evaluating loop safety. (`release.yml` triggers on `push: branches`, not
  `push: tags`, so a tag push does not match it regardless.)
- Trigger is `push` to `main` only — no `pull_request`, so a PR can never cut
  a release.
- Only `actions/checkout@v4` is added (matching `ci.yml`'s pinning). `gh` is
  preinstalled on `ubuntu-latest`; no third-party release action is used. No
  `actions/setup-node` step is needed — the runner's preinstalled Node runs
  `node -p` and the `.mjs` script, which use only long-stable APIs.
- `actions/checkout` uses `fetch-depth: 0` so all tags are present for the
  existence check.
- Release notes are written to `${RUNNER_TEMP}/RELEASE_NOTES.md` (outside the
  working tree).

Changelog extraction is a tiny zero-dependency helper, `scripts/extract-changelog.mjs`:
plain ESM (not a `ts-node` script) so the workflow needs no `npm install` step.
It uses only `fs.readFileSync` and `process.argv`.

- It takes the version as `argv[2]`; a missing arg → `exit 1` with a stderr
  message.
- It locates the section by **plain-string prefix match** — a line where, after
  the leading `## [`, the text starts with `<version>]`. This tolerates the
  `## [X.Y.Z] - YYYY-MM-DD` heading format and avoids any constructed `RegExp`
  (no regex injection). The section ends at the next line beginning `## [`.
- **If the section is missing, or contains no non-whitespace content, the
  script prints a clear stderr message and `exit 1`s.** This is required: the
  extract step runs *before* `git tag`, so `set -e` aborts the whole workflow
  before any tag is pushed — preventing a published Release with blank notes.

Workflow shape:

```yaml
name: Release

# Safe by construction: the only non-fixed value is the version, which is read
# from the in-repo package.json (never from a github.event.* payload) and
# validated against strict semver before any use.

on:
  push:
    branches: [main]

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Determine version and whether it is new
        id: check
        run: |
          set -euo pipefail
          VERSION="$(node -p "require('./package.json').version")"
          if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "package.json version '$VERSION' is not strict semver — aborting." >&2
            exit 1
          fi
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          if git rev-parse "v$VERSION" >/dev/null 2>&1; then
            echo "is_new=false" >> "$GITHUB_OUTPUT"
          else
            echo "is_new=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Create tag and GitHub Release
        if: steps.check.outputs.is_new == 'true'
        env:
          VERSION: ${{ steps.check.outputs.version }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          # Extract notes FIRST — exits non-zero on a missing/empty section,
          # which aborts here (set -e) before any tag is pushed.
          node scripts/extract-changelog.mjs "$VERSION" > "${RUNNER_TEMP}/RELEASE_NOTES.md"
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git tag -a "v$VERSION" -m "v$VERSION"
          # Pushed with the default GITHUB_TOKEN — GitHub suppresses workflow
          # runs for GITHUB_TOKEN-initiated events, so this cannot recurse.
          # Do not swap in a PAT without re-evaluating loop safety.
          git push origin "v$VERSION"
          gh release create "v$VERSION" --title "v$VERSION" \
            --notes-file "${RUNNER_TEMP}/RELEASE_NOTES.md"
```

### Component 4 — CHANGELOG convention

`CHANGELOG.md` gains a permanent `## [Unreleased]` heading at the top.
Everyday PRs add bullets there. A **release is one commit** that (a) renames
`[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD` and (b) bumps `package.json`'s
`version`. Merging that commit to `main` triggers Component 3.

### Component 5 — anti-rot guardrails

- **5a — Structural.** Version and the *runtime* tool count are derived;
  surface rot is impossible there by construction.
- **5b — Version test.** `test/version.test.ts` (Vitest) reads `package.json`'s
  version *independently* via `fs` (not via `getVersion()`, so the assertion
  is not tautological) and asserts that `getVersion()`, `renderVersionTopic()`,
  and `renderOverviewTopic()` all reflect that exact string, and that the
  rendered tool count equals `allTools.length`. Mirrors the existing
  `test/load-env.test.ts` regression-guard pattern.
- **5c — Static-doc tool-count test.** `test/doc-tool-count.test.ts` (Vitest)
  scans a fixed list of human-maintained docs — `README.md`, `SETUP.md`,
  `package.json` (the `description` field), `docs/claude-project-system-prompt.md`,
  `CLAUDE.md` — for tool-count mentions and asserts every number found equals
  `allTools.length`. To stay robust it also asserts each listed file yields
  **at least one** match, so a reworded/relocated mention that escapes the
  scan fails loudly rather than silently. Today every live count is already
  `75` (correct), so this test adds no doc edits — it *locks in* correctness
  and catches the next drift. `CHANGELOG.md` and `TOOL_AUDIT.md` are excluded
  (frozen historical snapshots).
- **5d — `CLAUDE.md`.** A new "Versioning & Releases" subsection states the
  invariant (one source = `package.json`; never hardcode a version, and never
  hardcode a tool count outside the doc-count test's watched list) and
  documents the release-commit process and the auto-release workflow.

## Rollout — shipping as 2.1.1, and fixing the GitHub history

This work ships as **`2.1.1`** — a patch. Rationale: it is infrastructure
correctness, and the project's own precedent is commit `d4f06a3`
*"fix: make .env the single source of truth for OAuth tokens"*, which shipped
as the **v2.0.4 patch**. `2.1.0` already exists as a written-down (but
untagged) version, so this work is **not** folded into it — it gets its own
number.

Two steps land the change:

1. **Backfill `v2.1.0` (one-time, manual, before merging this PR).** `2.1.0`
   is the code currently installed but was never released. Confirmed: only
   `v2.0.0` exists as a tag. So, once, by hand:
   - `git tag -a v2.1.0 af79ea6 -m "v2.1.0"` (commit `af79ea6` is the 2.1.0
     merge), `git push origin v2.1.0`,
   - `gh release create v2.1.0` with notes from the existing `CHANGELOG.md`
     `[2.1.0]` section.
   This is done manually — `release.yml` only ever acts on the *current*
   `package.json` version, so it will not create `v2.1.0` itself.
2. **Merge this PR.** Its release commit sets `package.json` to `2.1.1`, adds a
   `## [2.1.1] - 2026-05-22` CHANGELOG section for this work, and adds an empty
   `## [Unreleased]` section above it. On merge, `release.yml`'s first run sees
   `2.1.1`, finds no `v2.1.1` tag, and creates the tag + Release — proving the
   workflow.

Result: a contiguous GitHub history `v2.0.0 → v2.1.0 → v2.1.1`.

## Files

| File | Change |
|---|---|
| `src/version.ts` | **new** — single reader of `package.json` version |
| `src/server.ts` | modified — use `getVersion()` |
| `src/docs/content.ts` | modified — `renderOverviewTopic()`, `renderVersionTopic()`; version via `import`, count via lazy `require` |
| `src/tools/help.ts` | modified — `version` topic in enum + sections; `TOPIC_INDEX` → function |
| `.github/workflows/release.yml` | **new** — tag + Release automation |
| `scripts/extract-changelog.mjs` | **new** — zero-dep changelog-section extractor |
| `CHANGELOG.md` | modified — add `[Unreleased]`; add `[2.1.1]` section |
| `package.json` | modified — `version` → `2.1.1` |
| `test/version.test.ts` | **new** — version + runtime-count anti-rot test |
| `test/doc-tool-count.test.ts` | **new** — static-doc tool-count anti-rot test |
| `CLAUDE.md` | modified — new "Versioning & Releases" section |

No text change is needed in `README.md`, `SETUP.md`, `package.json`'s
`description`, or `docs/claude-project-system-prompt.md` — their counts are
already correct; they become *watched* by `test/doc-tool-count.test.ts`.

## Build sequence

Each step ends with `npm run build && npm run lint && npm test` green.

1. `src/version.ts` + refactor `src/server.ts`. (Behaviour unchanged.)
2. `src/docs/content.ts` + `src/tools/help.ts` — `version` topic, dynamic
   overview/index, tool count via lazy `require`.
3. `test/version.test.ts` + `test/doc-tool-count.test.ts` — the anti-rot tests.
4. `CHANGELOG.md` (`[Unreleased]` + `[2.1.1]`) + `package.json` bump to `2.1.1`.
5. `scripts/extract-changelog.mjs` + `.github/workflows/release.yml`.
6. `CLAUDE.md` — "Versioning & Releases" section.

Then, outside the branch: backfill `v2.1.0` (Rollout step 1), then merge.

## Testing strategy

- **Unit (new):** `test/version.test.ts` and `test/doc-tool-count.test.ts` as
  in 5b/5c.
- **`scripts/extract-changelog.mjs`:** verified by a manual smoke run during
  implementation — `node scripts/extract-changelog.mjs 2.1.1` (prints the
  section) and `node scripts/extract-changelog.mjs 9.9.9` (exits non-zero).
- **Existing suite:** unchanged and must stay green — Components 1–2 are
  behaviour-preserving for every existing code path; the only runtime change
  is additive (`version` topic; dynamic-but-equal `overview` text).
- **`release.yml`:** cannot be exercised by the local suite; verified by its
  first real run on merge, which must produce the `v2.1.1` tag + Release.

## Risks & mitigations

- **`content.ts` / `help.ts` lockstep.** Converting consts to functions
  changes export shapes; `help.ts` must update together. `npm run build` is
  the gate.
- **Circular import.** Mitigated by the mandated lazy `require` for the
  registry (Component 2) — never a top-level import of `tool-registry` from
  `content.ts`.
- **Workflow misfire.** Idempotency (the `git rev-parse` check) plus the
  `concurrency` guard means a re-run, an ordinary commit, or a concurrent
  push cannot create a duplicate or spurious release.
- **Blank-notes release.** Prevented — `extract-changelog.mjs` exits non-zero
  on a missing/empty section, aborting before the tag is pushed.
- **Bad version in `package.json`.** The strict-semver gate aborts the
  workflow loudly rather than tagging garbage.
- **Doc-scan brittleness.** A reworded count that escapes the regex is caught
  by the per-file "at least one match" assertion in `test/doc-tool-count.test.ts`.
