import {
  DOC_CTX,
  KICKOFF_PROMPT,
  SECRETS_RULES,
  SETUP_FLOW,
  type SetupStep,
} from "../setup-flow";

/**
 * The ONE renderer behind both documentation surfaces: SETUP.md's committed
 * generated blocks (`scripts/generate-setup-docs.ts` writes them, and the drift
 * test re-renders with this same function and asserts byte-equality) and the
 * `freshbooks_help` `setup` topic. Prose is never hand-written on either
 * surface — it is the Book (`src/setup-flow.ts`), rendered.
 *
 * Render rules, all from spec §Enforcement:
 *
 * (a) **Documentation ctx.** `{{placeholders}}` resolve against `DOC_CTX`, so
 *     the folder stays symbolic (`<project folder>`) and only real constants
 *     (the redirect URI) render literally. The wizard and the headless surface
 *     interpolate live values; the docs never do — a committed block must not
 *     depend on whose machine generated it.
 * (b) **Both role variants, capability-keyed.** Every block renders
 *     `agentGuidance` AND `humanScript` under headings that key on what the
 *     reader's Claude can DO — never "if Claude is driving", which a reader
 *     whose Claude drives only the conversation would wrongly self-select.
 *     `app-credentials` additionally carries the `SECRETS_RULES` table, its
 *     self-test and its honesty notes, so the agent-facing secrets rules reach
 *     the byte-tested document rather than living only in code.
 * (c) **appliesIf steps announce themselves** with the shows-this-step-only-if
 *     opener, because the reader of a document (unlike the wizard's user) sees
 *     conditional steps that may never be shown to them.
 *
 * NO I/O, and in particular **`check()` is never called**: `DOC_CTX` carries no
 * `exists`, so calling it would throw — and a documentation render must ask the
 * filesystem nothing. Only `successCheck` (the human-readable half) renders.
 * This module therefore imports nothing but the Book, which imports nothing at
 * all; `test/setup-flow.test.ts` asserts both.
 */

/** Spec §Enforcement rule (b) — verbatim, colon included. */
export const ROLE_HEADING_AGENT = "If Claude can run commands on your computer:";
/** Spec §Enforcement rule (b) — verbatim, colon included. */
export const ROLE_HEADING_HUMAN = "If you are typing every command yourself:";
/**
 * Spec §Enforcement rule (c). The spec drafts the opener; the condition itself
 * is not restated here — the step's own first instruction says when it applies
 * (for `migrate-legacy`: "You have tokens from an older version of this
 * project stored in the main .env file"), and duplicating it in the renderer
 * would create a second copy to drift.
 */
export const APPLIES_IF_OPENER =
  "The setup program shows this step only if it applies to you.";

/** Resolve `{{placeholders}}` against the documentation ctx (render rule (a)). */
function interpolate(text: string): string {
  return text
    .split("{{projectDir}}")
    .join(DOC_CTX.projectDir)
    .split("{{redirectUri}}")
    .join(DOC_CTX.redirectUri);
}

/** Markdown table cells cannot hold a raw `|` or a newline. */
function cell(text: string): string {
  return interpolate(text).split("|").join("\\|").split("\n").join(" ");
}

/**
 * The per-credential secrets table, rendered with the SAME capability-keyed
 * columns as the role headings so a reader classifies themselves once, plus the
 * self-test that catches the misclassification the columns invite.
 */
function renderSecretsBlock(): string {
  const rows = SECRETS_RULES.rows.map(
    (r) => `| ${cell(r.credential)} | ${cell(r.agentRungs)} | ${cell(r.humanRung)} |`,
  );
  return [
    "**Where each credential may go**",
    "",
    `| Credential | ${ROLE_HEADING_AGENT.replace(/:$/, "")} | ${ROLE_HEADING_HUMAN.replace(/:$/, "")} |`,
    "|---|---|---|",
    ...rows,
    "",
    `**Not sure which column is yours?** ${SECRETS_RULES.selfTest}`,
    "",
    "**Honest notes on the above:**",
    "",
    ...SECRETS_RULES.honestyNotes.map((n) => `- ${n}`),
  ].join("\n");
}

/**
 * Render one step as the canonical markdown block. Deterministic: the same step
 * always renders the same bytes, on any machine.
 */
export function renderSetupStepMd(step: SetupStep): string {
  const parts: string[] = [`## ${step.title}`];

  // Rule (c): the conditional announcement OPENS the block — a document's
  // reader, unlike the wizard's user, is shown steps that may not be theirs.
  if (step.appliesIf) parts.push(APPLIES_IF_OPENER);
  parts.push(interpolate(step.summary));
  // Kickoff rule 2 promises the guide says who can do each step, so that an
  // installing agent asks the user only for the steps marked as theirs.
  parts.push(`**Who does this:** ${step.who === "human" ? "you" : "you or Claude"}.`);
  if (step.repeats === "per-login")
    parts.push("This step repeats once for every FreshBooks login you connect.");

  parts.push(`### ${ROLE_HEADING_AGENT}`, interpolate(step.agentGuidance));
  parts.push(`### ${ROLE_HEADING_HUMAN}`);
  for (const line of step.humanScript) parts.push(interpolate(line));

  // The secrets table is `app-credentials`' own material (spec §Secrets,
  // Appendix A) — the only step that hands a credential over.
  if (step.id === "app-credentials") parts.push(renderSecretsBlock());

  parts.push(`**How to check it worked:** ${interpolate(step.successCheck)}`);

  if (step.troubleshooting.length > 0) {
    parts.push(
      [
        "**If something goes wrong**",
        "",
        "| If you see | Do this |",
        "|---|---|",
        ...step.troubleshooting.map((t) => `| ${cell(t.symptom)} | ${cell(t.fix)} |`),
      ].join("\n"),
    );
  }

  return parts.join("\n\n") + "\n";
}

/**
 * The `freshbooks_help` `setup` topic: the kickoff prompt plus every
 * docs-surface step, live from the Book. An assistant asked to install this
 * server elsewhere — or to add a second FreshBooks login here — reads this
 * instead of remembering.
 */
export function renderSetupTopic(): string {
  const steps = SETUP_FLOW.filter((s) => s.surfaces.includes("docs")).map(renderSetupStepMd);

  return `# FreshBooks MCP — Setup

Every word below is generated from \`src/setup-flow.ts\` — the same data the
interactive wizard (\`npm run setup\`), the headless verbs
(\`npx ts-node scripts/setup.ts --headless <verb>\`) and SETUP.md render. If this
page and the setup program ever disagree, that is a bug in this server, not a
choice for you to referee.

Each step below carries both roles: what to do when Claude can run commands on
this computer, and what to type when it cannot. A step marked
**Who does this:** you needs a person — a browser, an installer, or a restart —
no matter which Claude is reading.

## The kickoff prompt

This is the prompt that starts an install, pasted into a fresh chat with the
Claude that will host the server:

\`\`\`
${KICKOFF_PROMPT}
\`\`\`

${steps.join("\n")}`;
}
