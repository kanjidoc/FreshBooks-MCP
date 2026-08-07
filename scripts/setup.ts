/**
 * FreshBooks MCP — Interactive Setup Wizard (Surface 1)
 *
 * Everything a human is told here is RENDERED FROM THE BOOK
 * (`src/setup-flow.ts`) — the same data the headless agent surface and SETUP.md
 * render. There is deliberately no hand-written step copy in this file: the
 * defect this whole design exists to kill is the wizard, the docs and Claude's
 * knowledge of the flow drifting apart, and a banner typed here is exactly how
 * that starts. What this file owns is the ORCHESTRATION — which step runs when,
 * which prompts are asked, and what is done with the answers.
 *
 * The flow (spec §Surface 1): migration gate → developer app → app credentials
 * → per-login loop (nickname, validated and availability-checked BEFORE the
 * auth URL is minted → authorize, whose checklist prints just-in-time at the
 * paste prompt → save, with the same-account confirmation) → base `.env` and
 * `.mcp.json` → build → install prompts → the parting note, printed last.
 *
 * Token model: base `.env` holds only FRESHBOOKS_CLIENT_ID/SECRET/REDIRECT_URI
 * (plus FRESHBOOKS_MIGRATED=1 once a legacy `.env` has been migrated). Every
 * login's tokens live ONLY in `profiles/<name>.env`, written exclusively through
 * the collision-guarded `saveProfile`/`runMigration` — never by hand here. No
 * token is ever printed: the per-login summary reports nickname, company and
 * account ID, and nothing else.
 *
 * THE TEST SEAM. `runWizard(io, paths)` takes its I/O and its file paths as
 * arguments; `main()` wires readline, `console.log` and `defaultPaths()` around
 * it. That is what lets `test/wizard-render.test.ts` drive the real flow with a
 * scripted `ask` and assert the ORDER a human meets the copy, over a temp
 * directory, without touching the developer's `.env` or reaching FreshBooks.
 *
 * Usage:
 *   npx ts-node scripts/setup.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import type { Client } from "@freshbooks/api";
import {
  isMigrated,
  markDistinctLogin,
  MIGRATED_MARKER,
  ProfileWriteError,
  runMigration,
} from "../src/migrate";
import { normalizeProfileName, type ProfileConfig } from "../src/profiles";
import { SETUP_FLOW, type SetupCtx, type SetupStep } from "../src/setup-flow";
import {
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  claudeMcpAddJson,
  discoverMemberships,
  exchangeCode,
  installDesktop,
  installMcpJson,
  isClaudeCliAvailable,
  runBuild,
  saveProfile,
  writeCredentialFile,
} from "./setup-core";
import {
  defaultPaths,
  legacyEnvNeedsMigration,
  runHeadless,
  type SetupPaths,
} from "./setup-headless";

/**
 * The one OAuth redirect URI this project uses, everywhere: the wizard's
 * `Client`, the base `.env` it writes, the headless `--init`/`--auth-url`, and
 * the Book's `developer-app` instructions ("set the Redirect URI to exactly
 * …"). Exported so `scripts/setup-headless.ts` uses this definition rather
 * than a second copy that could drift.
 */
export const REDIRECT_URI = "https://localhost/callback";

// ---------------------------------------------------------------------------
// The injected I/O seam
// ---------------------------------------------------------------------------

/**
 * Everything the wizard is allowed to do to a terminal.
 *
 * Deliberately two methods and no more: a wizard that could also clear the
 * screen, move the cursor, or read a keypress would not be replayable as a
 * transcript, and the transcript is what the sequencing test asserts on.
 * `ask` returns the answer already trimmed.
 */
export interface WizardIO {
  ask(question: string): Promise<string>;
  out(line: string): void;
}

/** Yes/no parse. `defaultYes` decides what a bare Enter (empty input) means. */
function isYes(answer: string, defaultYes = false): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

/**
 * The wizard's ONE prompt renderer. Pure — it produces the string `ask()` hands
 * to readline and nothing else, which is why it is unit-testable without any
 * I/O stub.
 *
 * Both yes/no renderings are drafted by the design spec (§Surface 1: "One
 * `prompt()` helper; both default renderings specified: `(y = yes, Enter = no)`
 * and `(Enter = yes, n = no)`") and must not be paraphrased — a prompt that
 * shows the wrong default silently inverts a consent. `def` names what a bare
 * Enter means, so it always agrees with the `isYes(answer, defaultYes)` call it
 * is paired with; `null` is a free-text prompt (no hint).
 *
 * The question text is emitted verbatim, leading indentation included — the
 * caller owns the wizard's house style, this function owns only the suffix.
 */
export function formatPrompt(question: string, def: "yes" | "no" | null): string {
  const hint =
    def === "yes" ? " (Enter = yes, n = no)" : def === "no" ? " (y = yes, Enter = no)" : "";
  return `${question}${hint}: `;
}

// ---------------------------------------------------------------------------
// Reading the Book
// ---------------------------------------------------------------------------

/** One Book step by id. Missing ⇒ this file and `src/setup-flow.ts` disagree. */
function bookStep(id: string): SetupStep {
  const step = SETUP_FLOW.find((s) => s.id === id);
  if (!step) throw new Error(`No Book step "${id}" — src/setup-flow.ts and this file disagree.`);
  return step;
}

/**
 * The Book's own fix text for one troubleshooting row, looked up by a fragment
 * of its symptom — the same discipline `scripts/setup-headless.ts` uses. Where
 * the Book already words a state for a human, the wizard quotes it rather than
 * paraphrasing, so the CLI, the agent surface and SETUP.md can never say three
 * different things about one failure.
 */
function bookFix(stepId: string, symptomFragment: string): string {
  const row = bookStep(stepId).troubleshooting.find((t) => t.symptom.includes(symptomFragment));
  if (!row) {
    throw new Error(
      `Book step "${stepId}" has no troubleshooting row matching "${symptomFragment}" — ` +
        "src/setup-flow.ts and this file disagree.",
    );
  }
  return row.fix;
}

/**
 * THE WIZARD'S OWN STEP ORDER — the sequence the checklist renders and the
 * orchestration below follows.
 *
 * It is not the Book's order, and it is not meant to be: the Book lists steps in
 * the order a READER meets them, while the wizard performs `build` after the
 * logins (there is nothing to build against until the credentials exist) and
 * asks the migration question first (an unmigrated base `.env` blocks
 * everything else — the same state the headless verbs refuse with exit 9).
 * `renderChecklist` honors the caller's order for exactly this reason.
 */
const WIZARD_STEP_ORDER = [
  "node-install",
  "migrate-legacy",
  "developer-app",
  "app-credentials",
  "nickname",
  "authorize",
  "save-login",
  "build",
  "install-config",
  "verify",
  "restart",
];

/**
 * The Book's `wizard`-surface steps in the wizard's own order.
 *
 * Throws if the Book gained a `wizard` step this list does not place — a new
 * step that silently never renders would be exactly the drift the Book exists
 * to prevent, and a loud failure at startup is cheaper than a missing step in a
 * user's transcript.
 */
export function wizardSteps(): SetupStep[] {
  const unplaced = SETUP_FLOW.filter(
    (s) => s.surfaces.includes("wizard") && !WIZARD_STEP_ORDER.includes(s.id),
  );
  if (unplaced.length > 0) {
    throw new Error(
      `Book wizard-surface step(s) missing from WIZARD_STEP_ORDER: ${unplaced
        .map((s) => s.id)
        .join(", ")}`,
    );
  }
  return WIZARD_STEP_ORDER.map(bookStep);
}

/** Resolve the Book's `{{placeholders}}` against this run's live ctx. */
function interpolate(text: string, ctx: SetupCtx): string {
  return text
    .split("{{projectDir}}")
    .join(ctx.projectDir)
    .split("{{redirectUri}}")
    .join(ctx.redirectUri);
}

/** Indent every physical line, leaving blank lines blank. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

const RULE = "-".repeat(70);

/** A step's title, framed. The frame is house style; the title is the Book's. */
function renderStepHeading(step: SetupStep): string {
  return `\n${RULE}\n  ${step.title}\n${RULE}\n`;
}

/**
 * A step's `humanScript`, verbatim and unwrapped.
 *
 * NOT word-wrapped on purpose: the Book's load-bearing phrases ("CAN'T BE
 * REACHED", "never into this chat") are asserted as contiguous substrings by
 * the drift tests and by the transcript test, and a wrapper that broke one
 * across two lines would make the wizard silently stop saying it.
 */
function renderStepScript(step: SetupStep, ctx: SetupCtx): string {
  return step.humanScript.map((line) => indent(interpolate(line, ctx))).join("\n\n");
}

// ---------------------------------------------------------------------------
// The progress checklist
// ---------------------------------------------------------------------------

/**
 * The checklist's three markers (plan Task 17): a check mark for done, a
 * right-pointing triangle for where we are, a hollow circle for still to come.
 */
const CHECK_DONE = "✓";
const CHECK_CURRENT = "▶";
const CHECK_PENDING = "○";

/**
 * The append-only progress checklist — the wizard reprints this whole block at
 * each stage boundary rather than redrawing the cursor (spec §Decisions: "Plain
 * sequential text; append-only rendering").
 *
 * Pure, and deliberately so: it renders the `wizard`-surface steps of the Book
 * it is handed, `appliesIf`-filtered against `ctx` and `repeats`-expanded, and
 * it asks nothing of the filesystem. In particular it NEVER calls a step's
 * `check()` — completion arrives as `doneIds`, which the wizard computes once
 * from those same `check(ctx)` functions. That single-sourcing is the point:
 * the wizard must never re-implement a check the Book already carries, and two
 * evaluation sites would be two chances to disagree.
 *
 * - `doneIds` / `currentId` are step ids. `currentId` wins over `doneIds` when
 *   both match: on a re-run a step's check can already pass while the user is
 *   standing on it, and where-we-are is the more useful thing to show.
 * - `loginCount` is the login currently being worked on (1 while the first is
 *   in flight), not a total known up front — the wizard's add-login loop has no
 *   such total. So the per-login group is emitted `loginCount` times,
 *   annotated `(login N)` once there is more than one, and every group before
 *   the last renders as done: the wizard only moves the counter after finishing
 *   a login. 0 (no login started yet) renders one un-annotated pending group so
 *   the user can still see the work that is coming.
 * - Surface filtering happens here, so `renderChecklist(SETUP_FLOW, …)` is the
 *   natural call; handing in an already-wizard-filtered list is identical.
 * - Returns the block with no trailing newline — the caller owns the spacing.
 */
export function renderChecklist(
  steps: SetupStep[],
  ctx: SetupCtx,
  doneIds: string[],
  currentId: string,
  loginCount: number,
): string {
  const visible = steps.filter(
    (step) => step.surfaces.includes("wizard") && (step.appliesIf ? step.appliesIf(ctx) : true),
  );
  const done = new Set(doneIds);
  const markerFor = (id: string) =>
    id === currentId ? CHECK_CURRENT : done.has(id) ? CHECK_DONE : CHECK_PENDING;

  // A non-finite or sub-1 count still owes the user one pending group.
  const iterations = Math.max(1, Number.isFinite(loginCount) ? Math.floor(loginCount) : 1);

  const out: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].repeats !== "per-login") {
      out.push(`${markerFor(visible[i].id)} ${visible[i].title}`);
      continue;
    }
    // A maximal contiguous run of per-login steps is one login's worth of work,
    // so the RUN repeats — nickname/authorize/save-login of login 1, then of
    // login 2 — which is the order they actually happen in.
    let end = i;
    while (end + 1 < visible.length && visible[end + 1].repeats === "per-login") end++;
    const run = visible.slice(i, end + 1);
    for (let n = 1; n <= iterations; n++) {
      const suffix = iterations > 1 ? ` (login ${n})` : "";
      for (const step of run) {
        const marker = n < iterations ? CHECK_DONE : markerFor(step.id);
        out.push(`${marker} ${step.title}${suffix}`);
      }
    }
    i = end;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The paste validator
// ---------------------------------------------------------------------------

/**
 * What the user pasted back after approving the connection.
 *
 * The contract is the Book's `authorize` successCheck — "You pasted a long
 * address starting with https://localhost/callback?code=..." — so anything that
 * is not an absolute http(s) URL carrying a `code` is refused, including a bare
 * code. That is stricter than the old wizard, on purpose: the beginner failure
 * this exists to catch is the address bar's DISPLAYED text, which drops the
 * scheme and often the query, and accepting a bare token would send that
 * fragment to FreshBooks and burn the grant on a confusing rejection instead of
 * asking for a clean re-copy.
 *
 * One hint, from the Book, for every rejection (spec §Surface 1: "single
 * canonical hint, shared with the `authorize` troubleshooting row").
 */
export function validateCallbackPaste(
  input: string,
): { ok: true; code: string } | { ok: false; hint: string } {
  const trimmed = String(input ?? "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const code = new URL(trimmed).searchParams.get("code");
      if (code) return { ok: true, code };
    } catch {
      // Fall through to the single hint — an unparseable paste is a truncated
      // paste as far as the user is concerned.
    }
  }
  return { ok: false, hint: bookFix("authorize", "address looks incomplete") };
}

// ---------------------------------------------------------------------------
// Base `.env`
// ---------------------------------------------------------------------------

/**
 * Pure: the env-var object the wizard persists to base `.env`.
 *
 * (U11) base `.env` carries ONLY the shared app credentials — never the
 * per-login token/ID set (FRESHBOOKS_ACCESS_TOKEN/REFRESH_TOKEN/ACCOUNT_ID/
 * BUSINESS_ID). Those live exclusively in `profiles/<name>.env` via
 * `writeNewProfile`/`runMigration`. The FRESHBOOKS_MIGRATED marker is appended
 * only once a legacy `.env` has been migrated, so the decoupling is total.
 * Exported (and kept side-effect free) so the decoupling can be unit-tested.
 */
export function buildBaseEnvVars(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  migrated: boolean,
): Record<string, string> {
  const vars: Record<string, string> = {
    FRESHBOOKS_CLIENT_ID: clientId,
    FRESHBOOKS_CLIENT_SECRET: clientSecret,
    FRESHBOOKS_REDIRECT_URI: redirectUri,
  };
  if (migrated) vars[MIGRATED_MARKER] = "1";
  return vars;
}

/** Pure: serialize an env-var object to `.env` file content. */
export function serializeEnv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/** `err.message` and nothing else — never the object (it carries the request body). */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The mutable bookkeeping one wizard run carries between its stages. */
interface WizardState {
  /** Which Book step we are standing on — the failure report keys off it. */
  currentStepId: string;
  /** Steps finished in THIS run (the Book's `check()`s add the rest). */
  completed: Set<string>;
  /** Logins saved so far; the checklist's `(login N)` counter derives from it. */
  savedLogins: number;
}

/** The Book's per-login run — the steps `renderChecklist` repeats per login. */
const PER_LOGIN_IDS = SETUP_FLOW.filter((s) => s.repeats === "per-login").map((s) => s.id);

/**
 * Mark the per-login run finished (or back in flight).
 *
 * The checklist renders the LIVE login's group from `doneIds` and every earlier
 * group as done, so these three ids belong in `completed` exactly when no login
 * is in flight. Clearing them when a login starts is what keeps the group the
 * user is standing in from rendering as already finished.
 */
function setPerLoginDone(state: WizardState, done: boolean): void {
  for (const id of PER_LOGIN_IDS) {
    if (done) state.completed.add(id);
    else state.completed.delete(id);
  }
}

/**
 * The whole wizard, with its terminal and its file paths injected.
 *
 * Returns the process exit code: 0 for a completed (or deliberately abandoned)
 * run, 1 when a step threw. It never throws and never prints a stack — the
 * catch below reports the failing step's own troubleshooting rows instead,
 * because a beginner meeting a V8 stack trace has been handed nothing they can
 * act on.
 */
export async function runWizard(io: WizardIO, paths: SetupPaths): Promise<number> {
  const ctx: SetupCtx = {
    projectDir: paths.rootDir,
    redirectUri: REDIRECT_URI,
    exists: (p) => fs.existsSync(p),
    // The Book's `migrate-legacy` predicate, computed by the surface that can
    // read file CONTENTS (the Book cannot) through the ONE shared helper the
    // dispatcher and `--doctor` also call. A wizard that re-derived it here is
    // how the three surfaces drift apart.
    legacyNeedsMigration: legacyEnvNeedsMigration(paths.baseEnvPath),
  };

  const state: WizardState = {
    currentStepId: "node-install",
    // The wizard is executing under Node, so the `node-install` step is
    // satisfied by construction; it carries no `check()` for the doctor to run.
    completed: new Set(["node-install"]),
    savedLogins: 0,
  };

  /** Everything finished: this run's progress plus every Book check that passes. */
  const doneIds = (): string[] => {
    const ids = new Set(state.completed);
    for (const step of wizardSteps()) {
      if (step.check && step.check(ctx).ok) ids.add(step.id);
    }
    return [...ids];
  };

  const showChecklist = (loginCount = state.savedLogins) => {
    io.out("");
    io.out(indent(renderChecklist(wizardSteps(), ctx, doneIds(), state.currentStepId, loginCount)));
    io.out("");
  };

  /** Enter a step: it becomes the one a failure is reported against. */
  const enter = (id: string): SetupStep => {
    state.currentStepId = id;
    return bookStep(id);
  };

  try {
    io.out(`\n${"=".repeat(70)}\n   FreshBooks MCP Server — Setup\n${"=".repeat(70)}`);
    io.out(
      indent(
        "This wizard connects one or more FreshBooks logins. Each login's tokens are\n" +
          "stored in its own profiles/<name>.env; the base .env keeps only your shared\n" +
          "app credentials.",
      ),
    );

    state.currentStepId = ctx.legacyNeedsMigration ? "migrate-legacy" : "developer-app";
    showChecklist();

    // --- Migration gate (legacy single-login .env) -------------------------
    let migrated = isMigrated(readIfPresent(paths.baseEnvPath));
    if (ctx.legacyNeedsMigration) {
      const step = enter("migrate-legacy");
      io.out(renderStepHeading(step));
      io.out(renderStepScript(step, ctx));
      io.out("");

      // ONE prompt, and it is the quit confirmation the humanScript asks for —
      // "Before saying yes: fully quit Claude" — so the answer doubles as
      // `confirmNoServer`, the only override of the live-lock guard (R1). A
      // second "are you sure" prompt would train the user to click past the one
      // safety standing between them and a burned refresh token.
      const go = isYes(
        await io.ask(
          formatPrompt(
            "   Have you fully quit Claude and anything else running this server?",
            "no",
          ),
        ),
      );

      if (!go) {
        // The humanScript promises "nothing is deleted", and the base `.env`
        // rewrite at the end of a full run WOULD delete the legacy tokens. So a
        // declined migration ends the run here rather than continuing past the
        // one state that makes finishing destructive — the same state the
        // headless verbs refuse with exit 9.
        io.out(indent("Nothing was moved and nothing was deleted."));
        io.out(indent("Re-run `npm run setup` once everything is quit."));
        return 0;
      }

      const name = await askProfileName(
        io,
        "   Name this existing login (lowercase letters and digits, like acme)",
      );
      if (!name) {
        io.out(indent("Nothing was moved and nothing was deleted."));
        return 0;
      }
      const { profilePath } = runMigration({
        name,
        rootDir: paths.rootDir,
        confirmNoServer: true,
      });
      // The Book's successCheck: "The wizard prints Migrated existing tokens →
      // profiles/<name>.env."
      io.out(indent(`Migrated existing tokens → ${profilePath}`));
      migrated = true;
      state.completed.add("migrate-legacy");
      // A migrated login IS a saved login — it just reached the profile file by
      // a different road than nickname/authorize/save-login.
      setPerLoginDone(state, true);
      state.savedLogins += 1;
    }

    // --- The developer app ------------------------------------------------
    const devApp = enter("developer-app");
    io.out(renderStepHeading(devApp));
    io.out(renderStepScript(devApp, ctx));
    io.out("");

    // --- The app credentials ----------------------------------------------
    const creds = enter("app-credentials");
    io.out(renderStepHeading(creds));
    io.out(renderStepScript(creds, ctx));
    io.out("");

    const existing = dotenv.parse(readIfPresent(paths.baseEnvPath));
    const defaultId = existing.FRESHBOOKS_CLIENT_ID ?? "";
    const defaultSecret = existing.FRESHBOOKS_CLIENT_SECRET ?? "";
    const clientId =
      (await io.ask(
        formatPrompt(`   Client ID${defaultId ? " [Enter to keep existing]" : ""}`, null),
      )) || defaultId;
    const clientSecret =
      (await io.ask(
        formatPrompt(`   Client Secret${defaultSecret ? " [Enter to keep existing]" : ""}`, null),
      )) || defaultSecret;

    if (!clientId || !clientSecret) {
      throw new Error("A Client ID and a Client Secret are both required.");
    }
    state.completed.add("developer-app");
    state.completed.add("app-credentials");
    state.currentStepId = "nickname";
    showChecklist();

    // --- The add-login loop -----------------------------------------------
    //
    // A fresh install needs at least one login; right after a migration adding
    // another is optional (the migrated login is already a profile).
    let savedAny = migrated;
    let again = true;
    if (migrated) {
      again = isYes(await io.ask(formatPrompt("   Add another FreshBooks login now?", "no")));
    }
    while (again) {
      const saved = await addLogin(io, paths, ctx, state, clientId, clientSecret);
      setPerLoginDone(state, saved);
      if (saved) {
        savedAny = true;
        state.savedLogins += 1;
      }
      state.currentStepId = "build";
      showChecklist();
      if (!savedAny) {
        io.out(indent("No login has been saved yet — the server needs at least one to work."));
        again = isYes(await io.ask(formatPrompt("   Add a login now?", "yes")), true);
      } else {
        again = isYes(await io.ask(formatPrompt("   Add another login?", "no")));
      }
    }

    if (!savedAny) {
      io.out(
        indent(
          "Warning: no FreshBooks login was configured. The server will start, but\n" +
            "every tool reports no account until you re-run `npm run setup` and add one.",
        ),
      );
    }

    // --- Base `.env` + the project-scoped `.mcp.json` ---------------------
    //
    // Each write is attributed to the step that owns it, so a failure reports
    // the troubleshooting rows a user can actually act on: the base `.env` is
    // `app-credentials`' artifact, `.mcp.json` is `install-config`'s.
    state.currentStepId = "app-credentials";
    writeCredentialFile(
      paths.baseEnvPath,
      serializeEnv(buildBaseEnvVars(clientId, clientSecret, REDIRECT_URI, migrated)),
    );
    io.out(indent(`Base .env (app credentials only — no tokens) written to: ${paths.baseEnvPath}`));

    // The MERGING installer, not a whole-file rewrite: `.mcp.json` is shared
    // with every other MCP server the user has added to this project, and the
    // old writer replaced the document wholesale.
    state.currentStepId = "install-config";
    const mcpJson = installMcpJson(paths);
    io.out(
      indent(
        mcpJson.ok
          ? `.mcp.json written to: ${mcpJson.path}`
          : `Warning: could not write ${mcpJson.path} (${mcpJson.detail}).`,
      ),
    );

    // --- Build (the wizard performs this step) -----------------------------
    const build = enter("build");
    io.out(renderStepHeading(build));
    if (runBuild(paths.rootDir)) {
      io.out(indent("Build successful."));
      state.completed.add("build");
    } else {
      // The Book's own fix for a missing `dist/index.js`, quoted rather than
      // reworded — the errors themselves already went to the terminal.
      io.out(indent(`Build failed. ${bookFix("build", "dist/index.js")}`));
    }

    // --- Connect the server to Claude --------------------------------------
    const install = enter("install-config");
    io.out(renderStepHeading(install));

    let desktopInstalled = false;
    if (isYes(await io.ask(formatPrompt("   Add the server to Claude Desktop?", "yes")), true)) {
      const outcome = installDesktop(paths);
      desktopInstalled = outcome.ok;
      io.out(
        indent(
          outcome.ok
            ? `Claude Desktop config updated: ${outcome.path}`
            : outcome.reason === "invalid-json"
              ? `Warning: existing ${outcome.path} is not valid JSON. Skipping auto-merge.`
              : `Warning: could not write the Claude Desktop config (${outcome.detail}).`,
        ),
      );
    }

    let codeInstalled = false;
    if (isClaudeCliAvailable()) {
      if (
        isYes(
          await io.ask(
            formatPrompt("   Add the server to Claude Code, for all your projects?", "yes"),
          ),
          true,
        )
      ) {
        try {
          claudeMcpAddJson(paths.rootDir);
          codeInstalled = true;
          io.out(indent('Claude Code: registered the "freshbooks" server at user scope.'));
        } catch (err) {
          io.out(indent(`Warning: could not register with Claude Code (${messageOf(err)}).`));
        }
      }
    }

    if (desktopInstalled || codeInstalled) {
      state.completed.add("install-config");
    } else {
      // The degraded path. The Book's `install-config` humanScript IS the
      // by-hand material — the manual Desktop and Claude Code config blocks —
      // so it prints here and nowhere else.
      io.out(indent("No automatic install was done. Add the server by hand:"));
      io.out("");
      io.out(renderStepScript(install, ctx));
    }

    state.currentStepId = "verify";
    showChecklist();

    // --- The parting note --------------------------------------------------
    io.out(`\n${"=".repeat(70)}\n   DONE!\n${"=".repeat(70)}`);

    const verify = enter("verify");
    io.out(renderStepHeading(verify));
    io.out(renderStepScript(verify, ctx));
    io.out("");

    io.out(
      indent(
        "With more than one login, name the account in your request, e.g.\n" +
          '"List recent invoices for acme". With a single login it is used by default.\n\n' +
          "Tokens auto-refresh on every server start and live in profiles/<name>.env, so\n" +
          "you shouldn't have to run this setup again unless a refresh token is revoked.\n" +
          "To add another login later, just re-run `npm run setup`.\n\n" +
          "The full walkthrough and troubleshooting are in SETUP.md.",
      ),
    );

    // Printed LAST, in full: the user is about to quit Claude, and this session
    // may end with it (the Book's `restart` agentGuidance says so).
    const restart = enter("restart");
    io.out(renderStepHeading(restart));
    io.out(renderStepScript(restart, ctx));
    io.out("");

    return 0;
  } catch (err) {
    reportFailure(io, bookStep(state.currentStepId), err);
    return 1;
  }
}

/** Read a file if it is there; "" otherwise. */
function readIfPresent(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * A step failed. Print its message and the Book's own troubleshooting rows for
 * the step we were standing on — never a stack.
 *
 * A raw stack tells a beginner nothing they can act on and is the single most
 * common way a setup transcript stops being followable. The message is
 * `err.message` only: an SDK rejection carries the request body (client secret,
 * authorization code, refresh token) on `err.config.data`, so serializing the
 * object would be a credential leak, not a debugging convenience.
 */
function reportFailure(io: WizardIO, step: SetupStep, err: unknown): void {
  io.out("");
  io.out(indent(`Setup stopped during: ${step.title}`));
  io.out(indent(messageOf(err)));
  if (step.troubleshooting.length > 0) {
    io.out("");
    io.out(indent("If this matches what you are seeing:"));
    for (const row of step.troubleshooting) {
      io.out(indent(`  ${row.symptom}`));
      io.out(indent(`    ${row.fix}`));
    }
  }
  io.out("");
  io.out(indent("The full walkthrough and troubleshooting are in SETUP.md."));
  io.out("");
}

/**
 * Ask for a profile name until it is valid, or blank (which cancels).
 *
 * `normalizeProfileName`'s message is shown verbatim — it is the one place that
 * states the naming rule, and `test/migrate-typed-errors.test.ts` exists because
 * this surface shows those messages to a human.
 */
async function askProfileName(io: WizardIO, question: string): Promise<string | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await io.ask(formatPrompt(`${question}, or blank to cancel`, null));
    if (!raw.trim()) return null;
    try {
      return normalizeProfileName(raw);
    } catch (err) {
      io.out(indent(messageOf(err)));
    }
  }
}

/**
 * One login: nickname → authorization → save.
 *
 * The ORDER is the point (the Book's `nickname` guidance: "Validate + check
 * availability BEFORE issuing the auth URL"). An auth URL minted before the name
 * is known to be free spends a single-use grant the wizard may then have nowhere
 * to put, and sends the user back through the browser for nothing.
 *
 * Returns whether a login was saved.
 */
async function addLogin(
  io: WizardIO,
  paths: SetupPaths,
  ctx: SetupCtx,
  state: WizardState,
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  // --- Nickname, validated and availability-checked ------------------------
  state.currentStepId = "nickname";
  const nickname = bookStep("nickname");
  io.out(renderStepHeading(nickname));
  io.out(renderStepScript(nickname, ctx));
  io.out("");

  let name: string | null = null;
  while (name === null) {
    // Appendix A: "the nickname prompt prints the step title 'Name this login'".
    const candidate = await askProfileName(io, `   ${nickname.title}`);
    if (candidate === null) {
      io.out(indent("Skipped adding a login."));
      return false;
    }
    if (fs.existsSync(path.join(paths.profilesDir, `${candidate}.env`))) {
      io.out(indent(`A login named "${candidate}" is already saved — pick a different name.`));
      continue;
    }
    name = candidate;
  }

  // --- Authorize -----------------------------------------------------------
  const authorize = bookStep("authorize");
  state.currentStepId = "authorize";
  const fbClient = buildOAuthClient(clientId, clientSecret, REDIRECT_URI);
  const authUrl = buildAuthUrl(fbClient);

  io.out(renderStepHeading(authorize));
  io.out(indent(authUrl));
  io.out("");
  // JUST IN TIME: the checklist prints here, immediately above the prompt it
  // describes — a dead-page reassurance delivered three screens earlier is a
  // reassurance the user has already scrolled past by the time they need it.
  io.out(renderStepScript(authorize, ctx));
  io.out("");

  let tokens: { accessToken: string; refreshToken: string } | null = null;
  while (!tokens) {
    const pasted = await io.ask(
      // Appendix A pins this prompt verbatim.
      formatPrompt(
        "   Paste the full address here (it starts with https://localhost/callback)",
        null,
      ),
    );
    const parsed = validateCallbackPaste(pasted);
    if (!parsed.ok) {
      io.out(indent(parsed.hint));
      io.out("");
      continue;
    }
    try {
      tokens = await exchangeCode(fbClient, parsed.code);
    } catch (err) {
      // One loop covers a truncated paste and a rejected/expired code alike, so
      // a single mistake re-prompts instead of aborting the whole wizard.
      io.out(indent(`That authorization code was rejected (${messageOf(err)}).`));
      io.out(indent("It may have expired — click the sign-in link again and re-copy."));
      io.out("");
    }
  }

  // --- Save ----------------------------------------------------------------
  const saveStep = bookStep("save-login");
  state.currentStepId = "save-login";
  io.out(renderStepHeading(saveStep));

  const authedClient = buildTokenClient(
    clientId,
    clientSecret,
    REDIRECT_URI,
    tokens.accessToken,
    tokens.refreshToken,
  );
  const { accountId, businessId, company } = await discoverIds(io, authedClient);

  const config: ProfileConfig = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accountId,
    businessId,
  };

  return saveLogin(io, paths, name, config, company);
}

/**
 * Resolve the accountId/businessId for a freshly authorized login.
 *
 * When a login belongs to more than one business, the businesses are listed by
 * LABEL and numbered — the same discipline the agent surface's exit-6 payload
 * imposes ("relay labels only, numbered, never IDs"): an account id is not
 * something a user can recognize, so offering it as the thing to choose between
 * invites the wrong pick. An accounting-only login may legitimately have a blank
 * businessId (U1) — that is accepted, not forced.
 */
async function discoverIds(
  io: WizardIO,
  authedClient: Client,
): Promise<{ accountId: string; businessId: string; company: string }> {
  let accountId = "";
  let businessId = "";
  let company = "";

  try {
    const { user, list } = await discoverMemberships(authedClient);
    io.out(
      indent(`Logged in as: ${user.firstName ?? ""} ${user.lastName ?? ""} (${user.email ?? ""})`),
    );

    if (list.length > 0) {
      let chosen = list[0];
      if (list.length > 1) {
        io.out("");
        io.out(indent("This login belongs to more than one business. Which one is this profile"));
        io.out(indent("for?"));
        io.out("");
        list.forEach((m, i) => io.out(indent(`  ${i + 1}) ${m.label}`)));
        io.out("");
        chosen = list[await askBusinessChoice(io, list.length)];
      }
      accountId = chosen.accountId;
      businessId = chosen.businessId;
      company = chosen.label;
    }
  } catch (err) {
    // `err.message` only — the rejection carries the request body.
    io.out(indent(`Could not look up this login's details (${messageOf(err)}).`));
    io.out(indent(bookFix("save-login", "exit 11")));
    io.out("");
  }

  if (!accountId) {
    accountId = await io.ask(formatPrompt("   Enter your Account ID", null));
  }
  if (!businessId) {
    businessId = await io.ask(
      formatPrompt("   Enter your Business ID (blank for an accounting-only login)", null),
    );
  }

  return { accountId, businessId, company };
}

/** Prompt for a 1-based business choice and return the 0-based index. */
async function askBusinessChoice(io: WizardIO, count: number): Promise<number> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await io.ask(formatPrompt(`   Enter the number of the business [1-${count}]`, null));
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
    io.out(indent("Please enter a valid number from the list."));
  }
}

/**
 * Persist a login through the SHARED guarded writer, and nowhere else.
 *
 * `saveProfile` is the pass-through to `writeNewProfile`, which hard-refuses a
 * duplicate refresh token or an existing profile name (A6/A7/R2) — so a clashing
 * name can never silently clobber another login's tokens. The wizard's job is to
 * turn each typed refusal into a question a human can answer.
 *
 * The same-account branch is the one that matters: `onSameAccount: "refuse"`
 * stops BEFORE anything is written, because un-quarantining a superseded token
 * family is a lockout vector. Only an explicit human confirmation re-runs the
 * write with `"warn"`, and it is followed by `markDistinctLogin` over the WHOLE
 * accountId group — discovery quarantines every unmarked member of that group
 * (`src/profiles.ts`), so marking only the new file would leave the incumbent
 * login excluded from rotation.
 */
async function saveLogin(
  io: WizardIO,
  paths: SetupPaths,
  name: string,
  config: ProfileConfig,
  company: string,
): Promise<boolean> {
  let currentName = name;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const profilePath = saveProfile(paths.profilesDir, currentName, config, {
        onSameAccount: "refuse",
      });
      printLoginSummary(io, currentName, company, config.accountId, profilePath);
      return true;
    } catch (err) {
      if (!(err instanceof ProfileWriteError)) throw err;

      if (err.code === "SAME_ACCOUNT") {
        io.out(indent(err.message));
        io.out("");
        const distinct = isYes(
          await io.ask(
            formatPrompt(
              "   Is this a DIFFERENT PERSON'S login for the same company?",
              "no",
            ),
          ),
        );
        if (!distinct) {
          io.out(indent("Nothing was saved for this login."));
          return false;
        }
        const profilePath = saveProfile(paths.profilesDir, currentName, config, {
          onSameAccount: "warn",
        });
        // Group-wide, and only after a human said yes.
        markDistinctLogin(paths.profilesDir, config.accountId);
        printLoginSummary(io, currentName, company, config.accountId, profilePath);
        return true;
      }

      if (err.code === "NAME_TAKEN") {
        io.out(indent(err.message));
        const retry = await askProfileName(io, "   Name this login");
        if (!retry) {
          io.out(indent("Nothing was saved for this login."));
          return false;
        }
        currentName = retry;
        continue;
      }

      // DUPLICATE_TOKEN: this FreshBooks login is already connected under
      // another nickname. A second file holding the same refresh token
      // guarantees a double-rotation lockout, so there is nothing to retry.
      io.out(indent(err.message));
      io.out(indent("This FreshBooks login is already connected under another nickname."));
      return false;
    }
  }
}

/**
 * The per-login summary (spec §Surface 1): nickname, company, account ID — and
 * never a token. The Book's `save-login` successCheck says exactly that, and
 * the file path is safe to add because a path names a file, not its contents.
 */
function printLoginSummary(
  io: WizardIO,
  name: string,
  company: string,
  accountId: string,
  profilePath: string,
): void {
  io.out(indent("Saved this login:"));
  io.out(indent(`  nickname:   ${name}`));
  io.out(indent(`  company:    ${company || "(none reported)"}`));
  io.out(indent(`  account ID: ${accountId || "(none)"}`));
  io.out(indent(`  saved to:   ${profilePath}`));
}

// ---------------------------------------------------------------------------
// Entry point — the only place readline, the console and the real paths meet
// ---------------------------------------------------------------------------

async function main() {
  // The headless (agent) surface shares this entry point: `--headless <verb>`
  // hands the whole run to the verb dispatcher and the wizard never starts.
  // `process.exitCode` rather than `process.exit()` — the latter can truncate a
  // piped `--json` stdout before it flushes.
  if (process.argv.includes("--headless")) {
    process.exitCode = await runHeadless(process.argv.slice(2));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const io: WizardIO = {
    ask: (question) =>
      new Promise<string>((resolve) => rl.question(question, (answer) => resolve(answer.trim()))),
    out: (line) => console.log(line),
  };

  try {
    process.exitCode = await runWizard(io, defaultPaths());
  } finally {
    rl.close();
  }
}

// Only auto-run when invoked as a script (ts-node scripts/setup.ts), never when
// imported (the decoupling and wizard tests import this module).
if (require.main === module) {
  main().catch((err) => {
    // Message only, never the object: an SDK rejection carries the request body.
    console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
