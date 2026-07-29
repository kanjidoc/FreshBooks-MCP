/**
 * The report parameter support matrix — DATA, not prose. One entry per report
 * endpoint this server exposes. `test/report-params.test.ts` asserts every
 * report tool's schema stays inside its entry, and `freshbooks_help
 * topic=reports` renders the live matrix from it, so the docs cannot rot
 * independently of the code. This repo's #1 historical bug class is exactly
 * this drift (a filter offered on an endpoint that silently drops it).
 *
 * THE DOCTRINE (Part F of the Tier 2 design): `honored` is a TRANSCRIPTION of
 * an evidence artifact, never a guess. For reports the artifact is the
 * `downloadToken` JWT in each response — its `params` claim echoes the exact
 * set the server parsed. Unsupported params are silently dropped (`ok: true`,
 * no error), so a param offered without artifact backing would produce a
 * filter that looks applied and never was. To re-derive:
 *
 *   JSON.parse(Buffer.from(downloadToken.split(".")[1], "base64url").toString()).params
 *
 * `ignored` lists params that were PROBED and PROVEN dropped — the negative
 * results are as hard-won as the positive ones. Record `artifact: "none"` when
 * an entry has no evidence yet; never fill `honored` on such an entry.
 */
export interface ReportParamSpec {
  /** The MCP tool serving this endpoint. */
  tool: string;
  /** Path under `/accounting/account/<id>/reports/accounting/`. */
  path: string;
  /** Key under `response.result` holding the report payload. */
  envelope_key: string;
  /** Reports never paginate (verified across every probed endpoint). */
  paginates: false;
  /** Wire params the endpoint parses — transcribed from the artifact. */
  honored: string[];
  /** Wire params probed and proven silently ignored. */
  ignored: string[];
  /** Tool arg name → wire key, for args whose spelling differs on the wire. */
  argToWire: Record<string, string>;
  /** How `honored` was established. */
  artifact: "downloadToken.params";
  /** When the artifact was last captured (YYYY-MM-DD). */
  verified: string;
}

export const REPORT_PARAMS: Record<string, ReportParamSpec> = {
  profitloss: {
    tool: "freshbooks_report_profit_loss",
    path: "profitloss_entity",
    envelope_key: "profitloss", // NOT profitloss_entity — the path and key differ
    paginates: false,
    honored: [
      "start_date",
      "end_date",
      "cash_based",
      "fiscal_year_view",
      "currency_code",
      "resolution",
      "group_by_account",
      "group_by_category_id",
      "report_mode",
    ],
    ignored: [],
    argToWire: {},
    artifact: "downloadToken.params",
    verified: "2026-07-28",
  },
  taxsummary: {
    tool: "freshbooks_report_tax_summary",
    path: "taxsummary",
    envelope_key: "taxsummary",
    paginates: false,
    honored: ["start_date", "end_date", "cash_based", "currency_code"],
    ignored: ["fiscal_year_view"],
    argToWire: {},
    artifact: "downloadToken.params",
    verified: "2026-07-28",
  },
  payments_collected: {
    tool: "freshbooks_report_payments_collected",
    path: "payments_collected",
    envelope_key: "payments_collected",
    paginates: false,
    honored: ["start_date", "end_date", "currency_codes[]", "clientids[]", "payment_methods[]", "payment_for"],
    // The singular form is what the 2.0.0 audit wrongly prescribed; it is
    // parsed by nothing and was proven dropped on the wire.
    ignored: ["currency_code"],
    argToWire: { currency_code: "currency_codes[]" },
    artifact: "downloadToken.params",
    verified: "2026-07-28",
  },
};
