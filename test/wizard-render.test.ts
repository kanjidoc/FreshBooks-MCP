import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPrompt,
  renderChecklist,
  runWizard,
  validateCallbackPaste,
  wizardSteps,
  type WizardIO,
} from "../scripts/setup";
import type { SetupPaths } from "../scripts/setup-headless";
import {
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  discoverMemberships,
  exchangeCode,
  isClaudeCliAvailable,
  runBuild,
  type Memberships,
} from "../scripts/setup-core";
import { SETUP_FLOW, type SetupCtx, type SetupStep } from "../src/setup-flow";

/**
 * THE WIZARD'S RENDERERS AND ITS TRANSCRIPT ORDER (T17 + T18).
 *
 * Two suites live here. The first drives the wizard's pure renderers
 * (`formatPrompt`, `renderChecklist`, `validateCallbackPaste`) with literal
 * arguments — no readline, no fs, no clock, so every assertion is a total
 * function of its inputs. The second drives the whole wizard through its
 * injected-I/O seam, `runWizard(io, paths)`, with a scripted `ask` and a
 * capturing `out`, and asserts the ORDER of what a human is told. Sequencing is
 * the human outcome the review asked to be machine-verified: a checklist that
 * arrives after the paste prompt, or an auth URL issued before the nickname is
 * validated, is a defect no per-string test can see.
 *
 * SAFETY: every `runWizard` run is pointed at a throwaway `SetupPaths` rooted in
 * a fresh temp dir — the developer's real `.env`, `profiles/`, `.mcp.json`,
 * `~/.claude.json` and Claude Desktop config are never read or written, and
 * `runMigration` derives its own paths from that same temp `rootDir`.
 * `scripts/setup-core` is mocked at every point that would reach FreshBooks or
 * spawn a process (the OAuth calls, the `claude` CLI, the build), so nothing
 * here makes a network call or starts a child process. Importing
 * `scripts/setup` is inert — its `main()` runs only under
 * `require.main === module`.
 *
 * The spec pins the two yes/no renderings verbatim
 * (`docs/superpowers/specs/2026-08-06-setup-rework-design.md` §Surface 1:
 * "both default renderings specified: `(y = yes, Enter = no)` and
 * `(Enter = yes, n = no)`"), and the plan pins the checklist's three markers
 * and its `(login N)` annotation. Both are asserted as literals here so a
 * paraphrase fails rather than silently reaching a user.
 */

vi.mock("../scripts/setup-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/setup-core")>();
  return {
    ...actual,
    // Network.
    buildOAuthClient: vi.fn(),
    buildTokenClient: vi.fn(),
    buildAuthUrl: vi.fn(),
    exchangeCode: vi.fn(),
    discoverMemberships: vi.fn(),
    // Process spawns.
    isClaudeCliAvailable: vi.fn(),
    claudeMcpAddJson: vi.fn(),
    runBuild: vi.fn(),
  };
});

// The plan's drafted checklist markers — asserted as literals here, never
// imported from the implementation (which would make every marker assertion
// below tautological).
const DONE = "✓";
const CURRENT = "▶";
const PENDING = "○";

const CTX: SetupCtx = {
  projectDir: "/tmp/does-not-exist-wizard-render",
  redirectUri: "https://localhost/callback",
};

/** Wizard-surface titles in Book order, migration NOT applying. */
const WIZARD_TITLES = SETUP_FLOW.filter(
  (s) => s.surfaces.includes("wizard") && (s.appliesIf?.(CTX) ?? true),
).map((s) => s.title);

/** The per-login steps, in Book order — the group the checklist repeats. */
const PER_LOGIN_TITLES = SETUP_FLOW.filter(
  (s) => s.surfaces.includes("wizard") && s.repeats === "per-login",
).map((s) => s.title);

function lines(block: string): string[] {
  return block.split("\n");
}

// ---------------------------------------------------------------------------
// formatPrompt
// ---------------------------------------------------------------------------

describe("formatPrompt", () => {
  it("renders the Enter-means-yes default exactly as the spec drafts it", () => {
    expect(formatPrompt("Add the server to Claude Desktop?", "yes")).toBe(
      "Add the server to Claude Desktop? (Enter = yes, n = no): ",
    );
  });

  it("renders the Enter-means-no default exactly as the spec drafts it", () => {
    expect(formatPrompt("Add another FreshBooks login now?", "no")).toBe(
      "Add another FreshBooks login now? (y = yes, Enter = no): ",
    );
  });

  it("renders a free-text prompt with no yes/no hint", () => {
    expect(formatPrompt("Enter your Client ID", null)).toBe("Enter your Client ID: ");
  });

  it("carries the spec's two parentheticals verbatim, and never swaps them", () => {
    // The failure this pins: a defaulted-to-yes prompt that tells the user
    // Enter means no (or vice versa) silently inverts every consent in the
    // wizard.
    expect(formatPrompt("Q", "yes")).toContain("(Enter = yes, n = no)");
    expect(formatPrompt("Q", "yes")).not.toContain("(y = yes, Enter = no)");
    expect(formatPrompt("Q", "no")).toContain("(y = yes, Enter = no)");
    expect(formatPrompt("Q", "no")).not.toContain("(Enter = yes, n = no)");
  });

  it("leaves the question text untouched, including leading indentation", () => {
    expect(formatPrompt("   Name for this login (e.g. 'acme')", null)).toBe(
      "   Name for this login (e.g. 'acme'): ",
    );
  });

  it("ends every rendering with a colon and one space, ready for readline", () => {
    for (const def of ["yes", "no", null] as const) {
      expect(formatPrompt("Q", def).endsWith(": ")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// renderChecklist — surface filtering and order
// ---------------------------------------------------------------------------

describe("renderChecklist: which steps appear", () => {
  it("renders the wizard-surface steps, in Book order, one per line", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "node-install", 1);
    expect(lines(block).map((l) => l.slice(2))).toEqual(WIZARD_TITLES);
  });

  it("omits docs-only steps", () => {
    const docsOnly = SETUP_FLOW.filter((s) => !s.surfaces.includes("wizard"));
    // premise: the Book still has docs-only steps to omit
    expect(docsOnly.length).toBeGreaterThan(0);
    const block = renderChecklist(SETUP_FLOW, CTX, [], "node-install", 1);
    for (const step of docsOnly) expect(block).not.toContain(step.title);
  });

  it("is idempotent under pre-filtering — a wizard-only list renders identically", () => {
    const preFiltered = SETUP_FLOW.filter((s) => s.surfaces.includes("wizard"));
    expect(renderChecklist(preFiltered, CTX, ["build"], "developer-app", 1)).toBe(
      renderChecklist(SETUP_FLOW, CTX, ["build"], "developer-app", 1),
    );
  });

  it("honors the caller's order rather than re-sorting to Book order", () => {
    // Load-bearing for T18: the wizard performs `build` late (today's STEP 4)
    // while the Book lists it early, so the wizard must be able to hand in its
    // own order and have the checklist follow.
    const wizard = SETUP_FLOW.filter((s) => s.surfaces.includes("wizard"));
    const build = wizard.find((s) => s.id === "build")!;
    const reordered = [...wizard.filter((s) => s.id !== "build"), build];
    const rendered = lines(renderChecklist(reordered, CTX, [], "verify", 1)).map((l) => l.slice(2));
    expect(rendered[rendered.length - 1]).toBe(build.title);
    expect(rendered).not.toEqual(WIZARD_TITLES);
  });

  it("emits no trailing newline — the caller owns the surrounding spacing", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "node-install", 1);
    expect(block.endsWith("\n")).toBe(false);
    expect(block.startsWith("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderChecklist — appliesIf filtering
// ---------------------------------------------------------------------------

describe("renderChecklist: appliesIf filtering", () => {
  const migrate = SETUP_FLOW.find((s) => s.id === "migrate-legacy")!;

  it("premise: migrate-legacy is a wizard step gated on legacyNeedsMigration", () => {
    expect(migrate.surfaces).toContain("wizard");
    expect(migrate.appliesIf).toBeTypeOf("function");
  });

  it("hides the migration step when the caller has not seen an unmigrated .env", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "nickname", 1);
    expect(block).not.toContain(migrate.title);
  });

  it("shows the migration step when the caller says the legacy .env needs it", () => {
    const block = renderChecklist(
      SETUP_FLOW,
      { ...CTX, legacyNeedsMigration: true },
      [],
      "migrate-legacy",
      1,
    );
    expect(block).toContain(`${CURRENT} ${migrate.title}`);
  });
});

// ---------------------------------------------------------------------------
// renderChecklist — markers
// ---------------------------------------------------------------------------

describe("renderChecklist: markers", () => {
  it("marks done, current and pending steps distinctly", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, ["node-install", "build"], "developer-app", 1);
    expect(block).toContain(`${DONE} Install Node.js (the engine)`);
    expect(block).toContain(`${DONE} Build the server`);
    expect(block).toContain(`${CURRENT} Create your FreshBooks app connection`);
    expect(block).toContain(`${PENDING} Hand over the app credentials`);
  });

  it("lets current win over done — where we ARE beats what already passes", () => {
    // A re-run reaches install-config with the config already written: its
    // check passes, so the wizard puts it in doneIds while standing on it.
    const block = renderChecklist(SETUP_FLOW, CTX, ["install-config"], "install-config", 1);
    expect(block).toContain(`${CURRENT} Connect the server to your Claude`);
    expect(block).not.toContain(`${DONE} Connect the server to your Claude`);
  });

  it("marks nothing current when currentId names no rendered step", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "get-project", 1);
    expect(block).not.toContain(CURRENT);
  });

  it("ignores doneIds entries that name no rendered step", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, ["no-such-step"], "node-install", 1);
    expect(block).not.toContain("no-such-step");
  });
});

// ---------------------------------------------------------------------------
// renderChecklist — repeats expansion
// ---------------------------------------------------------------------------

describe("renderChecklist: per-login repeats", () => {
  it("premise: the Book's per-login steps are contiguous in Book order", () => {
    const wizard = SETUP_FLOW.filter((s) => s.surfaces.includes("wizard"));
    const idx = wizard.map((s, i) => (s.repeats === "per-login" ? i : -1)).filter((i) => i >= 0);
    expect(idx.length).toBe(PER_LOGIN_TITLES.length);
    expect(idx[idx.length - 1] - idx[0]).toBe(idx.length - 1);
  });

  it("renders one un-annotated instance of each per-login step for a single login", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "nickname", 1);
    expect(block).not.toContain("(login ");
    for (const title of PER_LOGIN_TITLES) {
      expect(lines(block).filter((l) => l.endsWith(title)).length).toBe(1);
    }
  });

  it("expands the per-login group once per login, annotated, in chronological order", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "authorize", 3);
    const suffixed = lines(block)
      .filter((l) => l.includes("(login "))
      .map((l) => l.slice(2));
    expect(suffixed).toEqual([
      ...PER_LOGIN_TITLES.map((t) => `${t} (login 1)`),
      ...PER_LOGIN_TITLES.map((t) => `${t} (login 2)`),
      ...PER_LOGIN_TITLES.map((t) => `${t} (login 3)`),
    ]);
  });

  it("treats earlier logins as finished and applies the markers to the live one", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, ["nickname"], "authorize", 2);
    expect(block).toContain(`${DONE} Name this login (login 1)`);
    expect(block).toContain(`${DONE} Sign in and approve the connection (login 1)`);
    expect(block).toContain(`${DONE} Save the login (login 1)`);
    expect(block).toContain(`${DONE} Name this login (login 2)`);
    expect(block).toContain(`${CURRENT} Sign in and approve the connection (login 2)`);
    expect(block).toContain(`${PENDING} Save the login (login 2)`);
  });

  it("leaves non-repeating steps unannotated and unduplicated at any login count", () => {
    const block = renderChecklist(SETUP_FLOW, CTX, [], "save-login", 4);
    for (const title of WIZARD_TITLES.filter((t) => !PER_LOGIN_TITLES.includes(t))) {
      expect(lines(block).filter((l) => l.endsWith(title)).length).toBe(1);
    }
  });

  it("renders one pending un-annotated group before any login has started", () => {
    // loginCount 0 — the wizard is still on developer-app; the user should
    // still see the per-login work that is coming.
    const block = renderChecklist(SETUP_FLOW, CTX, [], "developer-app", 0);
    expect(block).not.toContain("(login ");
    for (const title of PER_LOGIN_TITLES) {
      expect(block).toContain(`${PENDING} ${title}`);
    }
  });

  it("clamps a nonsensical login count to a single group rather than throwing", () => {
    for (const count of [-3, Number.NaN, 1.6]) {
      const block = renderChecklist(SETUP_FLOW, CTX, [], "nickname", count);
      expect(lines(block).map((l) => l.slice(2))).toEqual(WIZARD_TITLES);
    }
  });
});

// ---------------------------------------------------------------------------
// renderChecklist — single-sourcing: it consumes doneIds, it never re-checks
// ---------------------------------------------------------------------------

describe("renderChecklist: single-sourced completion", () => {
  it("never calls a step's check() — doneIds is the wizard's answer, computed once", () => {
    let calls = 0;
    const spy: SetupStep = {
      id: "spy",
      title: "Spy step",
      who: "either",
      surfaces: ["wizard"],
      summary: "s",
      humanScript: [],
      agentGuidance: "",
      successCheck: "",
      check: () => {
        calls += 1;
        throw new Error("renderChecklist must not evaluate check()");
      },
      troubleshooting: [],
    };
    const block = renderChecklist([spy], CTX, [], "spy", 1);
    expect(calls).toBe(0);
    expect(block).toBe(`${CURRENT} Spy step`);
  });

  it("does not require ctx.exists — the checklist asks the filesystem nothing", () => {
    // CTX deliberately omits `exists`; a renderer that called check() on the
    // Book's real steps would throw on `ctx.exists!(...)`.
    expect(CTX.exists).toBeUndefined();
    expect(() => renderChecklist(SETUP_FLOW, CTX, [], "build", 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateCallbackPaste — the paste validator (T18)
// ---------------------------------------------------------------------------

/**
 * The single canonical hint, owned by the Book's `authorize` step (spec
 * §Surface 1: "single canonical hint, shared with the `authorize`
 * troubleshooting row"). Read from the Book here rather than restated, so a
 * validator that invents its own wording fails.
 */
const PASTE_HINT = SETUP_FLOW.find((s) => s.id === "authorize")!.troubleshooting.find((t) =>
  t.symptom.includes("address looks incomplete"),
)!.fix;

describe("validateCallbackPaste", () => {
  it("premise: the Book carries the truncated-paste hint this validator quotes", () => {
    expect(PASTE_HINT).toContain("That was only part of the address");
  });

  it("accepts a full callback address and returns its code", () => {
    expect(validateCallbackPaste("https://localhost/callback?code=abc123")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("tolerates the whitespace a terminal paste drags along", () => {
    expect(validateCallbackPaste("  https://localhost/callback?code=abc123\t")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("rejects a scheme-less paste with the Book's hint, never a paraphrase", () => {
    // The spec's named case: the address bar's displayed text, which drops the
    // scheme, is the paste a beginner actually produces.
    const result = validateCallbackPaste("localhost/callback?code=abc123");
    expect(result).toEqual({ ok: false, hint: PASTE_HINT });
  });

  it("rejects an address carrying no code at all with the same hint", () => {
    expect(validateCallbackPaste("https://localhost/callback")).toEqual({
      ok: false,
      hint: PASTE_HINT,
    });
  });

  it("rejects empty, junk and unparseable input rather than sending it to FreshBooks", () => {
    for (const input of ["", "   ", "abc123", "https://", "https://loc alhost/?code=x"]) {
      expect(validateCallbackPaste(input).ok, `accepted: ${JSON.stringify(input)}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// runWizard — the transcript-order suite (T18)
// ---------------------------------------------------------------------------

/** The stubbed authorization URL. Stub-owned, unlike every other pinned string. */
const AUTH_URL =
  "https://auth.freshbooks.com/service/auth/oauth/authorize?client_id=cid-123&response_type=code";

const ACCESS = "at-wizard-fixture";
const REFRESH = "rt-wizard-fixture";
const ACME = { label: "Acme Inc", accountId: "AC-1", businessId: "9001" };
const BETA = { label: "Beta LLC", accountId: "AC-2", businessId: "9002" };

const roots: string[] = [];

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(opts: { baseEnv?: string } = {}): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-wizard-"));
  roots.push(rootDir);
  if (opts.baseEnv !== undefined) {
    writeFileSync(join(rootDir, ".env"), opts.baseEnv, { mode: 0o600 });
  }
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: join(rootDir, "claude_desktop_config.json"),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(rootDir, "dot-claude.json"),
  };
}

interface ScriptedRun {
  /** Every `out()` line AND every prompt, in the order the human met them. */
  transcript: string;
  code: number;
  paths: SetupPaths;
  /** Scripted answers the wizard never asked for. */
  unused: string[];
}

/**
 * Drive the whole wizard with a scripted `ask` and a capturing `out`.
 *
 * Prompts are pushed into the same buffer as the output, because a prompt IS
 * part of the transcript — the paste prompt's literal is one of the strings
 * Appendix A pins, and it must be orderable against the copy around it.
 *
 * An unscripted question fails the TEST, not just the wizard. Throwing out of
 * `ask` alone is not enough: `runWizard` catches everything and turns it into
 * exit 1, so a script that has drifted out of step with the prompts would be
 * swallowed into a plausible-looking failed run — and any test whose assertions
 * are all negative ("this file was not written", "this marker is absent") would
 * keep passing while never reaching the branch it names. So the exhausted queue
 * is RECORDED as well as thrown, and the helper re-raises after the run.
 */
async function runScripted(answers: string[], paths: SetupPaths = fixture()): Promise<ScriptedRun> {
  const buffer: string[] = [];
  const queue = [...answers];
  const unscripted: string[] = [];
  const io: WizardIO = {
    ask: async (question: string) => {
      buffer.push(question);
      if (queue.length === 0) {
        unscripted.push(question);
        throw new Error(`the wizard asked an unscripted question: ${JSON.stringify(question)}`);
      }
      return queue.shift()!.trim();
    },
    out: (line: string) => {
      buffer.push(line);
    },
  };
  const code = await runWizard(io, paths);
  if (unscripted.length > 0) {
    throw new Error(
      `the wizard asked ${unscripted.length} unscripted question(s); the script is out of ` +
        `step with the flow:\n  ${unscripted.join("\n  ")}`,
    );
  }
  return { transcript: buffer.join("\n"), code, paths, unused: queue };
}

/** A `discoverMemberships` result with the given business list. */
function memberships(list: Memberships["list"]): Memberships {
  return { user: { firstName: "Ada", lastName: "L", email: "ada@example.com" }, list };
}

/** Seed `profiles/<name>.env` the way the guarded writer leaves it. */
function seedProfile(paths: SetupPaths, name: string, accountId: string, refreshToken: string) {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeFileSync(
    path,
    `FRESHBOOKS_ACCESS_TOKEN=at-${name}\nFRESHBOOKS_REFRESH_TOKEN=${refreshToken}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${accountId}\nFRESHBOOKS_BUSINESS_ID=9001\n`,
    { mode: 0o600 },
  );
  return path;
}

/** The base `.env` an older single-login install leaves behind. */
const LEGACY_ENV =
  "FRESHBOOKS_CLIENT_ID=cid-123\nFRESHBOOKS_CLIENT_SECRET=sec-abc\n" +
  "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n" +
  "FRESHBOOKS_ACCESS_TOKEN=at-legacy\nFRESHBOOKS_REFRESH_TOKEN=rt-legacy\n" +
  "FRESHBOOKS_ACCOUNT_ID=AC-LEGACY\n";

/**
 * The happy path's answers, in prompt order: client id, client secret,
 * nickname, one truncated paste, the real paste, "no more logins", "no Desktop
 * install". The `claude` CLI is absent by default, so no Code prompt follows.
 */
const HAPPY_ANSWERS = [
  "cid-123",
  "sec-abc",
  "main",
  "localhost/callback?code=abc123",
  "https://localhost/callback?code=abc123",
  "",
  "n",
];

beforeEach(() => {
  vi.clearAllMocks();
  // `writeNewProfile`'s same-account path warns through console.warn; keep the
  // test output clean without swallowing anything the wizard itself prints.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(buildOAuthClient).mockReturnValue({ stub: "oauth" } as never);
  vi.mocked(buildTokenClient).mockReturnValue({ stub: "token" } as never);
  vi.mocked(buildAuthUrl).mockReturnValue(AUTH_URL);
  vi.mocked(exchangeCode).mockResolvedValue({ accessToken: ACCESS, refreshToken: REFRESH });
  vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME]));
  vi.mocked(isClaudeCliAvailable).mockReturnValue(false);
  vi.mocked(runBuild).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("runWizard: the order a human meets the copy", () => {
  it("sequences nickname → auth URL → just-in-time checklist → paste prompt → DONE! → restart", async () => {
    const run = await runScripted(HAPPY_ANSWERS);
    const t = run.transcript;
    const idx = (s: string) => {
      const i = t.indexOf(s);
      expect(i, `missing: ${s}`).toBeGreaterThanOrEqual(0);
      return i;
    };

    // All asserted strings are Book/Appendix-A-owned (the wizard prompt
    // literals "Name this login", "Paste the full address here" and "DONE!" are
    // drafted in Appendix A) except the auth-URL prefix, which is stub-owned.
    expect(idx("Name this login")).toBeLessThan(idx("https://auth.freshbooks.com"));
    expect(idx("CAN'T BE REACHED")).toBeGreaterThan(idx("https://auth.freshbooks.com"));
    expect(idx("CAN'T BE REACHED")).toBeLessThan(idx("Paste the full address here"));
    expect(t).toContain("never into this chat");
    expect(idx("Our conversation is saved")).toBeGreaterThan(idx("DONE!"));
    expect(t).toContain("That was only part of the address");

    expect(run.code).toBe(0);
    expect(run.unused).toEqual([]);
  });

  it("prints the paste prompt exactly as Appendix A drafts it", async () => {
    const { transcript } = await runScripted(HAPPY_ANSWERS);
    expect(transcript).toContain(
      "Paste the full address here (it starts with https://localhost/callback): ",
    );
  });

  it("issues the auth URL only after the nickname is accepted", async () => {
    // A taken nickname must be rejected BEFORE the URL is minted — the Book's
    // `nickname` guidance: "Validate + check availability BEFORE issuing the
    // auth URL." A URL issued first burns a grant the wizard cannot save.
    const paths = fixture();
    seedProfile(paths, "main", "AC-9", "rt-other");

    const run = await runScripted(
      ["cid-123", "sec-abc", "main", "second", "https://localhost/callback?code=abc123", "", "n"],
      paths,
    );

    // One URL only — the rejected name never reached the OAuth builder — and
    // the rejection landed before it.
    expect(vi.mocked(buildAuthUrl).mock.calls).toHaveLength(1);
    const rejected = run.transcript.indexOf('A login named "main" is already saved');
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(rejected).toBeLessThan(run.transcript.indexOf("https://auth.freshbooks.com"));
    expect(existsSync(join(paths.profilesDir, "second.env"))).toBe(true);
  });

  it("renders the developer-app step from the Book — no hand-written STEP 1 copy", async () => {
    const { transcript } = await runScripted(HAPPY_ANSWERS);
    const book = SETUP_FLOW.find((s) => s.id === "developer-app")!;
    expect(transcript).toContain(book.title);
    for (const phrase of book.docPhrases!) expect(transcript).toContain(phrase);
    // The stale pre-Book portal script said "Create an App"; the probed truth
    // is "Create New App". A regression to the old copy fails here.
    expect(transcript).toContain("click Create New App");
    expect(transcript).not.toContain('Click "Create an App"');
  });

  it("prints the per-login summary — nickname, company, account ID, never tokens", async () => {
    const { transcript } = await runScripted(HAPPY_ANSWERS);
    expect(transcript).toContain("main");
    expect(transcript).toContain("Acme Inc");
    expect(transcript).toContain("AC-1");
    expect(transcript).not.toContain(ACCESS);
    expect(transcript).not.toContain(REFRESH);
  });

  it("keeps the STEP 4 build and the STEP 5 install prompts", async () => {
    const paths = fixture();
    const { transcript } = await runScripted(
      ["cid-123", "sec-abc", "main", "https://localhost/callback?code=abc123", "", "y"],
      paths,
    );
    expect(vi.mocked(runBuild)).toHaveBeenCalledWith(paths.rootDir);
    expect(transcript).toContain("Add the server to Claude Desktop?");
    expect(existsSync(paths.desktopConfigPath)).toBe(true);
  });

  it("writes .mcp.json through the MERGING installer, keeping foreign servers", async () => {
    const paths = fixture();
    writeFileSync(
      paths.mcpJsonPath,
      JSON.stringify({ mcpServers: { other: { command: "/bin/other", args: [] } } }, null, 2),
    );

    await runScripted(
      ["cid-123", "sec-abc", "main", "https://localhost/callback?code=abc123", "", "n"],
      paths,
    );

    const written = JSON.parse(readFileSync(paths.mcpJsonPath, "utf8"));
    expect(written.mcpServers.other).toEqual({ command: "/bin/other", args: [] });
    expect(written.mcpServers.freshbooks).toBeDefined();
  });

  it("ticks the per-login run off the checklist once a login is saved", async () => {
    // The failure this pins: a checklist that still shows the login steps as
    // pending after the login is on disk tells the user their work did not
    // count — the append-only rendering's whole job is the opposite.
    const { transcript } = await runScripted(HAPPY_ANSWERS);
    const perLogin = SETUP_FLOW.filter((s) => s.repeats === "per-login");
    expect(perLogin.length).toBeGreaterThan(0);
    for (const step of perLogin) {
      expect(transcript, `never ticked: ${step.id}`).toContain(`✓ ${step.title}`);
    }
  });

  it("annotates and ticks each login's group across a two-login run", async () => {
    vi.mocked(exchangeCode)
      .mockResolvedValueOnce({ accessToken: "at-1", refreshToken: "rt-1" })
      .mockResolvedValueOnce({ accessToken: "at-2", refreshToken: "rt-2" });
    vi.mocked(discoverMemberships)
      .mockResolvedValueOnce(memberships([ACME]))
      .mockResolvedValueOnce(memberships([BETA]));

    const { transcript, code } = await runScripted([
      "cid-123",
      "sec-abc",
      "one",
      "https://localhost/callback?code=one",
      "y",
      "two",
      "https://localhost/callback?code=two",
      "",
      "n",
    ]);

    expect(code).toBe(0);
    expect(transcript).toContain("✓ Name this login (login 1)");
    expect(transcript).toContain("✓ Name this login (login 2)");
    expect(transcript).toContain("✓ Save the login (login 2)");
  });

  it("keeps a saved login ticked when a LATER attempt is cancelled", async () => {
    // The failure this pins is the same "your work did not count" misrender as
    // the test above, arriving by the other road: the login IS on disk, and it
    // is the ADDITIONAL attempt that goes nowhere. Un-ticking the per-login run
    // then re-renders the saved login's group as pending, which reads as the
    // wizard having thrown the finished work away.
    const paths = fixture();
    const run = await runScripted(
      [
        "cid-123",
        "sec-abc",
        "main",
        "https://localhost/callback?code=abc123",
        "y", // add another login…
        "", // …then cancel it with a blank nickname
        "", // no more logins
        "n", // no Claude Desktop install
      ],
      paths,
    );

    expect(run.code).toBe(0);
    expect(run.unused).toEqual([]);
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(true);

    // Only the checklists printed AFTER the cancellation can regress, so the
    // assertion is scoped to the transcript from that point on.
    const cancelled = run.transcript.indexOf("Skipped adding a login.");
    expect(cancelled).toBeGreaterThanOrEqual(0);
    const after = run.transcript.slice(cancelled);
    for (const step of SETUP_FLOW.filter((s) => s.repeats === "per-login")) {
      expect(after, `un-ticked by a cancelled attempt: ${step.id}`).toContain(
        `${DONE} ${step.title}`,
      );
      expect(after, `re-rendered as pending: ${step.id}`).not.toContain(`${PENDING} ${step.title}`);
    }
  });

  it("keeps a saved login ticked when a later attempt is refused as the same account", async () => {
    // Same regression, reached through `saveLogin`'s typed-refusal branch
    // rather than a cancelled nickname: an attempt that ends in
    // "Nothing was saved for this login." must not un-tick the login that WAS
    // saved a moment earlier.
    vi.mocked(exchangeCode)
      .mockResolvedValueOnce({ accessToken: "at-1", refreshToken: "rt-1" })
      .mockResolvedValueOnce({ accessToken: "at-2", refreshToken: "rt-2" });

    const paths = fixture();
    const run = await runScripted(
      [
        "cid-123",
        "sec-abc",
        "main",
        "https://localhost/callback?code=one",
        "y", // add another…
        "second",
        "https://localhost/callback?code=two",
        "n", // …which is the SAME account: not a different person → refused
        "", // no more logins
        "n", // no Claude Desktop install
      ],
      paths,
    );

    expect(run.code).toBe(0);
    expect(run.unused).toEqual([]);
    expect(existsSync(join(paths.profilesDir, "second.env"))).toBe(false);
    // Which refusal it was matters: this test claims the checklist survives a
    // SAME_ACCOUNT decline, so the confirmation must actually have been asked.
    expect(run.transcript).toContain("Is this a DIFFERENT PERSON'S login for the same company?");

    const refused = run.transcript.indexOf("Nothing was saved for this login.");
    expect(refused).toBeGreaterThanOrEqual(0);
    const after = run.transcript.slice(refused);
    for (const step of SETUP_FLOW.filter((s) => s.repeats === "per-login")) {
      expect(after, `un-ticked by a refused attempt: ${step.id}`).toContain(
        `${DONE} ${step.title}`,
      );
      expect(after, `re-rendered as pending: ${step.id}`).not.toContain(`${PENDING} ${step.title}`);
    }
  });

  it("leaves base .env holding app credentials only", async () => {
    const paths = fixture();
    await runScripted(HAPPY_ANSWERS, paths);
    const env = readFileSync(paths.baseEnvPath, "utf8");
    expect(env).toContain("FRESHBOOKS_CLIENT_ID=cid-123");
    expect(env).not.toContain("FRESHBOOKS_REFRESH_TOKEN");
    expect(env).not.toContain("FRESHBOOKS_ACCESS_TOKEN");
  });
});

describe("runWizard: the migration gate", () => {
  it("renders the Book's migrate-legacy copy and moves the tokens on yes", async () => {
    const paths = fixture({ baseEnv: LEGACY_ENV });

    const run = await runScripted(
      ["y", "legacy", "cid-123", "sec-abc", "", "n"],
      paths,
    );

    expect(run.transcript).toContain("one-time key");
    expect(run.transcript).toContain("nothing is deleted");
    expect(run.transcript).toContain("Migrated existing tokens");
    const moved = readFileSync(join(paths.profilesDir, "legacy.env"), "utf8");
    expect(moved).toContain("FRESHBOOKS_REFRESH_TOKEN=rt-legacy");
    // The marker survives the base `.env` rewrite, so a second run does not
    // re-offer the migration.
    expect(readFileSync(paths.baseEnvPath, "utf8")).toContain("FRESHBOOKS_MIGRATED=1");
  });

  it("deletes nothing when the answer is no — the humanScript's promise", async () => {
    const paths = fixture({ baseEnv: LEGACY_ENV });

    const run = await runScripted(["n"], paths);

    expect(run.code).toBe(0);
    // Every legacy token is still exactly where it was.
    expect(readFileSync(paths.baseEnvPath, "utf8")).toBe(LEGACY_ENV);
    expect(existsSync(paths.profilesDir)).toBe(false);
  });

  it("is not offered when the base .env carries no unmigrated tokens", async () => {
    const paths = fixture({
      baseEnv: "FRESHBOOKS_CLIENT_ID=cid-123\nFRESHBOOKS_CLIENT_SECRET=sec-abc\n",
    });
    const { transcript } = await runScripted(HAPPY_ANSWERS, paths);
    expect(transcript).not.toContain("one-time key");
  });
});

describe("runWizard: the same-account confirmation", () => {
  it("marks the WHOLE accountId group as distinct logins on confirm", async () => {
    const paths = fixture();
    const incumbent = seedProfile(paths, "acme", "AC-1", "rt-incumbent");

    const run = await runScripted(
      ["cid-123", "sec-abc", "second", "https://localhost/callback?code=abc123", "y", "", "n"],
      paths,
    );

    expect(run.code).toBe(0);
    const written = join(paths.profilesDir, "second.env");
    expect(existsSync(written)).toBe(true);
    // Group-wide: the incumbent is marked too, or discovery quarantines it.
    expect(readFileSync(incumbent, "utf8")).toContain("# freshbooks-distinct-login");
    expect(readFileSync(written, "utf8")).toContain("# freshbooks-distinct-login");
  });

  it("writes nothing when the confirmation is declined", async () => {
    const paths = fixture();
    const incumbent = seedProfile(paths, "acme", "AC-1", "rt-incumbent");

    const run = await runScripted(
      [
        "cid-123",
        "sec-abc",
        "second",
        "https://localhost/callback?code=abc123",
        "n", // NOT a different person's login → refuse, write nothing
        "n", // nothing is saved, so the wizard offers another attempt: no
        "n", // no Claude Desktop install
      ],
      paths,
    );

    // NON-VACUITY FIRST. Every assertion below this one is negative — a file
    // that is absent, a marker that is not there — and a run that died early
    // would satisfy all of them without ever reaching the decline branch. The
    // exit code, the fully consumed script and the branch's own line are what
    // prove the wizard walked through the confirmation and came out the other
    // side, so the never-un-quarantine-without-an-explicit-yes property is
    // actually pinned at this surface.
    expect(run.code).toBe(0);
    expect(run.unused).toEqual([]);
    expect(run.transcript).toContain("Nothing was saved for this login.");

    expect(existsSync(join(paths.profilesDir, "second.env"))).toBe(false);
    expect(readFileSync(incumbent, "utf8")).not.toContain("# freshbooks-distinct-login");
  });
});

describe("runWizard: multi-business choice", () => {
  it("relays business LABELS, numbered, and saves the chosen one", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const run = await runScripted(
      ["cid-123", "sec-abc", "main", "https://localhost/callback?code=abc123", "2", "", "n"],
      paths,
    );

    expect(run.transcript).toContain("1) Acme Inc");
    expect(run.transcript).toContain("2) Beta LLC");
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain("FRESHBOOKS_ACCOUNT_ID=AC-2");
    expect(saved).toContain("FRESHBOOKS_BUSINESS_ID=9002");
  });
});

describe("runWizard: failure reporting", () => {
  it("prints the failing step's troubleshooting fix and NO stack frames", async () => {
    vi.mocked(buildAuthUrl).mockImplementation(() => {
      throw new Error("FreshBooks SDK exploded while minting the URL");
    });

    const run = await runScripted(["cid-123", "sec-abc", "main"]);
    const tFailing = run.transcript;

    expect(run.code).toBe(1);
    expect(tFailing).toContain("FreshBooks SDK exploded while minting the URL");
    // The Book's own fix for the step that failed.
    const authorize = SETUP_FLOW.find((s) => s.id === "authorize")!;
    expect(tFailing).toContain(authorize.troubleshooting[0].fix);
    expect(tFailing).not.toMatch(/^\s+at /m);
  });

  it("never serializes a caught error object", async () => {
    // The SDK's rejection carries the request body — client_secret, the code,
    // the refresh token. Only `message` may travel.
    vi.mocked(discoverMemberships).mockRejectedValue(
      Object.assign(new Error("Request failed with status code 503"), {
        config: { data: "client_secret=sec-abc&code=abc123" },
      }),
    );

    const run = await runScripted([
      "cid-123",
      "sec-abc",
      "main",
      "https://localhost/callback?code=abc123",
      "AC-MANUAL",
      "",
      "",
      "n",
    ]);

    expect(run.transcript).not.toContain("client_secret=");
    expect(run.transcript).toContain("Request failed with status code 503");
  });
});

describe("runWizard: the step list it hands the checklist", () => {
  it("covers exactly the Book's wizard-surface steps, once each", () => {
    const ordered = wizardSteps().map((s) => s.id);
    const fromBook = SETUP_FLOW.filter((s) => s.surfaces.includes("wizard")).map((s) => s.id);
    expect([...ordered].sort()).toEqual([...fromBook].sort());
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it("performs the build late, after the per-login work — the wizard's own order", () => {
    const ordered = wizardSteps().map((s) => s.id);
    expect(ordered.indexOf("build")).toBeGreaterThan(ordered.indexOf("save-login"));
    expect(ordered.indexOf("restart")).toBe(ordered.length - 1);
  });
});
