import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../src/tool-registry";

/**
 * Name-level doc sync (the count-level guard lives in doc-tool-count.test.ts).
 * The tool inventory is hand-written in three documents; a count can stay
 * right while a name rots. Both directions are enforced:
 *   - every registered tool name appears in each document ("forgot to document")
 *   - every freshbooks_* token in each document is a registered name
 *     ("documented a tool that no longer exists" — or a typo)
 */
const DOCS = [
  "README.md",
  "CLAUDE.md",
  join("docs", "claude-project-system-prompt.md"),
];

const registered = new Set(allTools.map((t) => t.name));

describe.each(DOCS)("doc inventory: %s", (doc) => {
  const text = readFileSync(join(__dirname, "..", doc), "utf8");
  // Trailing [a-z_] chars only — `freshbooks_<action>` placeholders in prose
  // stop at the `<` and produce no match.
  const mentioned = new Set(text.match(/freshbooks_[a-z][a-z_]*[a-z]/g) ?? []);

  it("mentions every registered tool by name", () => {
    const missing = [...registered].filter((n) => !mentioned.has(n));
    expect(missing, `${doc} is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("mentions no unregistered tool name", () => {
    const unknown = [...mentioned].filter((n) => !registered.has(n));
    expect(unknown, `${doc} mentions unknown: ${unknown.join(", ")}`).toEqual([]);
  });
});
