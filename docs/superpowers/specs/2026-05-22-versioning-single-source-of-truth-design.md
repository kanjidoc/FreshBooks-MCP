# Version single-source-of-truth + anti-rot — Design

- **Date:** 2026-05-22
- **Status:** Design approved; pending written-spec review
- **Branch:** `versioning-single-source-of-truth`

## Problem

The version `2.1.0` is correct in `package.json` and `CHANGELOG.md`, and
`src/server.ts` already derives the MCP `initialize`-handshake version from
`package.json`. The failures are all at the edges:

- **GitHub is stale.** The git tag and GitHub Release sit at `v2.0.0`; nothing
  creates new ones. The merged PR branch was *named* `v2.1.0`, but a branch
  name is not a tag — GitHub's "latest release" tracks tags only.
- **An installed-MCP user cannot ask the version.** It exists only in the
  handshake, exposed by no tool.
- **Latent same-class rot.** `freshbooks_help`'s `overview` topic hardcodes
  "75 tools"; it silently goes wrong the moment a tool is added or removed.

## Goal

`package.json` → `"version"` is the single source of truth. The three
audiences — a user with the MCP installed, someone on GitHub, and the MCP
itself — all see it correctly, and it **cannot rot** because every other
appearance is *derived*, never *copied*.

## Non-goals

- Publishing to the npm registry. This project stays clone-and-run.
- A network call from the MCP server to detect whether a newer version
  exists. The `version` topic reports the *installed* version only; Claude
  checks GitHub on demand if the user asks "am I up to date?".
- A project-local release skill. Decided against — a `CLAUDE.md` section is
  the chosen guidance mechanism.
- An executable self-update MCP tool. Decided against — updating is handed off
  as a paste-ready Claude Code prompt (see Component 2).

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
returns exactly what the old inline `require` produced.

The tool **count** is a separate datum and is *not* read here — `version.ts`
stays tiny and free of any dependency on the tool registry. The count derives
from `allTools.length` at the point it is rendered (Component 2).

### Component 2 — `freshbooks_help` version surface

A new `version` topic is added to the `freshbooks_help` tool.

- `src/tools/help.ts`: add `"version"` to the `topic` Zod enum, and add a
  `version` entry to the `sections` map. The map's type is already
  `Record<string, string | (() => string)>`, so dynamic (function) topics need
  no type change — `tools` already works this way.
- `TOPIC_INDEX` (defined in `help.ts`) becomes a function: it shows the
  installed version on its first line and lists `version` among the topics.
- `src/docs/content.ts`: `TOPIC_OVERVIEW` becomes a function
  `renderOverviewTopic()` — the version line and the tool count are
  interpolated (count from `allTools.length`, eliminating the hardcoded
  "75 tools"). A new `renderVersionTopic()` renders the `version` topic. The
  five topics that need neither datum (`architecture`, `authentication`,
  `extending`, `conventions`, `troubleshooting`) stay as static `const`
  strings — minimal change.

**`version` topic content** (exact text, version/count interpolated):

```
# FreshBooks MCP — Version

- **Installed version:** <getVersion()>
- **Registered tools:** <allTools.length>

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
creates annotated tag `vV` and a GitHub Release whose body is the `CHANGELOG.md`
section for `V`.

Security (must preserve `ci.yml`'s "safe by construction" property):

- `permissions: contents: write` — the minimum needed to push a tag and create
  a release; nothing else.
- The version string is **validated against strict semver** (`^[0-9]+\.[0-9]+\.[0-9]+$`)
  before any use; a non-conforming value aborts the run. A strict-semver string
  provably contains no shell metacharacters.
- The version is passed to later steps via `env:`, and referenced as `"$VERSION"`
  in shell — never interpolated as `${{ }}` directly into a `run:` body.
- Trigger is `push` to `main` only — no `pull_request` trigger, so a PR can
  never cut a release.
- Only the official, already-used `actions/checkout@v4` is added (matching
  `ci.yml`'s pinning convention). `actions/checkout` uses `fetch-depth: 0` so
  all tags are present for the existence check.

Changelog extraction is a tiny zero-dependency helper, `scripts/extract-changelog.mjs`:
plain ESM (not a `ts-node` script) so the workflow needs no `npm install` step.
It takes the version as `argv[2]`, reads `CHANGELOG.md`, and prints the lines
of the `## [<version>]` section up to the next `## [`. It matches the heading
by **plain string**, not a constructed `RegExp`, to avoid regex injection.

Workflow shape:

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Determine version and whether it is new
        id: check
        run: |
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
          node scripts/extract-changelog.mjs "$VERSION" > RELEASE_NOTES.md
          git tag -a "v$VERSION" -m "v$VERSION"
          git push origin "v$VERSION"
          gh release create "v$VERSION" --title "v$VERSION" --notes-file RELEASE_NOTES.md
```

### Component 4 — CHANGELOG convention

`CHANGELOG.md` gains a permanent `## [Unreleased]` heading at the top.
Everyday PRs add bullets there. A **release is one commit** that (a) renames
`[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD` and (b) bumps `package.json`'s
`version`. Merging that commit to `main` triggers Component 3.

### Component 5 — anti-rot guardrails

- **5a — Structural.** Version and tool count are derived everywhere; surface
  rot is impossible by construction.
- **5b — Test.** `test/version.test.ts` (Vitest) reads `package.json`'s
  version *independently* via `fs` (not via `getVersion()`, so the assertion
  is not tautological) and asserts that `renderVersionTopic()` and
  `renderOverviewTopic()` both contain that exact string, and that the
  rendered tool count equals `allTools.length`. If anyone reintroduces a
  hardcoded version or count, CI (`npm test`) fails. Mirrors the existing
  `test/load-env.test.ts` regression-guard pattern.
- **5c — `CLAUDE.md`.** A new "Versioning & Releases" subsection states the
  invariant (one source = `package.json`; never hardcode a version or a tool
  count) and documents the release-commit process and the auto-release
  workflow's behaviour.

## Rollout — how this lands and fixes the current drift

`2.1.0` is in `package.json` and `CHANGELOG.md` but has **no git tag and no
GitHub Release** — it is effectively unreleased. Therefore this versioning
work folds **into 2.1.0** rather than bumping the number:

- This work's changelog bullets are added to the existing `## [2.1.0]`
  section; its date is updated to the merge date.
- A fresh empty `## [Unreleased]` section is added above it for future work.
- `package.json` stays at `2.1.0`.
- On merge to `main`, `release.yml`'s first run sees `2.1.0`, finds no
  `v2.1.0` tag, and creates the tag + Release — **fixing the current drift,
  shipping this feature, and proving the workflow in a single merge.** The
  next release will bump to `2.2.0`.

(If you would rather ship this as `2.2.0` and leave `v2.1.0` untagged forever,
that is the one rollout decision to flag at spec review.)

## Files

| File | Change |
|---|---|
| `src/version.ts` | **new** — single reader of `package.json` version |
| `src/server.ts` | modified — use `getVersion()` |
| `src/docs/content.ts` | modified — `renderOverviewTopic()`, `renderVersionTopic()`; derive version + count |
| `src/tools/help.ts` | modified — `version` topic in enum + sections; `TOPIC_INDEX` → function |
| `.github/workflows/release.yml` | **new** — tag + Release automation |
| `scripts/extract-changelog.mjs` | **new** — zero-dep changelog-section extractor |
| `CHANGELOG.md` | modified — add `[Unreleased]`; fold this work into `[2.1.0]` |
| `test/version.test.ts` | **new** — anti-rot regression test |
| `CLAUDE.md` | modified — new "Versioning & Releases" section |

## Build sequence

Each step ends with `npm run build && npm run lint && npm test` green.

1. `src/version.ts` + refactor `src/server.ts`. (Behaviour unchanged.)
2. `src/docs/content.ts` + `src/tools/help.ts` — version topic, dynamic
   overview/index, derived tool count.
3. `test/version.test.ts` — the anti-rot test.
4. `CHANGELOG.md` — `[Unreleased]` section + fold this work into `[2.1.0]`.
5. `scripts/extract-changelog.mjs` + `.github/workflows/release.yml`.
6. `CLAUDE.md` — "Versioning & Releases" section.

## Testing strategy

- **Unit (new):** `test/version.test.ts` as described in 5b.
- **Existing suite:** unchanged and must stay green — Components 1–2 are
  behaviour-preserving for every existing code path; the only runtime change
  is additive (`version` topic, dynamic-but-equal `overview` text).
- **Workflow:** `release.yml` cannot be run by the local test suite; it is
  verified by its first real run on merge (which must produce the `v2.1.0`
  tag + Release). `scripts/extract-changelog.mjs` is small and pure; a smoke
  check (`node scripts/extract-changelog.mjs 2.1.0`) is run manually during
  implementation.

## Risks & mitigations

- **`content.ts` / `help.ts` lockstep.** Converting consts to functions
  changes export shapes; `help.ts` must update together. The TypeScript
  compiler catches any mismatch — `npm run build` is the gate.
- **Workflow misfire.** Idempotency (the `git rev-parse` tag check) means a
  re-run or an ordinary commit cannot create a duplicate or spurious release.
- **Bad version in `package.json`.** The strict-semver gate aborts the
  workflow loudly rather than tagging garbage.
