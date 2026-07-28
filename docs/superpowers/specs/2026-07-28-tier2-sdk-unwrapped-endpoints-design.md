# Tier 2 — Expose SDK-Unwrapped FreshBooks Endpoints — Design

- **Date:** 2026-07-28
- **Status:** Approved design, pending implementation
- **Scope:** 76 → ~97 tools across 7 phases
- **Ships as:** `2.2.0` (minor — purely additive; see Docs & release)
- **Method:** brainstorming session + nine-agent audit against the live repo and
  live API. Every factual claim was verified at the time of writing; claims marked
  ⚠️ are corrections to earlier, wrong versions of this plan.

## HOW TO RESUME THIS PLAN

**Read in this order:** Part A (install safety — some of it may still be true),
Part B (pre-existing bugs, each independently shippable), Part D (endpoint truth
table — this is the hard-won part, do not re-probe it blindly), then the phase you
are on.

**Pre-flight, every session, before touching anything:**

```bash
cd /Users/tonyfabiano/Documents/Cursor/FreshBooks-MCP
git status --short                                    # tree must be clean
ps aux | grep 'FreshBooks-MCP/dist/index.js' | grep -v grep   # count live servers
ls -la .server.lock                                   # present iff a server runs
npm run check-tokens                                  # SAFE: pure JWT decode, no API call
npm run build && npm run lint && npm test             # must be green before starting
node -e "console.log(require('./dist/tool-registry').allTools.length)"  # current total
```

**Facts that will have drifted and must be re-checked, not trusted:**
the two live PIDs and their start times; whether `.server.lock` exists; whether
`dist/` is newer than the running processes; the current tool count; and whether
the in-flight reports work (Part B item 5) has landed.

**Facts that are durable:** everything in Part D (endpoint paths, envelope keys,
honored vs silently-ignored params) — probed against all three profiles. The SDK
internals cited (`APIClient.js` line numbers) are pinned to `@freshbooks/api@4.1.0`.

### Progress checklist

- [ ] **Phase 0** — Part B bugs (9 items, each own commit) + `noEmitOnError` + server-lock fix + `dist` snapshot → 76 tools
- [ ] **Phase 1** — `src/raw-call.ts` + `test/tool-inventory.test.ts` + `test/doc-inventory.test.ts` + `REPORT_PARAMS` + doc infrastructure → 76 tools
- [ ] **Phase 2** — 6 ledger reports → 82
- [ ] **Phase 3** — 8 entity reads (estimates, staff, taxes, invoice profiles) + **written go/no-go per write domain** → 90
- [ ] **Phase 4** — taxes writes → 93
- [ ] **Phase 5** — estimates writes + send → 97
- [ ] **Phase 6** — invoice-profile writes (**gated** on Phase 3) → 100
- [ ] **Release** — bump to 2.2.0 once, at the end
- [ ] *Deferred, revisit only with new evidence:* chart-of-accounts writes, staff writes, `report_invoice_details`

**Per-phase exit gate (all five, in order):** clean tree → `npm run build && npm run lint && npm test`
green → live cross-foot per Part J → git tag → `cp -R dist ../FreshBooks-MCP-dist-<count>-GOOD`.

**Operator-specific details** (PIDs, absolute paths, `~/.claude.json`, an email
address) appear in Part A because they were observed during the audit. They are
this machine's state, not repo contract — re-derive them, and do not treat them as
shareable fact. Per `TOOL_AUDIT.md:5`, account and business identifiers are
redacted from committed docs; Part B item 2 exists because that policy was
breached during this session.

---

## Context

`@freshbooks/api` froze at 4.1.0 (2024-09-11, still latest). FreshBooks kept
shipping. The SDK never wrapped estimates, staff, taxes, invoice profiles, or
seven ledger reports. `CLAUDE.md:605` mandates SDK-only access, so this server
structurally cannot reach them.

Live probing proved the SDK's own private `call()` reaches them all, inheriting
the profile's rotating Bearer token, the repo's retry policy, and the 30s
timeout. This plan exposes them, phased so nothing lands before the layer beneath
it is proven.

Nine agents audited this against the live repo. Their corrections are folded in —
including several of my own earlier errors, marked ⚠️.

**Locked decisions:** full CRUD (owner's call, made after seeing the risks); no
sub-account label map (keeps the server shareable); `src/raw-call.ts` as the only
escape hatch; N separate report tools, not one enum tool (measured: the enum saves
~2,550 tokens but destroys schema-level param enforcement — see §7).

---

## PART A — Install safety (some of this is true right now)

Registered in **three** places, all `node <repo>/dist/index.js`, absolute, no `env`
block: `.mcp.json`, `~/.claude.json:2175-2181`, Claude Desktop's config.

**Verified live, 2026-07-28 ~15:00:**
- **Two servers running** (PIDs 12868/15429, started 13:54/13:55) while `dist/`
  was rebuilt **14:16**. Node snapshots modules at require time → **both are
  serving stale code**. The `currency_codes[]` fix is compiled but not active.
- **`.server.lock` absent** despite two servers. `server-lock.ts:7-16` is
  last-writer-wins and *any* exiter deletes it, so N servers share one lock and
  the first exiter unlocks everyone. `migrate.ts:104`'s guard — the thing
  preventing migration from burning the live refresh token — **currently reports
  "no server running."** This is a live defect in a token-safety invariant, not a
  footnote. Own commit, with a test, ahead of everything. Fix: per-pid lock files
  + directory scan, or refcount; `isServerLockFresh` true if *any* live pid holds one.
- **`tsconfig.json` lacks `noEmitOnError`** → a failing `tsc` overwrites a working
  `dist/`. `npx tsc --noEmit` exits 0 today, so adding it is free and zero-risk.

### Rules

1. **Snapshot `dist/` before Phase 1** (`cp -R dist ../FreshBooks-MCP-dist-76-GOOD`).
   `dist/` is gitignored → **`git revert` does not roll back the install**.
   Re-snapshot each green phase.
2. Never build while a server is live (`tsc` writes non-atomically).
3. **Never run `node dist/index.js` / `npm start` ad hoc** — clobbers the lock,
   rotates all three profiles, deletes the lock on exit. Handshake-verify
   in-process via `InMemoryTransport` (`mcp-roundtrip.test.ts:20-26`).
4. **Never `npm ci` or bare `npm install`** in the live checkout.
5. `npm run check-tokens` is safe (pure JWT decode). `npm run refresh-tokens` is
   **not** — it rotates and ignores the lock.
6. **Never restore a `profiles/*.env.bak`.** Three exist right now and all hold
   superseded refresh tokens — `atomic-write.ts:27` creates one on every rotation
   by design. Restoring one burns the token family. Move them out of the repo in
   Phase 0.
7. **No `mcp__freshbooks__*` wildcard** in `.claude/settings.local.json` (21 exact
   entries today). Per-tool prompts are the last human gate before writes.
8. **Build/restart from a shell with no `freshbooks` MCP attached** — both live
   servers are children of `claude`, so the implementer is likely inside one.
9. Restart: quiesce → `npm run build && npm run lint && npm test` chained (gate on
   exit 0) → relaunch. Desktop needs full **Quit**; Claude Code needs a new session
   or `/mcp` reconnect. Verify with `freshbooks_help topic=tools`.
10. **Pin by hand-editing two lines** — `package.json:44` and
    `package-lock.json:13`, `^4.1.0` → `4.1.0`. `package-lock.json:388-392`
    already pins exact. No npm invocation. Validate with `npm ci` in a throwaway clone.

**Part A is an operator runbook, not repo content** — it names PIDs, config paths,
and an email. Only `noEmitOnError` belongs to everyone.

---

## PART B — Pre-existing bugs (each its own commit, land regardless of Tier 2)

1. ⚠️ **My `CLAUDE.md` sub-accounts claim is WRONG.** "The SDK's typed model drops
   `sub_accounts[]`" is false — `JournalEntryAccount.js:19-20` maps them; the fields
   live at `subAccounts[].subAccountId`. The probe read the **parent** level, where
   they're legitimately `undefined`. Don't delete the trap — **correct it and keep
   why it was believable**, matching `TOOL_AUDIT.md:486-495`'s correction style.
   Also `CLAUDE.md:471` says "Three verified traps" and lists four.
2. ⚠️ **My `CLAUDE.md` edit violates the repo's own redaction policy.**
   `TOOL_AUDIT.md:5`: "account/business identifiers **redacted for the public
   repo**." Lines 479/490-492 ship real `sub_accountid`s and real equity balances.
   Uncommitted — fix before it lands. Keep the *mechanism* (reported `balance`
   disagrees with summed details; page 1 alone gives ±100,000 vs +102,000/−101,000),
   drop the identifiers.
3. **`journal-entries.ts:31,:39` are wrong in TOOL DESCRIPTIONS** — they say get
   "the `subAccountId` field" from `list_journal_entry_accounts`; there is no
   top-level one. **Highest priority:** this is the only wrong doc the model reads
   on every call, and it renders into `freshbooks_help` too.
4. **9 of 12 `delete_*` descriptions are false.** They all say "permanent and
   cannot be undone," but invoice/client/expense/payment/bill/bill_payment/
   bill_vendor/credit_note/task are **soft** deletes (`PUT vis_state:1`,
   restorable in the UI). Only project/time_entry/other_income are hard. Two
   templates, ~10 lines, zero risk.
5. **`TOOL_AUDIT.md` §9 (`:578-579`) still prescribes the wrong `currency_code`
   fix** — and `:13-14` tells a future session to "execute Section 9 top-to-bottom."
   A fresh session re-introduces the bug. Strike it, point at the correction at
   `:486-495`, and banner the doc as a historical snapshot.
6. **`docs/claude-project-system-prompt.md:68`** asserts all list tools accept
   `page`/`per_page`. False for `list_services`/`list_accounts`, and *deceptively*
   false for `list_journal_entry_accounts`, which accepts them, ignores them, and
   echoes `per_page = total`. This instructs the model to trust a completeness
   contract that lies. `:72` is the same for sorting (5 tools lack it).
7. **`list_journal_entry_accounts` offers inert `page`/`per_page`** — drop the
   params and say so.
8. **`noEmitOnError`** + the server-lock defect (Part A).
9. **The dead-branch doctrine, 6 sites.** `call()` never returns `ok:false`
   (`APIClient.js:562-575`; zero `ok: false` in the SDK), so `if (!response.ok)` in
   74 handlers is dead. Fix `content.ts:147,200,232`, `CLAUDE.md:393-398,530-532,606`.
   **Scope, don't delete:** SDK-backed → always throws; raw-backed → real
   `Result<T>`, branch live. `CLAUDE.md:342-357`'s type is correct; don't "fix" it.

---

## PART C — Architecture: `src/raw-call.ts`

**Go through `call()`, never `client.axios`.** `getOrCreateClient` bakes the token
into `axios.defaults.headers` at construction (`APIClient.js:469-477`); refresh
mutates only `client.accessToken` (`freshbooks-client.ts:218-219`); `call()`
re-syncs per request (`:552-554`). Direct axios sends a **stale token**.

**Guards (both, they test different rules):** grep `src/` for `new Client(` →
exactly one hit (`freshbooks-client.ts:81`) — that is what A1 actually says; and
`.axios` → exactly one hit (`:90`).

**`rawRequest` takes no client parameter.** It calls `getFreshBooksClient()`
internally. If the signature accepted a `Client`, someone would eventually pass
`getOrCreateClient(profile)` — which `accounts.ts:40` legitimately does *outside*
ALS — and cross profiles with `ok:true`.

**Decide the error fork now, don't ship it open.** Two designs were considered;
**take the cheap one**: inspect `response.data` for an error envelope *after*
`call()` returns, with **no custom `transformResponse`**. Rationale, verified: a
custom transform replaces axios's default JSON parser (`mergeConfig.js:86`) so it
receives a raw string; `call()` reads only `{errors:[{message}]}` or `{message}`
and discards anything else for `statusText`; returning nullish or `errors:[]`
throws a raw `TypeError`; and a throw inside the transform escapes with no
`.response`. All four traps exist *only* to buy prettier error strings. Write the
rejected option and its failure modes into the file header — this repo's house
style (`reports.ts:6-14`, `freshbooks-client.ts:223-233`, `profiles.ts:160-189`).

Use the SDK's five classifiers by namespace (`isAccountingErrorResponse`,
`isAuthErrorResponse`, …) — staff sits under identity/auth, not `/accounting/`.

**Pure primitives:** `buildRawQuery` (URLSearchParams — the SDK's own builder does
**not** encode values, and cannot emit a repeated key), `unwrapEnvelope`,
`readPageMeta`, `decodeReportParams`. `unwrapEnvelope` has **three** outcomes:
missing key → throw; wrong type → throw; **present and empty → ok** (empty
collections are success, not error).

**Envelope drift ≠ API error.** They mean opposite things ("your books don't have
this" vs "our code no longer understands this API"). Give drift a distinct `kind`,
a `CRITICAL` stderr line (precedent: `freshbooks-client.ts:154-160`), and **echo
the raw payload** — never discard a body you failed to parse.

**Never-throw is a property, not a comment.** Test it as one: `rawRequest` never
rejects for *any* `call` behavior — throws a string, throws `undefined`, returns
nullish, returns `{errors:[]}`, returns HTML, returns 200-with-error-body.

### Pagination

`rawList` exposes no `page`/`per_page`; always exhausts; completeness is
**computed** (`pages_fetched === pages_total && rows === total`). Guards:
page-echo, zero-progress, page cap, **45–60s** budget (not 120s — that contradicts
the 30s-timeout rationale at `freshbooks-client.ts:8-12` and exceeds common client
tool timeouts; one page can burn 30s + backoff ≈ 66s). Implement the budget as a
`Date.now()` check at loop top, never a timer that resumes work — anything
resuming off a timer risks escaping ALS.

**Loud, not soft.** `TOOL_AUDIT.md:56-58`: *"In an accounting tool, silent wrong
numbers are worse than a crash."* So:
- **Integrity failures** (page-echo, zero-progress, mid-read 401/5xx) → **`isError: true`**,
  no partial data. A partially-authenticated ledger is not a warning condition.
- **Budget/size stops** (page cap, size ceiling) → `ok` with a first-key
  `WARNING_INCOMPLETE` naming `stopped_by` from a fixed enum and stating plainly
  *"any total, sum, or count computed from this payload will be WRONG."*
- **`WARNING_INCOMPLETE` is a user-visible string documented nowhere** — it needs a
  troubleshooting entry and a README line in the phase that introduces it.

**Prohibited:** never registered as a tool; **no module-level queue, pool,
scheduler, or worker** — a shared worker is born outside `als.run`, so
`getFreshBooksClient()` inside it resolves the wrong profile, yielding another
company's ledger with `ok:true`. Throttles live on `ProfileState`, like
`refreshInFlight`. Rate limiting is a real risk: `retries:2` × N pages against a
**shared** `FRESHBOOKS_CLIENT_ID` serving all three logins — observe it live in
Phase 2 before Phase 3 depends on it.

### The two-tier seam — make it obvious, not subtle

Raw tools are **visually identical and semantically inverted** to the 74 SDK tools
(same five lines; `if (!ok)` is dead in one tier and the only path in the other).
Plus SDK responses are camelCase (`transform*Response`) and raw ones are snake_case
— two casings on one server, unmarked. Three cheap moves:

1. **Physical:** `src/tools/raw/<domain>.ts`.
2. **Textual:** one shared constant appended to every raw description — *"Direct
   API access: the FreshBooks Node SDK does not wrap this endpoint. Fields are raw
   API names (snake_case), not the camelCase used by SDK-backed tools."* Precedent:
   `CASH_BASED_DESC` (`reports.ts:46-47`). Flows into `freshbooks_help` for free.
3. **Structural:** a shared `renderRaw(result)` so raw handlers are 3 lines and
   visibly not the 74-member family — and so `WARNING_INCOMPLETE`, drift reporting,
   and the update diff can't be got 23 different ways.

Then assert in `test/tool-inventory.test.ts` that every `tools/raw/` tool carries
the marker. **Build `diff-and-confirm` as a shared helper used by both tiers** —
the one place this plan can *reduce* the two-tier problem instead of adding to it.

### Zod gotchas (both verified end-to-end)

- **`z.date()` anywhere fails `listTools()` for the ENTIRE server.** So do
  `bigint/symbol/undefined/void/nan/map/set/custom/function`. Dates stay
  `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` — the regex becomes JSON-Schema
  `pattern`, a free client-side rejection. Add it to **every** date param, ~30
  params, ~420 bytes, highest correctness-per-byte change available.
- **`withAccount` spreads `inputSchema` (`with-refresh.ts:71`) → raw shapes only.**
  A `z.object()` yields `{"type":"object","properties":{}}` — a zero-parameter
  tool, **silently**, no error, no failing test.

### Startup assertion

⚠️ My earlier proposal (assert on a `Client` instance in `index.ts`) is unsafe —
constructing one needs `FRESHBOOKS_CLIENT_ID` + a profile and mutates shared axios
defaults, and anything throwing in `main()` kills all 76 tools (`index.ts:46-49`).
Assert on **`Client.prototype`** (verified: own `call`, arity 5), **after**
`connect(transport)` (`:36`), and **warn to stderr, never crash** (precedent
`:10-20`). Never `console.log` — stdout is the JSON-RPC stream. Hard enforcement
lives in `asRawCallable()` and `test/sdk-contract.test.ts`.

---

## PART D — Endpoint truth (all probed live, all three profiles)

| Endpoint | Envelope key | Paginates | Honored | **Silently ignored** |
|---|---|---|---|---|
| `estimates/estimates` | `estimates` | yes | page/per_page | — |
| `users/staffs` | **`staff`** ⚠️ | yes (verified) | page/per_page | — |
| `taxes/taxes` | `taxes` | yes | page/per_page | — |
| `invoice_profiles/…` | `invoice_profiles` | yes | page/per_page | — |
| `journal_entry_accounts/…` | `journal_entry_accounts` | **inert** | — | **page, per_page** (echoes `per_page=total`) |
| `reports/…/balance_sheet` | `balance_sheet` | **no** | **`dates[]`** (repeatable), `currency_code`, `cash_based` | **`start_date`, `end_date`** |
| `reports/…/general_ledger` | `general_ledger` | no | start/end, accountid, subaccountid, categoryid, group_by_category_id | — |
| `reports/…/accounts_aging` | `accounts_aging` | no | `end_date`, `group_by` (only `"outstanding"`) | **`start_date`**, clientids[] |
| `reports/…/expense_details` | `expense_details` | no | start/end, group_by, exclude_personal, include_project, client_id, project_id | `summary_only` |
| `reports/…/cash_flow` | `cash_flow` | no | start/end, currency_code, group_by_category_id | **`cash_based`** |
| `reports/…/trial_balance` | `trial_balance` | no | start/end, currency_code, group_by_category_id | — |
| `reports/…/profitloss_entity` | **`profitloss`** ⚠️ | no | *(existing)* | — |
| `accounts_payable_aging` | — | — | **403** — exists, entitlement gap | — |
| `revenue_by_client` | — | — | **422** — exists, contract unknown → do not ship | — |
| any `chart_of_accounts` path | — | — | **404 — does not exist** | — |

**No distinct chart-of-accounts endpoint exists.** `journal_entry_accounts` **IS**
the chart of accounts (17 accounts, 1000–6001, identical on all three profiles) and
`journal-entries.ts:93` already says so. `CLAUDE.md:281-284` listing "Chart of
Accounts" as never-wrapped is what nearly caused a duplicate tool — fix it.

**Reports never paginate.** Add `trial_balance`; drop `revenue_by_client`; keep
`accounts_payable_aging` out of scope but document the 403 as an **entitlement**
gap, account-neutral (precedent: `TOOL_AUDIT.md:79-83` kept the 14 bill tools and
found 4 real bugs by static review).

---

## PART E — Scope: 76 → ~97

⚠️ Earlier counts (98, 105, 103) were all wrong. Revised after the audits:

| # | Lands | Δ | Total |
|---|---|---|---|
| 0 | Part B bugs + `noEmitOnError` + lock fix + `dist` snapshot | 0 | 76 |
| 1 | `raw-call.ts` + sweeps + doc infrastructure | 0 | 76 |
| 2 | 6 ledger reports (balance_sheet, general_ledger, cash_flow, accounts_aging, expense_details, trial_balance) | +6 | 82 |
| 3 | 8 entity reads — list/get × estimates, staff, taxes, invoice profiles | +8 | 90 |
| 4 | taxes writes | +3 | 93 |
| 5 | estimates writes + send | +4 | 97 |
| 6 | invoice-profile writes — **gated** | +3 | 100 |

**Deferred, not cancelled** (the audits' strongest recommendation, and it honors the
caution already in the risk table without touching the full-CRUD decision):
- **Chart-of-accounts writes** — its reads were dropped as duplicative, and create
  with no delete **breaks the repo's own write-verification method**
  (`TOOL_AUDIT.md:72-74`: create `ZZZ_MCP_AUDIT` → delete → confirm `visState:1`).
  Establish the delete verb first or leave read-only.
- **Staff writes** — "cannot be live-verified"; `create_staff` emails a real human.
  Ship staff **read-only** in Phase 3, which already closes a real hole: **`expenses.ts:101`
  requires a `staff_id` that no tool in this server can produce.**
- **`report_invoice_details`** — subsumed by `list_invoices` + `includes:['lines']`.
- **Phase 6 is gated** on Phase 3 proving the invoice-profile contract; it's beyond
  `CLAUDE.md:281-284`'s documented set and can auto-generate real invoices.

**Never hardcode the total.** `npm run build && node -e "console.log(require('./dist/tool-registry').allTools.length)"`
— build first, `dist/` is gitignored.

**End Phase 3 with a written go/no-go per write domain**, each gated on an
artifact: the delete-verb probe, the PUT full-replace probe, and a live
create→get→update→delete→re-list→empty-diff transcript.

---

## PART F — The doctrine that must not become bureaucracy

`reports.ts:29-45` is not "have a list." It is: (1) an **evidence artifact** — the
`downloadToken.params` claim; (2) the list is a **transcription** of it; (3) a test
locks it and the recipe is documented so it can be re-derived.

Reports have the artifact. **Estimates, staff, taxes, and invoice profiles do
not.** An allow-list there would look identical, be reviewed identically, and carry
the same air of "verified" while being a guess — and a runtime assert that rejects
an unlisted param is unfalsifiable to the user.

**So:** reports → transcribe the artifact. Entity endpoints → **ship no optional
filters** (path params + pagination only) unless an artifact is manufactured first
(send the param twice with values that must differ against a known fixture, record
both transcripts). **Record the artifact type per endpoint in the source comment —
including "we don't have one."** `journal-entries.ts:23` proves this author ships
honest admissions in tool descriptions.

**Upgrade:** echo the decoded `downloadToken.params` in every report's output as
`params_the_server_actually_parsed`. ~100 bytes; converts a one-time audit into a
permanent runtime property — the model can see its own `cash_based:true` was
ignored. Do not dump the raw JWT.

---

## PART G — Ergonomics (measured: 76 tools = 68KB ≈ 20–23k tokens; ~97 ≈ 28k)

**Hazard: three meanings of "account"** — `list_accounts` (logins),
`list_journal_entry_accounts` (GL accounts), and the injected `account` param. A
model asked "list the accounts" is already a coin flip. Harden all three
descriptions with explicit cross-references and *negative* space ("not X — use Y").

**Every new description gets:** clause 1 = the action (≤12 words); clause 2 = the
user's question in the user's words ("answers 'what do we own and owe'"); a QUIRK
line only when real; a sibling pointer only when confusion is plausible; ≤400 chars.
**Delete `"Supports pagination, search filters, sorting, and includes."`** from ~20
existing descriptions — 1.2KB of pure schema restatement occupying the
highest-attention position.

**Reshape `dates[]`** — a bare array invites `["2025-01-01","2025-12-31"]` meaning
"the year 2025," which returns a **two-column comparative** with `ok:true`. Use
`as_of_date` (required scalar) + `compare_to` (optional array, max 3). Put the
safety in the identifier, not the sentence.

**`detail: z.enum(["summary","full"]).default("summary")` on every nested report.**
A mid-size balance sheet is 60–150KB pretty-printed — larger than the entire tool
schema budget, per call. `summary` prunes `sub_accounts[]` keeping every parent row
and every total, replacing each pruned array with `sub_accounts_omitted: N`. ~10x
reduction. This is the single biggest context win available, and it's per-call.

**Errors end with an imperative** — one of `retry with <literal>` / `do not retry` /
`call <tool> first` / `tell the user <thing>`. Without it the model's default on
any error is to permute arguments and retry, which against real books is a
write-safety problem. 403 → "do not retry, permanent capability gap, name the
profile." 422 on a raw write → "**DO NOT guess additional fields**; this API drops
unknown keys silently so a lucky retry can appear to succeed while writing the
wrong data."

---

## PART H — Docs (test-enforced where possible)

**Tier A, test-enforced (8 sites):** README ×3, SETUP ×1, sysprompt ×1, CLAUDE.md
×2, `package.json.description` ×1, CONTRIBUTING ×**0**. Same commit as the tools —
forced by `git revert` needing to leave a green tree.

**Tier B, derived (zero edits):** `content.ts:30,65`, `render-tools.ts:29,34-41`.

**Tier C, hand-written and rot-prone:** ~28 sites listed in the doc audit. The tool
inventory lives in **five** places, three by hand — 23 new tools × 3 = 69 manual
entries across 7 commits, guarded today only by a *count*.

**Two new guards (Phase 1, cheap, high value):**
1. **`test/doc-inventory.test.ts`** — name-level: every `allTools[].name` appears in
   README/CLAUDE.md/sysprompt, and every `/freshbooks_[a-z_]+/` in those files is a
   real registered name. Catches both "forgot to document" and "documented a tool
   that no longer exists." No build dependency; names the file *and* the tool.
2. **Export `REPORT_PARAMS`** from `reports.ts` as data (`honored`, `ignored`,
   `paginates`, `path`, `envelope_key`), assert `schemaKeys ⊆ honored` and
   `∩ ignored = ∅`, render a new `freshbooks_help topic=reports` from it, and have
   CLAUDE.md/README **link** rather than restate. Converts this repo's #1 historical
   bug class from prose discipline into a test.

**New docs required:** a raw-endpoints table (Part D, plus delete verb and
verification date — this *is* the spec for `unwrapEnvelope`'s arguments); a
negative-results table (404/403/422) using **account class, never profile names**
(`TOOL_AUDIT.md:5`); a `raw` tag in `render-tools.ts`; troubleshooting entries for
`WARNING_INCOMPLETE`, the 403 entitlement gap, and "my date range did nothing"; and
a permanent **doc-maintenance contract** in CLAUDE.md so the next feature doesn't
repeat this audit.

**SETUP.md:** no structural change (no new env vars, scopes, or wizard steps — the
token-refresh SKILL.md needs no edit). Four small ones: the count; the 403 in
limitations; report example prompts; and a troubleshooting row for "Claude keeps
asking permission for every FreshBooks tool" explaining why wildcarding is refused.

**Release:** bump **once at the end** (2.2.0) — `release.yml` fires per push and
skips when the version already has a release, so per-phase bumps would cut 7
releases. `npm version --no-git-tag-version` must include `package-lock.json`.
`extract-changelog.mjs` exits non-zero on a missing `## [2.2.0]` section.

---

## PART I — Testing

Four network-free techniques (no HTTP mocking exists): **T1** exported pure
builders (the only thing that catches wrong paths/wire keys — historically 100% of
this repo's shipped bugs); **T2** fake `profile.client = {call}` short-circuiting
`getOrCreateClient:78`; **T3** schema introspection; **T4** registry sweeps.

Write red first in Phase 1: the 144-row regression, page-echo, zero-progress (2000ms
timeout so an infinite loop fails fast), 200-with-error-body, non-empty message,
nullish-transform, and same-client identity. **Add an interleaved two-profile
concurrency test** — T2 is sequential, and ALS only really fails under concurrency.

**`test/tool-inventory.test.ts`** sweeps: name uniqueness, prefix, and the
annotation convention (`create_` → **none**; `freshbooks_help` and `send_estimate`
match no prefix → explicit allow-list). Write the convention into `CLAUDE.md:604`,
`:520-524`, **and** `content.ts:224` — a test codifying an undocumented rule leaves
three docs contradicting the guard.

**Typecheck:** ⚠️ my "dozens of errors" was an overcorrection. Measured: **3 errors**
under `module:esnext` + `moduleResolution:bundler`, all one union-narrowing fix in
`accounts-tool.test.ts`. The real blocker is `TS1343` — tests use `import.meta`
while `src/` is CommonJS, so you **cannot** just add `test/**` to `tsconfig.json`.
Use a sibling `tsconfig.test.json` (`noEmit`, esnext, bundler). Also `"lint":
"eslint src/"` must become `eslint src test`, and a `typecheck` step added to
**both** `ci.yml` and `release.yml`.

---

## PART J — Verification

**Reads:** all three profiles. Empty collections → success, not `isError`; bogus IDs
→ `isError`, not throw.

**Cross-foot, don't smoke-test** — these return `ok:true` with believable wrong
numbers: balance_sheet (assets = liabilities + equity; equity ties to
`journal_entry_details`); general_ledger (Σdebits = Σcredits); trial_balance (the
two columns must be equal); cash_flow (net change ties to Cash 1000 GL movement);
accounts_aging (total = Σ unpaid from `list_invoices`); expense_details (ties to
`report_profit_loss`, same range **and basis**); every report (decode
`downloadToken.params`).

**Writes (only on a profile the owner has explicitly authorized):** snapshot all pages → `ZZZ_MCP_AUDIT` prefix →
create/get/update/delete/re-list → **diff must be empty** → never mutate a
pre-existing record → one session per phase. **Exactly one** server process
(`ps aux` check) — the U3 cross-process guard is TOCTOU and has never fired (zero
`adopted on-disk token` lines across 279 logged refreshes).

`send_estimate`: `email_recipients` **required, non-defaulted**, tested to prove the
fake `call` is never invoked when absent; then exactly one live send to an address
the owner controls.

**Per-phase gate:** clean tree → build/lint/test green → live cross-foot → tag →
`dist` snapshot.

---

## Critical files

`src/raw-call.ts` *(new)* · `src/tool-registry.ts` · `src/index.ts` ·
`src/server-lock.ts` + `src/migrate.ts` (the live lock defect) ·
`src/freshbooks-client.ts` (`:14-29`, `:73-93`, `:176-243`) · `tsconfig.json` ·
`package.json:44` + `package-lock.json:13` · `src/tools/reports.ts` (the template;
re-export `reportSearch` from `./reports` if it moves) · `src/tools/journal-entries.ts`
(`:23,:31,:39,:93`) · `src/docs/content.ts` (`:30,122-140,147,151-153,200,224,232`) ·
`docs/claude-project-system-prompt.md` (`:15,19-62,68,72`) · `src/tools/help.ts`
(needs the `reports` topic) · `TOOL_AUDIT.md` (`:5` policy, `:578-579` wrong
prescription) · `test/doc-tool-count.test.ts` + `test/accounts-tool.test.ts:11`

## Effort

~35–50h across 7 phases. Phase 3 is the schedule pinch point (a domain deferred out
of Phase 3 **takes its write phase with it** to a trailing phase; nothing renumbers,
totals are read from the registry). Phase 1 deserves disproportionate care — 23
tools inherit whatever it gets right or wrong.
