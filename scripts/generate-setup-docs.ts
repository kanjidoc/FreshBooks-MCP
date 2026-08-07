/// <reference types="node" />
/**
 * FreshBooks MCP — SETUP.md block generator
 *
 *   npx ts-node scripts/generate-setup-docs.ts
 *
 * SETUP.md is half hand-written and half generated. The hand-written half is
 * the framing prose — what this guide is, what you need, what to do once it
 * works. The generated half is one block per docs-surface step of the Book
 * (`src/setup-flow.ts`), spliced between the markers
 *
 *     <!-- setup-step:<id> BEGIN -->
 *     <!-- setup-step:<id> END -->
 *
 * with `renderSetupStepMd` — the SAME renderer that serves the
 * `freshbooks_help` `setup` topic, so the document and the program can never
 * describe the setup differently.
 *
 * RUN THIS AFTER EVERY BOOK EDIT. Nothing inside a marker pair may be edited by
 * hand: `test/setup-flow-docs.test.ts` re-renders each region and asserts
 * byte-equality, so a hand-edit (or a forgotten regeneration) fails the build
 * and names the step. If a rendered block reads wrong, the fix belongs in the
 * Book or in the renderer.
 *
 * Region contract (plan T16): a marker is alone on its line; the region is the
 * lines STRICTLY between the two markers; the region ends with exactly one
 * trailing newline — which is exactly what `renderSetupStepMd` returns, so a
 * region is byte-identical to a render with no trimming on either side.
 *
 * This module performs no I/O when imported — the read/write happens only under
 * `require.main === module`, so the tests can exercise the splice on in-memory
 * fixtures.
 *
 * The `/// <reference types="node" />` above is load-bearing under ts-node: this
 * script's only imports are the Book and its renderer, both of which import
 * nothing at all, so nothing else pulls Node's own types into the program and
 * `fs`/`__dirname`/`process` would not resolve. Scripts that reach a package
 * with a bundled node reference (every other script here does) get them for
 * free.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETUP_FLOW, type SetupStep } from "../src/setup-flow";
import { renderSetupStepMd } from "../src/docs/render-setup";

/** The document this script owns. */
export const SETUP_MD_PATH = join(__dirname, "..", "SETUP.md");

export const beginMarker = (id: string): string => `<!-- setup-step:${id} BEGIN -->`;
export const endMarker = (id: string): string => `<!-- setup-step:${id} END -->`;

/** The steps that get a generated block, in Book order. */
export function docsSurfaceSteps(): SetupStep[] {
  return SETUP_FLOW.filter((s) => s.surfaces.includes("docs"));
}

/**
 * Line indexes of a step's two markers. Every failure is loud and names the
 * step: a silently-skipped region would let a document ship a stale block.
 */
function markerLines(md: string, id: string): { lines: string[]; begin: number; end: number } {
  const lines = md.split("\n");
  const find = (marker: string, what: string): number => {
    const at = lines.reduce<number[]>((hits, line, i) => (line === marker ? [...hits, i] : hits), []);
    if (at.length !== 1)
      throw new Error(
        `expected exactly one ${what} marker for setup step "${id}", found ${at.length} (${marker})`,
      );
    return at[0];
  };
  const begin = find(beginMarker(id), "BEGIN");
  const end = find(endMarker(id), "END");
  if (end < begin)
    throw new Error(`setup step "${id}": the END marker appears before the BEGIN marker`);
  return { lines, begin, end };
}

/**
 * The committed generated block for one step — the lines strictly between its
 * markers, with exactly one trailing newline (empty string when the region is
 * empty, which is how a freshly authored skeleton starts out).
 */
export function readStepRegion(md: string, id: string): string {
  const { lines, begin, end } = markerLines(md, id);
  const body = lines.slice(begin + 1, end);
  return body.length === 0 ? "" : `${body.join("\n")}\n`;
}

/** Replace one step's region, leaving every other byte of the document alone. */
export function replaceStepRegion(md: string, id: string, body: string): string {
  const { lines, begin, end } = markerLines(md, id);
  // `body` ends with exactly one newline, so its split has a trailing "" to drop.
  const bodyLines = body === "" ? [] : body.split("\n").slice(0, -1);
  return [...lines.slice(0, begin + 1), ...bodyLines, ...lines.slice(end)].join("\n");
}

/** Splice every docs-surface step's freshly rendered block into the document. */
export function generateSetupDocs(md: string): string {
  return docsSurfaceSteps().reduce(
    (doc, step) => replaceStepRegion(doc, step.id, renderSetupStepMd(step)),
    md,
  );
}

/** Returns the number of steps whose block changed. */
export function regenerateSetupMd(path: string = SETUP_MD_PATH): number {
  const before = readFileSync(path, "utf8");
  const after = generateSetupDocs(before);
  const changed = docsSurfaceSteps().filter(
    (s) => readStepRegion(before, s.id) !== readStepRegion(after, s.id),
  );
  if (after !== before) writeFileSync(path, after);
  for (const step of changed) console.error(`regenerated: ${step.id}`);
  console.error(
    changed.length === 0
      ? "SETUP.md is already up to date."
      : `SETUP.md updated — ${changed.length} block(s) rewritten.`,
  );
  return changed.length;
}

if (require.main === module) {
  try {
    regenerateSetupMd();
  } catch (err) {
    console.error(`generate-setup-docs failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
