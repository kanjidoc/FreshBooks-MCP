import { REPORT_PARAMS } from "../report-params";

/**
 * Render the `reports` help topic from REPORT_PARAMS — the same data the tests
 * lock, so this page cannot drift from what the tools actually send.
 */
export function renderReportsTopic(): string {
  const rows = Object.values(REPORT_PARAMS)
    .map((spec) => {
      const ignored = spec.ignored.length ? spec.ignored.join(", ") : "—";
      return `| \`${spec.tool}\` | \`${spec.path}\` | ${spec.honored.join(", ")} | ${ignored} | ${spec.verified} |`;
    })
    .join("\n");

  return `# FreshBooks MCP — Report Parameter Matrix

FreshBooks report endpoints **silently drop** any param they do not parse —
\`ok: true\`, no error, wrong numbers. Which params each endpoint honors is
therefore transcribed from an evidence artifact, never guessed: the
\`downloadToken\` JWT in every report response echoes the exact param set the
server parsed, in its \`params\` claim:

\`\`\`js
JSON.parse(Buffer.from(downloadToken.split(".")[1], "base64url").toString()).params
\`\`\`

Every report tool also echoes that decoded claim in its own output as
\`params_the_server_actually_parsed\` — check it to confirm a filter really
applied.

| Tool | Endpoint | Honored params | Proven ignored | Verified |
|---|---|---|---|---|
${rows}

Reports never paginate. All reports default to an **accrual** basis; those
honoring \`cash_based\` can report on a cash basis instead. \`test/report-params.test.ts\`
asserts every report tool's schema stays inside its matrix entry.`;
}
