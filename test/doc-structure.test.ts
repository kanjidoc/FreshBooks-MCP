import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLAUDE.md is the map a session reads before touching anything, and two of its
 * claims are checkable against the source tree. Both went stale the moment the
 * setup flow was split out of the wizard:
 *
 *   1. the project-structure tree must list the setup modules that exist;
 *   2. the "a `Client` is constructed in exactly one place" invariant must
 *      carry its setup carve-out for as long as `scripts/setup-core.ts`
 *      actually constructs one.
 *
 * Both assertions are guarded by a premise check, so neither can pass vacuously
 * after the module it describes is renamed or deleted. Deliberately narrow: a
 * blanket "every module is in the tree" rule would fail on modules later tasks
 * have not documented yet, which is a different (and much noisier) guard than
 * the one this task owes.
 *
 * A third claim joins them once the setup rework lands: the THREE-SURFACE
 * CONTRACT. The whole design rests on one body of setup copy (the Book) being
 * rendered by three surfaces rather than retyped by each, and a session that
 * reads CLAUDE.md without meeting that sentence will hand-write step copy into
 * whichever surface it is editing. Same discipline — each surface's claim is
 * premised on the module that implements it still existing.
 */

const ROOT = join(__dirname, "..");
const CLAUDE_MD = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const SETUP_CORE = "scripts/setup-core.ts";

/** Surface number → the module that implements it (spec §Docs impact). */
const SURFACES: [string, string][] = [
  ["Surface 1", "scripts/setup.ts"],
  ["Surface 2", "scripts/setup-headless.ts"],
  ["Surface 3", "src/docs/render-setup.ts"],
];

/** The fenced block that follows the "## Project Structure" heading. */
function projectStructureTree(md: string): string {
  const heading = md.indexOf("## Project Structure");
  expect(heading, "CLAUDE.md has no '## Project Structure' section").toBeGreaterThan(-1);
  const open = md.indexOf("```", heading);
  expect(open, "no fenced tree follows '## Project Structure'").toBeGreaterThan(-1);
  const close = md.indexOf("```", open + 3);
  expect(close, "the project-structure fence is unterminated").toBeGreaterThan(open);
  return md.slice(open + 3, close);
}

const TREE_LINES = projectStructureTree(CLAUDE_MD).split("\n");

describe.each([
  ["src/setup-flow.ts"],
  [SETUP_CORE],
  ["scripts/setup-headless.ts"],
  ["src/docs/render-setup.ts"],
  ["scripts/generate-setup-docs.ts"],
])(
  "CLAUDE.md project structure: %s",
  (modulePath) => {
    const basename = modulePath.slice(modulePath.lastIndexOf("/") + 1);

    it("the module exists on disk (premise — otherwise the tree should drop it)", () => {
      expect(existsSync(join(ROOT, modulePath))).toBe(true);
    });

    it("the tree lists it, with a description", () => {
      const entry = TREE_LINES.find((line) => line.includes(basename));
      expect(entry, `the project-structure tree omits ${modulePath}`).toBeDefined();
      // `<name>  # <what it does>` — a bare filename is not documentation.
      expect(entry).toMatch(/#\s+\S/);
    });
  },
);

describe("CLAUDE.md single-Client invariant", () => {
  it("scripts/setup-core.ts constructs a Client (premise for the carve-out)", () => {
    const source = readFileSync(join(ROOT, SETUP_CORE), "utf8");
    expect(source).toMatch(/new Client\(/);
  });

  it("states the carve-out where it states the invariant", () => {
    const bullet = CLAUDE_MD.split("\n").find((line) =>
      line.includes("Never call `new Client(...)` elsewhere"),
    );
    expect(bullet, "CLAUDE.md no longer states the single-Client invariant").toBeDefined();
    expect(bullet).toContain("buildOAuthClient");
    expect(bullet).toContain(SETUP_CORE);
  });
});

describe("CLAUDE.md three-surface contract", () => {
  it.each(SURFACES)("%s's module exists on disk (premise)", (_surface, modulePath) => {
    expect(existsSync(join(ROOT, modulePath))).toBe(true);
  });

  // Same line, not merely the same document: a surface number stated apart from
  // its module is exactly the mismatch a reader makes when editing the wrong
  // one. (CLAUDE.md names each surface more than once — the tree and the
  // contract table — so this asks that SOME line pairs them, not the first.)
  it.each(SURFACES)("names %s and the module behind it, on one line", (surface, modulePath) => {
    const lines = CLAUDE_MD.split("\n").filter((l) => l.includes(surface));
    expect(lines.length, `CLAUDE.md never names ${surface}`).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.includes(modulePath)),
      `${surface} is never named alongside ${modulePath}`,
    ).toBe(true);
  });

  it("names Surface 3 as the guided docs (spec §Docs impact)", () => {
    const lines = CLAUDE_MD.split("\n").filter((l) => l.includes("Surface 3"));
    expect(lines.some((l) => l.toLowerCase().includes("guided docs"))).toBe(true);
  });

  it("states the Book's regenerate step where it states the Book", () => {
    expect(CLAUDE_MD, "CLAUDE.md does not name the Book").toContain("src/setup-flow.ts");
    expect(
      CLAUDE_MD,
      "CLAUDE.md never tells a session to regenerate SETUP.md after a Book edit",
    ).toContain("npx ts-node scripts/generate-setup-docs.ts");
  });

  it("routes the setup drift failure to the test that reports it", () => {
    expect(
      CLAUDE_MD,
      "the doc-maintenance contract omits test/setup-flow-docs.test.ts",
    ).toContain("test/setup-flow-docs.test.ts");
  });
});
