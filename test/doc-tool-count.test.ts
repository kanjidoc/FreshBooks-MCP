import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { allTools } from "../src/tool-registry";

/**
 * Anti-rot guard. The *total* tool count, wherever a human-maintained doc
 * states it, must equal the live registry count. The scan looks for the
 * literal current total (`allTools.length`) — never a generic "N tools"
 * pattern — because CLAUDE.md's project-structure tree legitimately lists
 * ~18 per-domain counts ((5 tools), (4 tools), …); only the real total
 * claims use the total's value. When a tool is added or removed the total
 * changes, the docs go stale, and the per-file expected counts below stop
 * matching — failing loudly and naming the file.
 */
describe("doc tool-count", () => {
  const count = allTools.length;
  // `count` directly followed by "tool(s)" (optionally "FreshBooks accounting
  // tools"), or appearing as "(<count> total)".
  const adjacent = new RegExp(
    `\\b${count}\\b(?=\\s+(?:FreshBooks\\s+accounting\\s+)?tools?\\b)`,
    "g",
  );
  const total = new RegExp(`\\(${count}\\s+total\\)`, "g");

  const occurrences = (text: string): number =>
    (text.match(adjacent)?.length ?? 0) + (text.match(total)?.length ?? 0);

  const read = (rel: string): string =>
    readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

  const watched: ReadonlyArray<readonly [string, number]> = [
    ["README.md", 3],
    ["SETUP.md", 1],
    ["docs/claude-project-system-prompt.md", 1],
    ["CLAUDE.md", 2],
    ["CONTRIBUTING.md", 0],
  ];

  for (const [file, expected] of watched) {
    it(`${file} states the tool total ${expected} time(s)`, () => {
      expect(occurrences(read(file))).toBe(expected);
    });
  }

  it("package.json description states the tool total once", () => {
    const pkg = JSON.parse(read("package.json")) as { description: string };
    expect(occurrences(pkg.description)).toBe(1);
  });
});
