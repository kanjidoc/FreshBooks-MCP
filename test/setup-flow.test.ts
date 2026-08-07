import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SETUP_FLOW, KICKOFF_PROMPT, SECRETS_RULES, SIDEBAR_TEXT,
  HEADLESS_VERBS, FOREIGN_FLAG_ALLOWLIST } from "../src/setup-flow";
import type { SetupCtx, SetupStep } from "../src/setup-flow";
import { renderSetupStepMd, renderSetupTopic } from "../src/docs/render-setup";

const IDS = ["choose-claude","get-project","node-install","npm-install","build",
  "developer-app","app-credentials","migrate-legacy","nickname","authorize",
  "save-login","install-config","verify","restart"];
const step = (id: string) => SETUP_FLOW.find(s => s.id === id)!;
// NOTE: docPhrases are deliberately EXCLUDED from allText — including them
// would make the substring assertions below vacuously true.
const allText = (s: any) => [s.title, s.summary, ...s.humanScript, s.agentGuidance,
  s.successCheck, ...s.troubleshooting.flatMap((t: any) => [t.symptom, t.fix])].join("\n");

describe("structure", () => {
  it("ids/order", () => expect(SETUP_FLOW.map(s => s.id)).toEqual(IDS));
  it("fields valid", () => { for (const s of SETUP_FLOW) {
    expect(["human","either"]).toContain(s.who);
    expect(s.surfaces.every((x: string) => ["wizard","docs","headless"].includes(x))).toBe(true);
    expect(s.humanScript.length).toBeGreaterThan(0);
    expect(s.agentGuidance).toBeTruthy(); expect(s.successCheck).toBeTruthy();
  }});
  it("repeats/appliesIf/build-surfaces", () => {
    expect(SETUP_FLOW.filter(s => s.repeats).map(s => s.id)).toEqual(["nickname","authorize","save-login"]);
    expect(SETUP_FLOW.filter(s => s.appliesIf).map(s => s.id)).toEqual(["migrate-legacy"]);
    expect(step("build").surfaces).toEqual(["docs","wizard"]);
  });
  it("every verbs[] entry and every --flag mentioned in any step text is in HEADLESS_VERBS", () => {
    for (const s of SETUP_FLOW) {
      for (const v of s.verbs ?? []) expect(HEADLESS_VERBS).toContain(v);
      for (const m of allText(s).match(/--[a-z-]+/g) ?? [])
        expect([...HEADLESS_VERBS, ...FOREIGN_FLAG_ALLOWLIST]).toContain(m);
      // FOREIGN_FLAG_ALLOWLIST = ["--profile","--scope","--version","--strip-components"]
      // — exported from src/setup-flow.ts; T16's fence sweep uses the SAME list.
      // --strip-components is a tar option inside the blessed get-project
      // command, not a verb; it must never enter HEADLESS_VERBS.
    }
  });
  it("docPhrases are substrings of their step's own text", () => {
    for (const s of SETUP_FLOW) for (const p of s.docPhrases ?? [])
      expect(allText(s)).toContain(p);
  });
  it("no step's copy talks about the Book's own machinery", () => {
    // `check()` / `appliesIf()` are Book FIELDS — invisible to every reader of
    // SETUP.md, the help topic and the wizard, and meaningless to all three.
    // Notes about them belong in a TS comment on the step, not in copy the
    // renderer ships (same exclusion the fence-machinery prose got).
    for (const s of SETUP_FLOW)
      expect(allText(s), `${s.id} carries implementer-facing meta-commentary`)
        .not.toMatch(/\b(?:check|appliesIf)\(\)/);
  });
});

describe("persona-string manifest (content pins — the strings the design exists for)", () => {
  const M: [string, string][] = [
    ["authorize",      "CAN'T BE REACHED"],
    ["authorize",      "Click once inside the address bar"],
    ["authorize",      "stay with me"],                       // agentGuidance (rungs 1-2 only)
    ["authorize",      "no harm done"],                       // closed-tab row
    ["authorize",      "sign-in link the setup program just printed"],
    ["app-credentials","never into this chat"],               // rung-3 secrets row
    ["app-credentials","I won't repeat it again"],            // shape-confirm
    ["app-credentials","designed to be handed to me"],        // rungs-1-2 reassurance (scam-moment fix)
    ["app-credentials","The setup program is the guide now"], // wizard handoff
    ["app-credentials","npm run setup"],                      // rung-3 wizard launch
    ["app-credentials","will not contain it"],                // secret-file pre-brief
    ["developer-app",  "leave it as-is"],
    ["developer-app",  "that's their sign-in check"],         // 2FA wall
    ["developer-app",  "Reveal (eye) toggle"],                // reveal beat, main path
    ["get-project",    "between eight and ten"],              // dialog range
    ["get-project",    "of about 9"],                         // countdown format
    ["node-install",   "press Cmd+Space, type Terminal"],     // Terminal opener
    ["nickname",       "I'll call this login main"],          // n=1 auto-pick
    ["save-login",     "including the long code"],            // auth-code pre-brief
    ["save-login",     "Which business is this for"],         // exit-6 labels-only relay
    ["save-login",     "the code lives minutes"],             // run-add-login-now rule
    ["install-config", "you never edit a file by hand"],
    ["install-config", "access keys for other connectors"],   // disclosure
    ["install-config", "select all, paste over everything, press Cmd+S"],
    ["install-config", "Want me to ask again?"],              // re-ask script
    ["migrate-legacy", "one-time key"],                       // plain-English gate
    ["restart",        "Our conversation is saved"],
    ["restart",        "open this same chat"],                // restored spec beat
    ["restart",        "paste the same kickoff prompt"],      // rung-3 failure line
    ["choose-claude",  "Dock"],                               // visual cue
    ["choose-claude",  "claude.ai/download"],                 // actionable honest stop
    ["choose-claude",  "looks like the project README"],      // paste-mismatch script
  ];
  it("kickoff rule 4 exception + rule 6 no-transmit survive edits", () => {
    expect(KICKOFF_PROMPT).toContain("isn't supported");
    expect(KICKOFF_PROMPT).toContain("transmits my token files");
  });
  for (const [id, phrase] of M)
    it(`${id} carries "${phrase}"`, () => expect(allText(step(id))).toContain(phrase));
  it("kickoff: six rules, pinned URL, heading+last-line quote-back", () => {
    expect(KICKOFF_PROMPT).toContain("https://github.com/kanjidoc/FreshBooks-MCP");
    for (const n of [1,2,3,4,5,6]) expect(KICKOFF_PROMPT).toMatch(new RegExp(`^${n}\\.`, "m"));
    expect(KICKOFF_PROMPT).toContain("quote back to me its opening heading and its final line");
  });
  it("secrets rules + self-test + sidebar", () => {
    expect(SECRETS_RULES.rows.map(r => r.credential)).toEqual(
      ["Client ID + Secret","Authorization code","Access/refresh tokens"]);
    expect(SECRETS_RULES.selfTest).toContain("asking permission to run things");
    expect(SIDEBAR_TEXT).toContain("copy button");
  });
});

// ── Fix round 1, review finding 1 ───────────────────────────────────────────
// migrate-legacy's predicate is CONTENT-level ("base .env holds tokens without
// FRESHBOOKS_MIGRATED", spec step list), not existence-level. The Book cannot
// read file contents (zero imports), so the surfaces that can — the wizard
// (T18) and `--doctor` (T12) — compute it and pass it in as
// SetupCtx.legacyNeedsMigration. Without this, every already-migrated user is
// shown the migration step, because the base .env always exists by then
// (app-credentials just wrote it).
describe("migrate-legacy appliesIf (the legacy-tokens predicate)", () => {
  const ctx = (over: Partial<SetupCtx> = {}): SetupCtx => ({
    projectDir: "/tmp/project",
    redirectUri: "https://localhost/callback",
    exists: () => true,
    ...over,
  });
  const applies = (c: SetupCtx) => step("migrate-legacy").appliesIf!(c);

  it("is FALSE for an already-migrated project even though the base .env exists", () => {
    expect(applies(ctx({ legacyNeedsMigration: false }))).toBe(false);
  });
  it("is TRUE only when the surface reports legacy tokens without the marker", () => {
    expect(applies(ctx({ legacyNeedsMigration: true }))).toBe(true);
  });
  it("is FALSE when a surface has not computed the predicate", () => {
    expect(applies(ctx())).toBe(false);
  });
  it("never consults ctx.exists — file existence is not the predicate", () => {
    const seen: string[] = [];
    const spy = (p: string) => { seen.push(p); return true; };
    applies(ctx({ legacyNeedsMigration: true, exists: spy }));
    applies(ctx({ legacyNeedsMigration: false, exists: spy }));
    applies(ctx({ exists: spy }));
    expect(seen).toEqual([]);
  });
});

// ── Task P: the live Developer Portal probe (2026-08-06) ────────────────────
// The developer-app step's portal beats are OBSERVED, not drafted — the record
// lives in the plan's Appendix A (probe date included). These pins are what
// stops the observed form from silently reverting to the guessed one; they are
// deliberately separate from the transcribed persona-string manifest above.
describe("portal probe (observed 2026-08-06)", () => {
  const text = () => allText(step("developer-app"));

  it.each([
    ["Create New App", "the real button label on the apps list page"],
    ["Private App", "Application Type is REQUIRED — 'leave it as-is' cannot cover it"],
    ["140 characters", "the Description box's observed limit"],
    ["Add Scope", "scopes are added one at a time, not ticked as checkboxes"],
    ["user:profile:read", "the one scope the form pre-adds"],
  ])("developer-app carries %j (%s)", (phrase) => {
    expect(text()).toContain(phrase);
  });

  // Regression lock on the corrected string. "Create an App" is NOT a substring
  // of "Create New App", so plain containment is a sound negative assertion.
  it("no longer tells the user to click the guessed 'Create an App'", () => {
    expect(text()).not.toContain("Create an App");
  });
});

// ── Task 15: the documentation render ───────────────────────────────────────
// `renderSetupStepMd` is the ONE renderer behind both doc surfaces: SETUP.md's
// committed generated blocks (T16 writes them with this same function, then
// asserts byte-equality) and the `freshbooks_help` `setup` topic. The strings
// asserted below are the spec's, not the renderer's — spec §Enforcement render
// rules (a) documentation ctx, (b) BOTH capability-keyed role headings (never
// "if Claude is driving"), (c) the appliesIf opener.
const DOCS_STEPS = SETUP_FLOW.filter((s) => s.surfaces.includes("docs"));
const AGENT_HEADING = "If Claude can run commands on your computer:";
const HUMAN_HEADING = "If you are typing every command yourself:";
const APPLIES_IF_OPENER = "The setup program shows this step only if";
const NOTEPAD_NOTE = "(Windows: the file opens in Notepad — select all, paste, Ctrl+S)";
const block = (id: string) => renderSetupStepMd(step(id));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("renderSetupStepMd", () => {
  it("heads each block with the step's own title, at H2", () => {
    // The LEVEL is pinned, not just the text: `## x` contains `# x`, so a
    // level-blind assertion would pass on any heading depth — and the depth is
    // what SETUP.md's structure (and T16's byte-equality) is built on.
    for (const s of DOCS_STEPS) expect(renderSetupStepMd(s).split("\n")[0]).toBe(`## ${s.title}`);
  });

  it("renders BOTH capability-keyed role headings for every docs-surface step", () => {
    for (const s of DOCS_STEPS) {
      const md = renderSetupStepMd(s);
      expect(md, `${s.id} is missing the agent-role heading`).toContain(AGENT_HEADING);
      expect(md, `${s.id} is missing the human-role heading`).toContain(HUMAN_HEADING);
      // The rejected wording a rung-3 reader would wrongly self-select.
      expect(md, `${s.id} uses the rejected "Claude is driving" wording`)
        .not.toContain("Claude is driving");
    }
  });

  it("carries both role variants' CONTENT, not just their headings", () => {
    for (const s of DOCS_STEPS) {
      const md = renderSetupStepMd(s);
      // agentGuidance/humanScript may carry {{placeholders}}; compare on a
      // placeholder-free step-independent basis by checking a long prefix.
      const firstHuman = s.humanScript[0].split("{{")[0].slice(0, 40);
      const firstAgent = s.agentGuidance.split("{{")[0].slice(0, 40);
      expect(md, `${s.id} dropped its humanScript`).toContain(firstHuman);
      expect(md, `${s.id} dropped its agentGuidance`).toContain(firstAgent);
    }
  });

  it("says who performs each step (kickoff rule 2 promises the doc marks this)", () => {
    expect(block("node-install")).toContain("**Who does this:** you.");
    expect(block("save-login")).toContain("**Who does this:** you or Claude.");
  });

  it("renders the DOCUMENTATION ctx: symbolic folder, literal redirect URI, nothing unresolved", () => {
    for (const s of DOCS_STEPS)
      expect(renderSetupStepMd(s), `${s.id} leaked a raw placeholder`).not.toContain("{{");
    expect(block("install-config")).toContain("<project folder>/dist/index.js");
    expect(block("app-credentials")).toContain("<project folder>/.client-secret.tmp");
    expect(block("developer-app")).toContain("https://localhost/callback");
  });

  it("opens ONLY the appliesIf step with the shows-this-step-only-if line", () => {
    expect(block("migrate-legacy")).toContain(APPLIES_IF_OPENER);
    for (const s of DOCS_STEPS.filter((x) => !x.appliesIf))
      expect(renderSetupStepMd(s), `${s.id} claims a condition it does not have`)
        .not.toContain(APPLIES_IF_OPENER);
  });

  it("embeds the SECRETS_RULES rows AND the self-test in app-credentials' block", () => {
    const md = block("app-credentials");
    for (const row of SECRETS_RULES.rows) {
      expect(md, `secrets row ${row.credential} missing`).toContain(row.credential);
      expect(md).toContain(row.agentRungs.slice(0, 40));
      expect(md).toContain(row.humanRung.slice(0, 40));
    }
    expect(md).toContain(SECRETS_RULES.selfTest);
    for (const note of SECRETS_RULES.honestyNotes) expect(md).toContain(note.slice(0, 60));
    // …and nowhere else: the table is app-credentials' own material.
    for (const s of DOCS_STEPS.filter((x) => x.id !== "app-credentials"))
      expect(renderSetupStepMd(s), `${s.id} duplicated the secrets self-test`)
        .not.toContain(SECRETS_RULES.selfTest);
  });

  it("renders the Windows-Notepad note exactly once — it is already inline in the Book", () => {
    // Carried Phase-1 obligation: Appendix A's "the rendered block appends …"
    // was satisfied by putting the note inline in install-config's
    // agentGuidance. The renderer must render fields as-is and never append it
    // a second time.
    expect(count(step("install-config").agentGuidance, NOTEPAD_NOTE)).toBe(1);
    expect(count(block("install-config"), NOTEPAD_NOTE)).toBe(1);
  });

  it("keeps successCheck prose and the troubleshooting rows in every block", () => {
    for (const s of DOCS_STEPS) {
      const md = renderSetupStepMd(s);
      expect(md, `${s.id} dropped its successCheck`).toContain(s.successCheck.split("{{")[0].slice(0, 30));
      for (const t of s.troubleshooting) {
        expect(md, `${s.id} dropped a symptom`).toContain(t.symptom.slice(0, 30));
        expect(md, `${s.id} dropped a fix`).toContain(t.fix.slice(0, 30));
      }
    }
  });

  it("carries every docPhrase inside its own step's block (T16 asserts the same in-region)", () => {
    for (const s of DOCS_STEPS) {
      const md = renderSetupStepMd(s);
      for (const p of s.docPhrases ?? [])
        expect(md, `${s.id} block lost docPhrase ${JSON.stringify(p)}`).toContain(p);
    }
  });

  // ── Carried Phase-1 obligation (a) ────────────────────────────────────────
  // DOC_CTX carries neither `exists` nor `legacyNeedsMigration`, so a render
  // that called check() would throw on `ctx.exists!(...)`. The render must ask
  // the filesystem nothing at all.
  it("never invokes a step's check() — a poisoned check survives the render", () => {
    for (const s of DOCS_STEPS) {
      const poisoned: SetupStep = {
        ...s,
        check: () => {
          throw new Error(`check() called while rendering ${s.id}`);
        },
        appliesIf: s.appliesIf
          ? () => {
              throw new Error(`appliesIf() called while rendering ${s.id}`);
            }
          : undefined,
      };
      expect(() => renderSetupStepMd(poisoned)).not.toThrow();
    }
    expect(() => renderSetupTopic()).not.toThrow();
  });

  it("renders every docs-surface step without touching the filesystem", () => {
    // Static half of the same obligation: neither the renderer nor the Book may
    // reach a node builtin, so no render can depend on machine state.
    const NODE_BUILTIN = /^(node:)?(fs|path|os|child_process|http|https|net)(\/|$)/;
    for (const file of ["src/docs/render-setup.ts", "src/setup-flow.ts"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const specifiers = [...src.matchAll(/from\s+"([^"]+)"|require\("([^"]+)"\)/g)]
        .map((m) => m[1] ?? m[2]);
      for (const spec of specifiers)
        expect(spec, `${file} imports the node builtin ${spec}`).not.toMatch(NODE_BUILTIN);
    }
    for (const s of DOCS_STEPS) expect(renderSetupStepMd(s).length).toBeGreaterThan(0);
  });
});

describe("renderSetupTopic", () => {
  it("renders every docs-surface step, in Book order", () => {
    const topic = renderSetupTopic();
    let cursor = -1;
    for (const s of DOCS_STEPS) {
      const at = topic.indexOf(`\n## ${s.title}\n`);
      expect(at, `setup topic omits ${s.id} (or renders it at the wrong level)`).toBeGreaterThan(-1);
      expect(at, `setup topic renders ${s.id} out of Book order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("carries the kickoff prompt verbatim and the no-web fallback", () => {
    expect(renderSetupTopic()).toContain(KICKOFF_PROMPT);
    expect(renderSetupTopic()).toContain(SIDEBAR_TEXT);
  });

  it("quotes the who-does-this marker as the blocks actually render it", () => {
    // The preamble tells a reader to scan for a literal bolded phrase. If the
    // preamble's version of that phrase is not the rendered one, the scan finds
    // nothing — so the preamble is asserted against a real block, not by eye.
    const rendered = /^\*\*Who does this:\*\* (?:you|you or Claude)\.$/m.exec(
      renderSetupStepMd(step("developer-app")),
    );
    expect(rendered, "the who-does-this marker changed shape").not.toBeNull();
    const topic = renderSetupTopic();
    expect(topic.slice(0, topic.indexOf("## The kickoff prompt"))).toContain(
      "**Who does this:** you",
    );
  });

  it("carries the secrets table exactly once", () => {
    expect(count(renderSetupTopic(), SECRETS_RULES.selfTest)).toBe(1);
  });
});
