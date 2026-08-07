import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETUP_FLOW,
  KICKOFF_PROMPT,
  SIDEBAR_TEXT,
  HEADLESS_VERBS,
  FOREIGN_FLAG_ALLOWLIST,
} from "../src/setup-flow";
import { renderSetupStepMd } from "../src/docs/render-setup";
import {
  beginMarker,
  endMarker,
  docsSurfaceSteps,
  generateSetupDocs,
  readStepRegion,
  regenerateSetupMd,
  replaceStepRegion,
} from "../scripts/generate-setup-docs";

/**
 * The documentation drift suite (spec §Enforcement). Two committed documents
 * make claims that can rot the moment `src/setup-flow.ts` — the Book — is
 * edited:
 *
 *   - SETUP.md carries one COMMITTED GENERATED BLOCK per docs-surface step,
 *     between `<!-- setup-step:<id> BEGIN/END -->` markers. Every assertion
 *     below re-renders with `renderSetupStepMd`, the SAME function
 *     `scripts/generate-setup-docs.ts` writes with, so a Book edit that was
 *     never regenerated fails here instead of shipping a document that
 *     disagrees with the program it documents.
 *   - README carries `KICKOFF_PROMPT` verbatim, the user-side verifier line
 *     (whose quoted heading is read LIVE from SETUP.md, so a later rewrite of
 *     that heading cannot leave the README lying), and `SIDEBAR_TEXT`.
 *
 * The framing prose OUTSIDE the markers is hand-written and deliberately
 * unpinned — but it may never duplicate what a fence already says (the kickoff
 * prompt is the tested case: SETUP.md links to README's copy), and the two
 * HONESTY CLAIMS the spec drafts (per-rung time, rung-2 touchpoint floor) are
 * pinned by substring: they are the only load-bearing sentences the generator
 * cannot restore if someone tidies them away.
 */

const ROOT = join(__dirname, "..");
const readDoc = (name: string): string => readFileSync(join(ROOT, name), "utf8");
const SETUP_MD = readDoc("SETUP.md");
const README_MD = readDoc("README.md");

/**
 * SETUP.md with every generated region removed — the hand-written framing
 * prose, and nothing else. The honesty pins assert against THIS, not the whole
 * document: a sentence the Book happened to render into some step's block would
 * otherwise satisfy a naive containment check while the prose a reader meets
 * before any step stayed silent.
 */
const FRAMING_PROSE = SETUP_MD.replace(
  /^<!-- setup-step:[a-z0-9-]+ BEGIN -->\n[\s\S]*?\n<!-- setup-step:[a-z0-9-]+ END -->$/gm,
  "",
);

const DOCS_STEPS = SETUP_FLOW.filter((s) => s.surfaces.includes("docs"));

/** Spec §Enforcement — "SETUP.md sentinel". Kickoff rule 1 asks Claude to quote it. */
const SENTINEL = "— end of setup guide —";
/** Plan T16 — the retitled appendix. */
const APPENDIX_HEADING = "## Appendix — manual setup (humans only)";
/** Plan T16 — the literal gate sentence, scoped to the token-exchange section. */
const GATE_SENTENCE =
  "Installing agents must never use this section — it handles raw tokens.";

/** Every heading in a markdown document, with the byte range of its body. */
function headings(md: string): { level: number; title: string; at: number; bodyEnd: number }[] {
  const found: { level: number; title: string; at: number; bodyEnd: number }[] = [];
  const re = /^(#{1,6})\s+(.*)$/gm;
  for (const m of md.matchAll(re))
    found.push({ level: m[1].length, title: m[2].trim(), at: m.index!, bodyEnd: md.length });
  for (let i = 0; i < found.length - 1; i += 1) found[i].bodyEnd = found[i + 1].at;
  return found;
}

/** GitHub's heading-anchor slug, enough for the ASCII headings this repo links to. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

describe("SETUP.md generated blocks", () => {
  it("carries exactly one marker pair per docs-surface step, in Book order", () => {
    const seen = [...SETUP_MD.matchAll(/^<!-- setup-step:([a-z0-9-]+) (BEGIN|END) -->$/gm)].map(
      (m) => `${m[2]} ${m[1]}`,
    );
    const expected = DOCS_STEPS.flatMap((s) => [`BEGIN ${s.id}`, `END ${s.id}`]);
    expect(seen).toEqual(expected);
  });

  it("names no step id the Book does not render into the docs", () => {
    const ids = new Set(
      [...SETUP_MD.matchAll(/^<!-- setup-step:([a-z0-9-]+) BEGIN -->$/gm)].map((m) => m[1]),
    );
    const docsIds = new Set(DOCS_STEPS.map((s) => s.id));
    const unknown = [...ids].filter((id) => !docsIds.has(id));
    expect(unknown, `SETUP.md fences unknown step ids: ${unknown.join(", ")}`).toEqual([]);
    const missing = [...docsIds].filter((id) => !ids.has(id));
    expect(missing, `SETUP.md has no fence for: ${missing.join(", ")}`).toEqual([]);
  });

  it("each fenced region equals renderSetupStepMd(step) byte-for-byte", () => {
    for (const step of DOCS_STEPS) {
      const region = readStepRegion(SETUP_MD, step.id);
      expect(region.length, `${step.id}'s region is empty`).toBeGreaterThan(0);
      expect(region, `${step.id}'s block is stale — re-run scripts/generate-setup-docs.ts`).toBe(
        renderSetupStepMd(step),
      );
    }
  });

  it("is byte-identical to what the generator produces from it (no hand-edits inside a fence)", () => {
    expect(generateSetupDocs(SETUP_MD)).toBe(SETUP_MD);
  });

  it("carries every docPhrase inside its own step's region", () => {
    for (const step of DOCS_STEPS) {
      const region = readStepRegion(SETUP_MD, step.id);
      for (const phrase of step.docPhrases ?? [])
        expect(region, `${step.id}'s region lost docPhrase ${JSON.stringify(phrase)}`).toContain(
          phrase,
        );
    }
  });

  // Scoped deliberately: the framing prose outside the fences legitimately
  // carries other CLIs' flags. Inside a fence, every `--flag` came from the
  // Book, so a typo'd or invented verb must fail here exactly as it does in
  // `test/setup-flow.test.ts` — same allowlist export, no second list.
  it("uses only real verbs (or allowlisted foreign flags) inside the fenced regions", () => {
    const known = [...HEADLESS_VERBS, ...FOREIGN_FLAG_ALLOWLIST];
    let swept = 0;
    for (const step of DOCS_STEPS) {
      // `--[a-z]…` and not `--[-…]`: a markdown table's `|---|` separator is
      // not a flag, and the Book's blocks are full of tables.
      for (const flag of readStepRegion(SETUP_MD, step.id).match(/--[a-z][a-z0-9-]*/g) ?? []) {
        swept += 1;
        expect(known, `${step.id}'s region names the unknown flag ${flag}`).toContain(flag);
      }
    }
    expect(swept, "the sweep found no flags at all — it is not looking at the fences").toBeGreaterThan(
      5,
    );
  });
});

describe("README kickoff block", () => {
  const readmeLines = README_MD.split("\n");
  const promptLines = KICKOFF_PROMPT.split("\n");
  const startIdx = readmeLines.findIndex(
    (_, i) => readmeLines.slice(i, i + promptLines.length).join("\n") === KICKOFF_PROMPT,
  );

  it("carries KICKOFF_PROMPT verbatim, inside a fenced code block", () => {
    expect(startIdx, "README does not contain KICKOFF_PROMPT verbatim").toBeGreaterThan(0);
    expect(readmeLines[startIdx - 1].trim(), "the kickoff prompt is not fenced").toBe("```");
    expect(readmeLines[startIdx + promptLines.length].trim()).toBe("```");
  });

  // The verifier the user reads back. `<H>` is read LIVE from SETUP.md, so a
  // rewrite of that heading (T19) fails here rather than silently teaching the
  // user to accept a quote of a heading that no longer exists.
  it("states the expected opening heading directly below the block, read live from SETUP.md", () => {
    const headingLine = SETUP_MD.split("\n").find((l) => /^#\s+\S/.test(l));
    expect(headingLine, "SETUP.md has no opening `#` heading").toBeDefined();
    const heading = headingLine!.replace(/^#\s+/, "").trim();
    const after = readmeLines.slice(startIdx + promptLines.length + 1).find((l) => l.trim() !== "");
    expect(after).toBe(`Claude's first reply should quote: "${heading}"`);
  });

  it("carries the no-web fallback (SIDEBAR_TEXT) verbatim", () => {
    expect(README_MD).toContain(SIDEBAR_TEXT);
  });
});

describe("SETUP.md structure", () => {
  it("links to README's kickoff prompt instead of duplicating it", () => {
    expect(SETUP_MD, "SETUP.md duplicates KICKOFF_PROMPT — it must link to README's copy").not.toContain(
      KICKOFF_PROMPT,
    );
    expect(SETUP_MD).not.toContain(KICKOFF_PROMPT.split("\n")[0]);

    const link = SETUP_MD.match(/\[[^\]]*\]\(README\.md#([a-z0-9-]+)\)/);
    expect(link, "SETUP.md must link to a README anchor for the kickoff prompt").not.toBeNull();
    const anchors = headings(README_MD).map((h) => slug(h.title));
    expect(anchors, `README has no heading matching #${link![1]}`).toContain(link![1]);
    const linkLine = SETUP_MD.split("\n").find((l) => l.includes(link![0]))!;
    expect(linkLine.toLowerCase()).toContain("kickoff");
  });

  it("ends with the sentinel line", () => {
    expect(SETUP_MD.endsWith(`${SENTINEL}\n`)).toBe(true);
    expect(SETUP_MD.trimEnd().split("\n").pop()).toBe(SENTINEL);
  });

  it("retitles the appendix and gates the token-exchange section, once", () => {
    expect(SETUP_MD.split("\n").filter((l) => l === APPENDIX_HEADING)).toHaveLength(1);
    expect(SETUP_MD.split(GATE_SENTENCE)).toHaveLength(2);

    const all = headings(SETUP_MD);
    const appendix = all.find((h) => `${"#".repeat(h.level)} ${h.title}` === APPENDIX_HEADING)!;
    const gateAt = SETUP_MD.indexOf(GATE_SENTENCE);
    // Scoped, per spec §Enforcement: the gate belongs to the manual
    // token-exchange section — the manual CONFIG blocks are agent-usable and
    // live inside the `install-config` fence.
    const gateSection = all.filter((h) => h.at < gateAt).pop()!;
    expect(gateSection.at).toBeGreaterThan(appendix.at);
    expect(gateSection.level).toBeGreaterThan(appendix.level);
    expect(gateSection.title.toLowerCase()).toContain("token");
    expect(gateAt).toBeLessThan(gateSection.bodyEnd);
  });

  it("keeps the troubleshooting anchor README links to", () => {
    expect(headings(SETUP_MD).map((h) => slug(h.title))).toContain("troubleshooting");
  });
});

/**
 * Spec §Docs impact, "honest expectations". Both claims exist to stop a reader
 * from discovering the real cost halfway through: the time estimate is
 * per-rung (the old flat "about 15 minutes" was only ever true when Claude
 * could run the commands), and the touchpoint floor names how many things stay
 * the user's even on the rung where Claude drives. Neither is derivable from
 * the Book, so nothing but these assertions keeps them in the document.
 */
describe("SETUP.md honest expectations", () => {
  /** Spec §Docs impact, drafted verbatim. */
  const TIME_HONESTY =
    "15 minutes if Claude can run commands for you; up to an hour your first time by hand";
  /** Spec §Docs impact — "~35–40 user actions" (en dash, as the spec writes it). */
  const TOUCHPOINT_FLOOR = "35–40";

  it("states the per-rung time, in the framing prose, not a flat number", () => {
    expect(FRAMING_PROSE, "SETUP.md lost the per-rung time claim").toContain(TIME_HONESTY);
    // The pinned fragment the brief names, asserted in its own right so a
    // reworded second half cannot quietly take the first half with it.
    expect(FRAMING_PROSE).toContain("15 minutes if Claude can run commands");
    expect(
      FRAMING_PROSE,
      "the old unqualified 'about 15 minutes' promise is back",
    ).not.toContain("and about 15 minutes");
  });

  it("states the touchpoint floor inside the limitations section", () => {
    const limitations = headings(FRAMING_PROSE).find((h) => /limitation/i.test(h.title));
    expect(limitations, "SETUP.md has no limitations section").toBeDefined();
    const body = FRAMING_PROSE.slice(limitations!.at, limitations!.bodyEnd);
    expect(body, `the limitations section does not state the ${TOUCHPOINT_FLOOR} floor`).toContain(
      TOUCHPOINT_FLOOR,
    );
    expect(body).toContain("user actions");
  });

  it("keeps the framing prose free of fenced content (the strip actually stripped)", () => {
    expect(FRAMING_PROSE).not.toContain("setup-step:");
    expect(FRAMING_PROSE.length).toBeLessThan(SETUP_MD.length);
  });
});

describe("the generator itself", () => {
  const doc = [
    "# Title",
    "",
    beginMarker("choose-claude"),
    endMarker("choose-claude"),
    "",
    "framing prose",
    "",
    beginMarker("verify"),
    "stale",
    endMarker("verify"),
    "",
  ].join("\n");

  it("replaces only the named region and round-trips through readStepRegion", () => {
    const filled = replaceStepRegion(doc, "verify", "fresh\nlines\n");
    expect(readStepRegion(filled, "verify")).toBe("fresh\nlines\n");
    expect(readStepRegion(filled, "choose-claude")).toBe("");
    expect(filled).toContain("framing prose");
    expect(filled.split("\n").filter((l) => l === endMarker("verify"))).toHaveLength(1);
  });

  it("leaves the prose outside the markers untouched", () => {
    const filled = replaceStepRegion(doc, "verify", "fresh\n");
    expect(filled.slice(0, filled.indexOf(beginMarker("verify")))).toBe(
      doc.slice(0, doc.indexOf(beginMarker("verify"))),
    );
  });

  it("refuses a document whose markers are missing, duplicated, or out of order", () => {
    expect(() => readStepRegion(doc, "restart")).toThrow(/restart/);
    expect(() => readStepRegion(doc + beginMarker("verify") + "\n", "verify")).toThrow(/exactly one/);
    const reversed = [endMarker("build"), beginMarker("build"), ""].join("\n");
    expect(() => readStepRegion(reversed, "build")).toThrow(/before/);
  });

  it("fills every docs-surface step's region from the Book", () => {
    const skeleton = [
      "# Setup",
      "",
      ...docsSurfaceSteps().flatMap((s) => [beginMarker(s.id), endMarker(s.id), ""]),
    ].join("\n");
    const generated = generateSetupDocs(skeleton);
    for (const step of docsSurfaceSteps())
      expect(readStepRegion(generated, step.id)).toBe(renderSetupStepMd(step));
    expect(generateSetupDocs(generated), "generation is not idempotent").toBe(generated);
  });

  it("renders exactly the docs-surface steps, in Book order", () => {
    expect(docsSurfaceSteps().map((s) => s.id)).toEqual(DOCS_STEPS.map((s) => s.id));
  });

  // The one function that touches disk, driven against a throwaway copy — never
  // the repo's own SETUP.md.
  it("writes a stale document and reports which blocks it rewrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "fbmcp-setupdocs-"));
    const path = join(dir, "SETUP.md");
    const skeleton = [
      "# Setup",
      "",
      ...docsSurfaceSteps().flatMap((s) => [beginMarker(s.id), endMarker(s.id), ""]),
    ].join("\n");
    writeFileSync(path, skeleton);

    expect(regenerateSetupMd(path)).toBe(docsSurfaceSteps().length);
    const written = readFileSync(path, "utf8");
    expect(written).toBe(generateSetupDocs(skeleton));

    // Second run: nothing left to do, and the file is left exactly as it was.
    expect(regenerateSetupMd(path)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(written);
  });
});
