import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../src/tool-registry";

/**
 * Name-level doc sync (the count-level guard lives in doc-tool-count.test.ts).
 * The tool inventory is hand-written in several documents; a count can stay
 * right while a name rots.
 *
 * Two classes, because the documents make different promises:
 *
 *   - INVENTORY docs claim to list the whole tool set, so both directions are
 *     enforced: every registered name appears ("forgot to document"), and every
 *     `freshbooks_*` token is a registered name ("documented a tool that no
 *     longer exists" — or a typo).
 *   - MENTION-ONLY docs (SETUP.md is the install walkthrough, not a catalogue)
 *     name a handful of tools in passing. Requiring the full inventory there
 *     would be a demand the document never made; the half that still matters is
 *     that every name it DOES print is real — a beginner told to ask for a tool
 *     that does not exist is stuck with no way to tell why.
 */
const INVENTORY_DOCS = [
  "README.md",
  "CLAUDE.md",
  join("docs", "claude-project-system-prompt.md"),
];
const MENTION_ONLY_DOCS = ["SETUP.md"];

const registered = new Set(allTools.map((t) => t.name));

// Trailing [a-z_] chars only — `freshbooks_<action>` placeholders in prose stop
// at the `<` and produce no match.
const mentionedIn = (doc: string): Set<string> =>
  new Set(
    readFileSync(join(__dirname, "..", doc), "utf8").match(/freshbooks_[a-z][a-z_]*[a-z]/g) ?? [],
  );

const unregisteredIn = (doc: string): string[] =>
  [...mentionedIn(doc)].filter((n) => !registered.has(n));

describe.each([...INVENTORY_DOCS, ...MENTION_ONLY_DOCS])("doc inventory: %s", (doc) => {
  it("mentions no unregistered tool name", () => {
    const unknown = unregisteredIn(doc);
    expect(unknown, `${doc} mentions unknown: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe.each(INVENTORY_DOCS)("doc inventory (full catalogue): %s", (doc) => {
  it("mentions every registered tool by name", () => {
    const mentioned = mentionedIn(doc);
    const missing = [...registered].filter((n) => !mentioned.has(n));
    expect(missing, `${doc} is missing: ${missing.join(", ")}`).toEqual([]);
  });
});
