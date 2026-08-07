import { describe, it, expect } from "vitest";
import { HELP_TOPICS, renderHelpTopic } from "../src/tools/help";
import { SETUP_FLOW } from "../src/setup-flow";

/**
 * `freshbooks_help`'s topic list lives in THREE hand-maintained places: the
 * zod enum + section map (`src/tools/help.ts`), the `index` topic's bullet
 * list, and the `overview` topic's closing "go deeper" list
 * (`src/docs/content.ts`). Nothing kept them in step — which is how `reports`
 * came to be a real topic that the overview never mentions. This suite is that
 * guard, in both directions, for every topic.
 *
 * Exclusions (deliberate, not oversights): the `index` topic does not list
 * itself, and the overview's closing list names neither `index` (the reader is
 * past it) nor `overview` (the reader is in it).
 */
describe("help topic registration", () => {
  const index = renderHelpTopic("index");
  const overview = renderHelpTopic("overview");

  /** The overview's closing list, scoped so containment can't pass on prose above it. */
  const closingList = (() => {
    const at = overview.indexOf("with other topics");
    expect(at, "the overview no longer has a closing topic list").toBeGreaterThan(-1);
    return overview.slice(at);
  })();

  // Completeness of the topic → section map itself is compile-enforced: it is
  // typed `Record<HelpTopic, …>`, so a topic added to the enum without a
  // section fails `npm run build` (and `tsc -p tsconfig.test.json`) rather than
  // silently falling back to the index. What no compiler can check is the two
  // hand-written lists below — which is exactly where `reports` went missing.
  it("renders a real document for each topic this suite can reach in-process", () => {
    // `tools` is excluded on purpose: `renderToolsTopic` pulls the registry
    // with a lazy CJS `require` (its own documented cycle break), which
    // resolves in `dist/` but not under vitest's ESM transform.
    for (const topic of HELP_TOPICS.filter((t) => t !== "tools")) {
      const text = renderHelpTopic(topic);
      expect(text.startsWith("# "), `${topic} does not render a document`).toBe(true);
      if (topic !== "index")
        expect(text, `${topic} falls back to the index — it has no section`).not.toBe(index);
    }
  });

  it("the index topic lists every enum topic except `index` itself", () => {
    for (const topic of HELP_TOPICS.filter((t) => t !== "index"))
      expect(index, `the index topic omits ${topic}`).toContain(`**${topic}**`);
    expect(index, "the index lists itself").not.toContain("**index**");
  });

  it("the overview's closing list names every topic except `index` and `overview`", () => {
    for (const topic of HELP_TOPICS.filter((t) => t !== "index" && t !== "overview"))
      expect(closingList, `the overview's closing list omits ${topic}`).toContain(`\`${topic}\``);
    for (const topic of ["index", "overview"])
      expect(closingList, `the overview's closing list names ${topic}`).not.toContain(`\`${topic}\``);
  });

  it("`setup` is a registered topic and renders the Book", () => {
    expect(HELP_TOPICS).toContain("setup");
    const text = renderHelpTopic("setup");
    for (const s of SETUP_FLOW.filter((x) => x.surfaces.includes("docs")))
      expect(text, `the setup topic omits ${s.id}`).toContain(s.title);
  });
});
