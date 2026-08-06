# Setup Rework — One Book, Three Surfaces

**Date:** 2026-08-06
**Status:** Draft for review

## Problem

Three converging complaints about how this server gets installed:

1. **The wizard's phrasing confuses real users.** Diagnosed failure modes (user-confirmed):
   concepts arrive unmotivated (you name a "login" only *after* the OAuth dance, with no
   hint the name matters forever), warnings arrive before the user can act on them (the
   broken-page explanation prints three paragraphs before the paste prompt), and prompt
   mechanics are terse (`[y/N]` with unstated Enter behavior; a jargon-heavy migration gate).
2. **Agents are real installers now** — Claude Code, Claude Desktop's Cowork agent mode,
   possibly sandboxed agents. The wizard is interactive readline, which hangs or garbles in
   a non-TTY agent shell, so today SETUP.md must mark Step 6 "Claude cannot do this."
3. **The non-technical Claude Desktop user** wants to *tell Claude to install it* and do
   nothing else. They don't know what a terminal or OAuth is. Today's answer for them is
   "open Terminal for ten minutes," guided only by prose that can silently drift from what
   the wizard actually prints.

The root defect behind (1)+(3): the wizard's text and Claude's knowledge of the wizard are
maintained separately, so they drift, and neither is designed for the other.

## Decisions already made (do not re-litigate)

| Decision | Rationale |
|---|---|
| **Zero new dependencies; no TUI library** | Agents in sandboxes / non-TTY shells are first-class consumers — raw-mode TUIs break there. Flat supply chain for a project holding accounting tokens. |
| **Plain sequential text; append-only rendering** | Reprint the progress checklist at each stage boundary instead of cursor-redrawing. Same guided feel; works for humans, logs, pipes, and agents. |
| **Paste-the-broken-URL stays THE OAuth mechanism** | Decided 2026-08-06. No localhost callback catcher, no redirect-URI change. Treat like CLAUDE.md's "intentional exclusions": not a gap. Reopening this requires a live probe writeup (does FreshBooks accept `http://localhost:PORT`? is a Cowork-sandbox listener reachable from the host browser?). |
| **No screenshot-verification loops** | Rejected. Guidance is exact, by-the-book instructions only. |
| **Migration never runs headless** | The one flow where an agent-hosted live server can burn the only refresh token. It keeps its interactive human confirmation gate. |
| **Single-binary distribution is roadmap, not scope** | See Roadmap. |

## Core concept: the Book

One data module — `src/setup-flow.ts` — is the single source of truth for the setup flow,
mirroring the `REPORT_PARAMS` pattern (data + renderers + drift test):

```ts
interface SetupStep {
  id: string;                 // stable, e.g. "developer-app", "authorize", "restart"
  title: string;
  who: "human" | "agent" | "either"; // who CAN do it; agents do every "agent"/"either" step
  summary: string;            // one sentence, shown in the progress checklist
  humanScript: string[];      // exact instructions the wizard prints / Claude relays verbatim
  agentGuidance: string;      // what a driving agent should do/say for this step
  successCheck: string;       // how anyone verifies the step worked
  troubleshooting: { symptom: string; fix: string }[];
}
export const SETUP_FLOW: SetupStep[] = [ ... ];
```

Consumers — this is what "the wizard goes hand in hand with what Claude knows" means:

1. **The interactive wizard** renders its prompts, checklists, and warnings *from* the Book.
2. **The headless mode** maps verbs onto Book steps and cites step ids in errors.
3. **SETUP.md** stays hand-written prose, but `test/setup-flow-docs.test.ts` asserts every
   step's id/title and canonical phrases appear (both directions: missing AND stale) — the
   same enforcement style as `doc-tool-count.test.ts` / `doc-inventory.test.ts`.
4. **`freshbooks_help` gains a `setup` topic** rendering the Book live — so once the server
   is installed, any Claude (including Desktop, which can't read repo files) has accurate,
   current setup knowledge for add-another-account and re-auth conversations.
5. **The kickoff prompt** (below) points the installing Claude at SETUP.md, which the drift
   test keeps honest.

Troubleshooting is keyed by step id and lives in the Book; the wizard, headless errors,
SETUP.md's table, and Claude all cite the *same* entries.

## The capability ladder and the kickoff prompt

The README and SETUP.md lead with one copyable paragraph — the real entry point for the
non-technical user is a prompt, not a command. The installing Claude self-selects the
highest rung it can operate:

1. **Claude Code** → runs everything via headless mode; user does browser + restart only.
2. **Claude Desktop + Cowork (agent mode, trusted folder)** → same headless verbs; if the
   sandbox can't reach `claude_desktop_config.json`, the ladder degrades gracefully: print
   the exact config block and exact by-the-book instructions for pasting it.
3. **Claude Desktop, plain chat** → Claude cannot act; it guides the human through
   SETUP.md exactly, one step at a time, waiting for confirmation between steps.

Kickoff prompt (draft — final wording lives in README.md, drift-tested for presence):

> I want you to install the FreshBooks MCP server from
> https://github.com/kanjidoc/FreshBooks-MCP so I can manage my FreshBooks by chatting
> with you.
>
> Rules for this install:
> - Follow the project's SETUP.md exactly. It is written for you as much as for me —
>   every step says who does it (you or me) and how to verify it worked.
> - First, work out what you can actually do in this environment (run commands? create
>   files?). Do every step you can yourself. Never ask me to do something you can do.
> - The steps marked as mine (browser sign-ins, installing Node, restarting Claude) are
>   the ONLY things you may ask me to do. Give me exact clicks or exact text to type,
>   one step at a time, and wait for my confirmation.
> - Do not give up, and do not tell me it can't be done from here. If you truly cannot
>   act in this environment, your job becomes guiding me through SETUP.md step by step —
>   still exactly by the book, still one step at a time.
> - Do not improvise workarounds the book doesn't describe: no hand-editing token files,
>   no alternative install methods, no skipping verification steps. If a step fails, use
>   SETUP.md's troubleshooting for that step; if still stuck, tell me exactly which step
>   failed and what you tried.
> - Never show me my tokens or secrets in chat.

## Surface 1 — the human wizard (`npm run setup`)

Full conversational rewrite, plain `readline`, rendered from the Book:

- **Nickname before OAuth**, motivated: "You'll use it in chat forever, like *'list unpaid
  invoices for acme'*." Validated against `profiles/` up front; `writeNewProfile`'s
  duplicate-token/name guards still backstop at save time.
- **Just-in-time OAuth checklist** printed at the paste prompt (not earlier): numbered
  steps ending "your browser lands on a page that CAN'T BE REACHED — that's normal and
  means it worked. Copy the ENTIRE address and paste it here."
- **A single `prompt()` helper** so every yes/no question spells out its default —
  `(y = yes, Enter = no)` — and bare `[y/N]` can never reappear.
- **Plain-English migration gate**: what's being moved and why the server must be stopped
  ("FreshBooks hands out a one-time key; if two programs refresh it at once, your
  connection breaks and you'd reconnect from scratch"), and what each answer does.
- **Append-only progress checklist** (`✓ ✓ ▶ ○ ○` + step summaries) reprinted at each
  stage boundary; a confirmation summary after each saved login (nickname, company,
  account ID — never tokens).
- Optional color via a ~10-line internal helper honoring `isTTY` and `NO_COLOR`
  (Node 18 floor rules out `util.styleText`). Degrades to plain text.
- **Same-account detection**: if a freshly authorized login's accountId matches an existing
  profile, warn ("this looks like an account you already connected — did you mean to sign
  in as a different FreshBooks user?") and require explicit confirmation; on confirm, write
  the existing `# freshbooks-distinct-login` marker so discovery doesn't quarantine it.

## Surface 2 — headless mode (the agent surface)

`npm run setup -- --headless <verb>`; shares the extracted core; never opens a browser;
`--json` on every verb; the success path **never prints tokens** (output: nickname,
company, IDs, file path). The authorization code may transit chat (single-use,
minutes-lived, useless without the client secret); tokens may not.

| Verb | Does | Notes |
|---|---|---|
| `--init --client-id X --client-secret Y` | Writes base `.env` via `buildBaseEnvVars` | Preserves an existing `FRESHBOOKS_MIGRATED` marker |
| `--auth-url` | Prints the authorization URL | Requires `--init` first (precondition error otherwise) |
| `--add-login --name N --callback-url U [--business-id B] [--distinct-login]` | Exchange → discover IDs → save via `writeNewProfile` | Multi-business: prints memberships, exits 6; agent relays choice in chat and re-invokes |
| `--install desktop\|code\|mcp-json` | The existing config writers | |
| `--doctor` | Node version, build present, base `.env` valid, per-profile token health (JWT expiry, no API call), config entries present | One-line verdict per check; the fresh-session and "FreshBooks broke" entry point |

Exit codes: `0` success · `2` usage · `3` auth code rejected/expired (agent re-issues URL,
asks for a fresh paste) · `4` profile name taken · `5` duplicate refresh token ·
`6` business choice required · `7` precondition missing (no `.env`/build) ·
`8` same accountId as an existing profile (pass `--distinct-login` after the user confirms
they meant a different FreshBooks user; writes the quarantine opt-out marker).

Re-auth after revocation (`invalid_grant`) is the same `--add-login` verb for that profile
name — not a special ceremony. Migration verbs do not exist in headless; it errors with
instructions to run the interactive wizard.

## The Node.js prerequisite playbook

The one step even an agent can't finish (GUI installer, user's password). The Book's
`node-install` step gives: an exact check command to paste (`node --version`), then exact
nodejs.org GUI steps (download LTS → open → Next/Next/password → done), then re-check.
Claude relays these verbatim and waits.

## Docs impact

- **README.md**: kickoff prompt at the top of the install section.
- **SETUP.md**: rewritten around the Book. Step 6's 🤖 note flips from "you cannot run
  this" to "run the headless verbs; the user only signs in and pastes." Incognito-window
  tip replaces the sign-out/sign-in dance for additional accounts. Troubleshooting gains a
  beginner-worded row for the Desktop stale tool-cache (remove/restore cycle per
  CLAUDE.md) — fresh installs dodge it, re-installs don't.
- **CLAUDE.md**: the two-surface contract, the Book pattern, and a doc-maintenance entry
  for the new drift test + derived `setup` help topic.
- **Honest limitations** gains: "no agentic Claude → Claude guides, you click."

## Error handling

Neither surface ever shows a raw stack. Wizard failures print the friendly message plus
the Book step's troubleshooting entry. Headless failures print (or emit as JSON) the step
id, symptom, and fix. The kickoff prompt forbids the driving agent from improvising past
these rails.

## Testing

- Existing pure exports (`buildBaseEnvVars`, `serializeEnv`) and their tests unchanged.
- Core functions unit-tested with a stubbed token exchange.
- **Token-hygiene test**: run `--add-login` against the stub, capture stdout+stderr,
  assert no token substrings appear.
- Exit-code tests per failure mode, including 6/8 flows.
- `test/setup-flow-docs.test.ts`: SETUP.md ↔ Book drift, both directions; kickoff prompt
  present in README.
- `--doctor` tested against fixture profiles (healthy, expiring, malformed).

## Sequencing

1. **PR 1 — the Book + core extraction.** `setup-flow.ts`, extract `buildAuthUrl` /
   `exchangeCallbackUrl` / `discoverIds` (split from prompts) / `saveProfile`; no
   user-visible behavior change; guards untouched.
2. **PR 2 — headless + agent path.** Verbs, exit codes, kickoff prompt, SETUP.md 🤖
   rewrite, `help` `setup` topic. Serves Code and Cowork — every "just do it" user.
3. **PR 3 — wizard re-render + human path.** Wizard reads the Book; SETUP.md human prose
   rewrite; drift tests turned on.

Each PR independently shippable; PR 3 touches no headless code.

## Roadmap / out of scope

- **Single-binary distribution** (removes the Node prerequisite): Node SEA or `bun
  compile` is the easy half; the real cost is macOS notarization (Apple Developer ID,
  $99/yr, CI signing) and Windows SmartScreen reputation — unsigned binaries are *worse*
  for non-technical users than installing Node. Parked with this costing.
- **Localhost callback catcher** — rejected (see Decisions); reopening requires probes.
- **Headless migration** — excluded by design.
- **Browser-driving the Developer Portal** (Claude-in-Chrome) — not designed for; the
  Developer App step remains exact manual instructions.
