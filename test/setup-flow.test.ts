import { describe, it, expect } from "vitest";
import { SETUP_FLOW, KICKOFF_PROMPT, SECRETS_RULES, SIDEBAR_TEXT,
  HEADLESS_VERBS, FOREIGN_FLAG_ALLOWLIST } from "../src/setup-flow";

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
