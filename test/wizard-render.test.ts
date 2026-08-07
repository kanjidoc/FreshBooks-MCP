import { describe, it, expect } from "vitest";
import { formatPrompt, renderChecklist } from "../scripts/setup";
import { SETUP_FLOW, type SetupCtx, type SetupStep } from "../src/setup-flow";

/**
 * THE WIZARD'S TWO PURE RENDERERS (T17).
 *
 * `formatPrompt` and `renderChecklist` are the wizard's only string-producing
 * primitives, and both are pure — no readline, no fs, no clock. That is why
 * this suite drives them directly with literal arguments instead of stubbing
 * I/O: every assertion below is a total function of its inputs.
 *
 * SAFETY: nothing here reads or writes the developer's `.env`, `profiles/`,
 * `.mcp.json`, `~/.claude.json` or the Claude Desktop config, and nothing here
 * reaches FreshBooks. Importing `scripts/setup` is inert — its `main()` runs
 * only under `require.main === module`.
 *
 * The spec pins the two yes/no renderings verbatim
 * (`docs/superpowers/specs/2026-08-06-setup-rework-design.md` §Surface 1:
 * "both default renderings specified: `(y = yes, Enter = no)` and
 * `(Enter = yes, n = no)`"), and the plan pins the checklist's three markers
 * and its `(login N)` annotation. Both are asserted as literals here so a
 * paraphrase fails rather than silently reaching a user.
 */

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
