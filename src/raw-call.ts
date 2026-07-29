import type { Client } from "@freshbooks/api";
import {
  isAccountingErrorResponse,
  isAuthErrorResponse,
  isProjectErrorResponse,
  transformAccountingErrorResponse,
  transformAuthErrorResponse,
  transformProjectErrorResponse,
} from "@freshbooks/api/dist/models/Error";
import { getFreshBooksClient } from "./freshbooks-client";

/**
 * Direct access to FreshBooks endpoints the frozen Node SDK (4.1.0, 2024-09-11)
 * never wrapped — estimates, staff, taxes, invoice profiles, and six ledger
 * reports. Everything here goes through the SDK's own private `call()`:
 *
 *   - `call()` re-syncs `Authorization` from `client.accessToken` on EVERY
 *     request (APIClient.js), so a token rotated by `refreshIfNeeded` is picked
 *     up immediately. Touching `client.axios` directly would send the token
 *     baked into axios defaults at construction — i.e. a stale one.
 *   - It inherits this repo's retry policy and 30s timeout (both installed by
 *     `getOrCreateClient`).
 *
 * ERROR-FORK DESIGN — decided, do not reopen. Two options were considered for
 * surfacing API errors that arrive as HTTP 200 bodies:
 *   (a) a custom axios `transformResponse` that raises early, and
 *   (b) inspecting `response.data` for an error envelope AFTER `call()` returns.
 * (b) was chosen. (a) fails four verified ways: a custom transform REPLACES
 * axios's default JSON parser (mergeConfig.js) so it receives a raw string;
 * `call()` reads only `{errors:[{message}]}` or `{message}` from a thrown body
 * and discards everything else; returning nullish or `errors: []` from the
 * transform makes `call()` throw a raw TypeError; and a throw inside the
 * transform escapes with no `.response` attached. All four traps buy nothing
 * but prettier error strings.
 *
 * NEVER-THROW IS A PROPERTY, NOT A COMMENT. `rawRequest`/`rawList` never
 * reject, whatever `call()` does — throws a string, throws `undefined`,
 * resolves nullish, resolves `{errors: []}`, resolves HTML, resolves an error
 * body with HTTP 200. `test/raw-call.test.ts` asserts each case.
 *
 * PROHIBITED here: registering anything in this file as a tool; any
 * module-level queue, pool, scheduler, or worker (a shared worker is born
 * outside `als.run`, so `getFreshBooksClient()` inside it resolves the WRONG
 * profile and returns another company's ledger with `ok: true`). Per-profile
 * throttles belong on `ProfileState`, like `refreshInFlight`.
 *
 * KNOWN GAP (accepted): `detectErrorEnvelope` checks only the endpoint's own
 * namespace dialect, so a cross-dialect 200 error body (auth-style `{error}`
 * on an accounting path) returns `ok: true` — it is caught the moment the
 * tool's shape calls `unwrapEnvelope` (→ drift, body echoed). A raw tool that
 * renders WITHOUT a shape must know unwrapping is its only error net.
 */

/** Appended to every raw-backed tool description — the two-tier seam marker. */
export const RAW_TIER_DESC =
  "Direct API access: the FreshBooks Node SDK does not wrap this endpoint. Fields are raw API names (snake_case), not the camelCase used by SDK-backed tools.";

export type RawNamespace = "accounting" | "auth" | "project";

export interface RawErrorDetail {
  message: string;
  errorCode?: number;
  field?: string;
  object?: string;
  value?: string;
}

export type RawFailureKind =
  /** The API said no — HTTP error status, or an error envelope in a 200 body. */
  | "api_error"
  /** A 200 body our code no longer understands. NOT an API error — the books
   * may be fine; it is THIS server that has drifted from the API contract. */
  | "envelope_drift"
  /** A multi-page read that cannot be trusted end-to-end (page echo mismatch,
   * zero progress, mid-read failure, totals drifting between pages). No
   * partial data is returned — in an accounting tool, silent wrong numbers
   * are worse than a crash. */
  | "integrity"
  /** A bug in THIS server (contract gate, query-builder misuse, missing
   * profile context, a broken shape callback) — deterministic, retry is
   * guaranteed waste, and it must never masquerade as an API problem. */
  | "internal"
  /** Network/timeout/SDK-internal failure before any API verdict. */
  | "transport";

export interface RawFailure {
  ok: false;
  kind: RawFailureKind;
  statusCode?: string;
  /** Always non-empty (tested property). */
  message: string;
  errors?: RawErrorDetail[];
  /** Echoed on envelope_drift — never discard a body we failed to parse. */
  rawBody?: unknown;
}

export interface RawSuccess<T = unknown> {
  ok: true;
  data: T;
}

export type RawResult<T = unknown> = RawSuccess<T> | RawFailure;

/** Why an exhaustive listing stopped early (budget/size stops only — integrity
 * stops never return data at all). */
export type RawListStop = "page_cap" | "time_budget" | "size_ceiling";

export interface RawListComplete {
  ok: true;
  complete: true;
  rows: unknown[];
  pages_fetched: number;
  pages_total: number;
  total: number;
}

export interface RawListIncomplete {
  ok: true;
  complete: false;
  stopped_by: RawListStop;
  rows: unknown[];
  pages_fetched: number;
  pages_total: number;
  total: number;
}

export type RawListResult = RawListComplete | RawListIncomplete | RawFailure;

/* ------------------------------------------------------------------------- *
 * Pure primitives (exported for tests — T1: builders catch wrong paths/wire
 * keys, historically 100% of this repo's shipped bug class)
 * ------------------------------------------------------------------------- */

export type RawQueryValue = string | number | boolean | Array<string | number> | undefined;

/**
 * Build a query string with URLSearchParams (the SDK's own QueryBuilderType
 * path does NOT percent-encode values and cannot emit a repeated key). Array
 * values emit as repeated `key[]=v` pairs — the only array form these
 * endpoints parse — and their keys MUST already carry the `[]` suffix so the
 * wire truth is visible at the call site. `undefined` means omit entirely:
 * these endpoints silently drop unknown params, so an explicit `false` would
 * pin a server-side default the API might change.
 */
export function buildRawQuery(params: Record<string, RawQueryValue>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (!key.endsWith("[]")) {
        throw new Error(`buildRawQuery: array param "${key}" must be spelled "${key}[]"`);
      }
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.set(key, String(value));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Thrown (internally — always caught before a tool sees it) when a 200 body
 * does not match the documented envelope. Carries the body for echoing. */
export class EnvelopeDriftError extends Error {
  constructor(
    message: string,
    public readonly rawBody: unknown,
  ) {
    super(message);
    this.name = "EnvelopeDriftError";
  }
}

/**
 * Unwrap `{ response: { result: { <key>: … } } }`. Three outcomes, exactly:
 * missing key → throw (drift); wrong type → throw (drift); present and empty
 * → OK. An empty collection means "your books don't have this" — success. A
 * missing envelope means "our code no longer understands this API" — those are
 * opposite conditions and must never be conflated.
 */
export function unwrapEnvelope<T = unknown>(
  body: unknown,
  key: string,
  expect: "array" | "object",
): { value: T; result: Record<string, unknown> } {
  if (typeof body !== "object" || body === null) {
    throw new EnvelopeDriftError(`response body is ${body === null ? "null" : typeof body}, not an object`, body);
  }
  const response = (body as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) {
    throw new EnvelopeDriftError(`response body has no "response" object`, body);
  }
  const result = (response as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    throw new EnvelopeDriftError(`response envelope has no "result" object`, body);
  }
  const value = (result as Record<string, unknown>)[key];
  if (value === undefined) {
    throw new EnvelopeDriftError(`response result has no "${key}" key`, body);
  }
  const matches =
    expect === "array"
      ? Array.isArray(value)
      : typeof value === "object" && value !== null && !Array.isArray(value);
  if (!matches) {
    throw new EnvelopeDriftError(`response result "${key}" is not an ${expect}`, body);
  }
  return { value: value as T, result: result as Record<string, unknown> };
}

export interface RawPageMeta {
  page: number;
  pages: number;
  total: number;
  perPage: number | null;
}

/** Page meta from an accounting `result` object, or null when absent. */
export function readPageMeta(result: Record<string, unknown>): RawPageMeta | null {
  const { page, pages, total } = result;
  if (typeof page !== "number" || typeof pages !== "number" || typeof total !== "number") {
    return null;
  }
  const perPage = result.per_page;
  return { page, pages, total, perPage: typeof perPage === "number" ? perPage : null };
}

/**
 * Decode a report `downloadToken`'s `params` claim — the API's own echo of the
 * param set it actually parsed. Never throws; null when undecodable. This is
 * the evidence artifact behind every report's honored-params list, and echoing
 * it per-response lets the model see that its own `cash_based: true` was (or
 * was not) applied.
 */
export function decodeReportParams(downloadToken: unknown): Record<string, unknown> | null {
  if (typeof downloadToken !== "string") return null;
  try {
    const parts = downloadToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const params = payload?.params;
    return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Error-envelope detection (the chosen fork: inspect AFTER call() returns)
 * ------------------------------------------------------------------------- */

const CLASSIFIERS: Record<
  RawNamespace,
  {
    is: (status: string, body: any) => boolean;
    transform: (body: any) => { message?: string; errors?: RawErrorDetail[] };
  }
> = {
  accounting: { is: isAccountingErrorResponse, transform: transformAccountingErrorResponse },
  auth: { is: isAuthErrorResponse, transform: transformAuthErrorResponse },
  project: { is: isProjectErrorResponse, transform: transformProjectErrorResponse },
};

/** The SDK transforms' own we-extracted-nothing sentinel. */
const SDK_GENERIC_MESSAGE = "Returned an unexpected response";

/**
 * Detect a 200-with-error-body response for the endpoint's namespace. The SDK
 * classifiers FIRE on more dialects than their transforms can extract a
 * message from (accounting's singular `response.error`, auth's `error` without
 * `error_description`, project's bare `errno`), so when the transform yields
 * only its generic sentinel, the dialect fields are read directly — the API's
 * actual verdict ("account suspended", "invalid_grant") must never degrade to
 * "unexpected response".
 */
function detectErrorEnvelope(namespace: RawNamespace, body: unknown): RawFailure | null {
  if (typeof body !== "object" || body === null) return null; // handled as drift by callers
  const { is, transform } = CLASSIFIERS[namespace];
  // Status "200": the classifier's status>=400 arm is inert; only the
  // body-shape checks can fire here (4xx/5xx never reach this code — they
  // throw out of call()).
  if (!is("200", body)) return null;
  const t = transform(body);
  let message = t.errors?.[0]?.message ?? (t.message !== SDK_GENERIC_MESSAGE ? t.message : undefined);
  if (!message) {
    const b = body as {
      response?: { error?: unknown };
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    message =
      (typeof b.response?.error === "string" && b.response.error) ||
      (typeof b.error_description === "string" && b.error_description) ||
      (typeof b.error === "string" && b.error) ||
      (typeof b.message === "string" && b.message) ||
      "FreshBooks returned an error body with HTTP 200";
  }
  return {
    ok: false,
    kind: "api_error",
    statusCode: "200",
    message,
    errors: t.errors,
    rawBody: body,
  };
}

/* ------------------------------------------------------------------------- *
 * rawRequest
 * ------------------------------------------------------------------------- */

type RawCallable = {
  call(
    method: string,
    url: string,
    config: object,
    data: unknown,
    name: string,
  ): Promise<{ ok: boolean; data: unknown }>;
};

/**
 * The SDK-contract gate. `test/sdk-contract.test.ts` pins the same facts
 * against the real prototype; this runtime check is the hard enforcement in
 * case the dependency is ever swapped underneath a built dist/.
 */
function asRawCallable(client: Client): RawCallable {
  const call = (client as unknown as { call?: unknown }).call;
  if (typeof call !== "function" || call.length !== 5) {
    throw new Error(
      "@freshbooks/api Client.call() contract changed (missing or wrong arity) — raw endpoint access disabled",
    );
  }
  return client as unknown as RawCallable;
}

export interface RawRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Absolute API path, e.g. `/accounting/account/${accountId}/estimates/estimates`. */
  path: string;
  query?: Record<string, RawQueryValue>;
  body?: unknown;
  /** Operation name, threaded into SDK error objects. */
  name: string;
  /** Which error-envelope dialect the endpoint speaks. Default: accounting. */
  namespace?: RawNamespace;
}

function failureFromThrown(err: unknown): RawFailure {
  // The SDK's call() throws APIClientError { name, message, statusCode, errors }
  // for HTTP errors, and re-throws raw axios/network errors (no .response) as-is.
  // NOTE (SDK limitation, verified at 4.1.0): call()'s own catch reads only the
  // TOP-LEVEL errData.errors/message, while accounting bodies nest detail under
  // response.errors — so a thrown accounting 4xx arrives here already stripped
  // to its HTTP statusText. Only the 200-with-error-body path preserves
  // per-field detail. Nothing here can recover what the SDK discarded.
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; statusCode?: unknown; errors?: unknown };
    const statusCode = typeof e.statusCode === "string" ? e.statusCode : undefined;
    const message =
      (typeof e.message === "string" && e.message.trim()) ||
      `FreshBooks request failed${statusCode ? ` (HTTP ${statusCode})` : ""}`;
    const errors = Array.isArray(e.errors)
      ? (e.errors.filter(
          (x) => typeof x === "object" && x !== null && typeof (x as { message?: unknown }).message === "string",
        ) as RawErrorDetail[])
      : undefined;
    return { ok: false, kind: statusCode ? "api_error" : "transport", statusCode, message, errors };
  }
  const text = typeof err === "string" && err.trim() ? err.trim() : String(err ?? "unknown error");
  return { ok: false, kind: "transport", message: `FreshBooks request failed: ${text}` };
}

/** A deterministic bug in THIS server — never an API condition. */
function internalFailure(err: unknown): RawFailure {
  const text = err instanceof Error ? err.message : String(err ?? "unknown internal error");
  return {
    ok: false,
    kind: "internal",
    message: `Internal error in this MCP server (not the FreshBooks API): ${text}`,
  };
}

function driftFailure(message: string, rawBody: unknown): RawFailure {
  // Loud, per freshbooks-client.ts precedent: drift means THIS SERVER no longer
  // understands the API — not that the books are wrong. Surface it immediately.
  console.error(`[freshbooks] CRITICAL — raw endpoint envelope drift: ${message}`);
  return { ok: false, kind: "envelope_drift", message: `Envelope drift: ${message}`, rawBody };
}

/**
 * One raw API request through the SDK's `call()`. Resolves a `RawResult`,
 * NEVER rejects. Takes no client parameter on purpose: it resolves the active
 * profile's client via `getFreshBooksClient()` internally. If it accepted a
 * `Client`, someone would eventually pass `getOrCreateClient(profile)` — which
 * `accounts.ts` legitimately does OUTSIDE the ALS context — and silently cross
 * profiles, returning another company's books with `ok: true`.
 */
export async function rawRequest(opts: RawRequestOptions): Promise<RawResult> {
  const namespace = opts.namespace ?? "accounting";
  // Setup phase: nothing here touches the network, so any throw (missing
  // profile context, SDK contract gate, buildRawQuery misuse) is OUR bug —
  // classified `internal`, whose imperative forbids retrying.
  let raw: RawCallable;
  let url: string;
  try {
    raw = asRawCallable(getFreshBooksClient());
    url = opts.path + buildRawQuery(opts.query ?? {});
  } catch (err) {
    return internalFailure(err);
  }
  try {
    const res = await raw.call(opts.method, url, {}, opts.body ?? null, opts.name);
    const data = (res as { data?: unknown } | null | undefined)?.data;
    if (data === undefined || data === null) {
      // Echo the whole resolution, not just its missing .data — never discard
      // a body we failed to parse.
      return driftFailure(`call() resolved with no response body for ${opts.name}`, res);
    }
    if (typeof data !== "object") {
      return driftFailure(`non-JSON response body for ${opts.name}`, data);
    }
    const apiError = detectErrorEnvelope(namespace, data);
    if (apiError) return apiError;
    return { ok: true, data };
  } catch (err) {
    return failureFromThrown(err);
  }
}

/* ------------------------------------------------------------------------- *
 * rawList — exhaustive pagination with integrity guards
 * ------------------------------------------------------------------------- */

const LIST_PER_PAGE = 100; // the API's per-page ceiling
const LIST_PAGE_CAP = 100; // 10,000 rows — a budget stop, not an error
const LIST_BUDGET_MS = 50_000; // < 2× the 30s per-request timeout; one page + backoff can burn ~66s
const LIST_SIZE_CEILING_BYTES = 4_000_000; // ~4MB of accumulated rows — a budget stop

export interface RawListOptions {
  /** Absolute API path of the collection (no query string). */
  path: string;
  /** The key under `response.result` holding the row array. */
  envelopeKey: string;
  /** Extra query params. NEVER page/per_page — pagination is not caller-visible. */
  query?: Record<string, RawQueryValue>;
  name: string;
  namespace?: RawNamespace;
  /** Overrides for tests only. */
  budgetMs?: number;
  pageCap?: number;
  perPage?: number;
  sizeCeilingBytes?: number;
}

function integrityFailure(message: string, cause?: RawFailure): RawFailure {
  return {
    ok: false,
    kind: "integrity",
    // The underlying failure's status/details ride along so errorImperative
    // can give the RIGHT instruction — a mid-read 403 must say "do not retry",
    // not the generic integrity retry advice.
    statusCode: cause?.statusCode,
    errors: cause?.errors,
    // A partially-authenticated or self-inconsistent ledger is not a warning
    // condition: no partial data leaves this function.
    message: `${message} No partial data returned — any total computed from an incomplete listing would be silently wrong.`,
  };
}

/**
 * Fetch EVERY page of a collection. No `page`/`per_page` is exposed to
 * callers; completeness is computed (`pages_fetched === pages_total &&
 * rows.length === total`), never assumed.
 *
 * Integrity failures (page echo mismatch, zero progress, mid-read error,
 * end-of-read count mismatch) → `ok: false`, NO partial data. Budget stops
 * (page cap, time budget, size ceiling) → `ok: true, complete: false` with
 * `stopped_by`, which `renderRaw` surfaces as a first-key WARNING_INCOMPLETE.
 *
 * The time budget is a `Date.now()` check at loop top — never a timer that
 * resumes work, because anything resuming off a timer risks escaping the
 * AsyncLocalStorage profile context.
 */
export async function rawList(opts: RawListOptions): Promise<RawListResult> {
  const budgetMs = opts.budgetMs ?? LIST_BUDGET_MS;
  const pageCap = opts.pageCap ?? LIST_PAGE_CAP;
  const perPage = opts.perPage ?? LIST_PER_PAGE;
  const sizeCeiling = opts.sizeCeilingBytes ?? LIST_SIZE_CEILING_BYTES;
  const started = Date.now();
  const rows: unknown[] = [];
  let page = 1;
  // Written every page (before any read) — grouped so the declarations carry no
  // dead initializers of their own.
  const seen: {
    pagesTotal: number;
    total: number;
    approxBytes: number;
    prevFirstRow: string | null;
  } = { pagesTotal: 0, total: 0, approxBytes: 0, prevFirstRow: null };

  for (;;) {
    const res = await rawRequest({
      method: "GET",
      path: opts.path,
      query: { ...(opts.query ?? {}), page, per_page: perPage },
      name: opts.name,
      namespace: opts.namespace,
    });
    if (!res.ok) {
      if (page === 1) return res; // nothing fetched yet — the failure stands on its own
      return integrityFailure(
        `Listing failed mid-read on page ${page} of ${seen.pagesTotal} (${res.kind}: ${res.message}).`,
        res, // status/details ride along so a mid-read 401/403 gets the right imperative
      );
    }

    let value: unknown[];
    let result: Record<string, unknown>;
    try {
      ({ value, result } = unwrapEnvelope<unknown[]>(res.data, opts.envelopeKey, "array"));
    } catch (err) {
      if (err instanceof EnvelopeDriftError) return driftFailure(err.message, err.rawBody);
      return failureFromThrown(err);
    }
    const meta = readPageMeta(result);
    if (!meta) {
      return driftFailure(
        `paginated endpoint ${opts.name} returned no page/pages/total meta`,
        res.data,
      );
    }
    if (meta.page !== page) {
      return integrityFailure(
        `Page echo mismatch: requested page ${page}, API answered page ${meta.page}.`,
      );
    }
    // The API's own totals must hold still across the read. Page 1 says
    // total=144 and page 2 says total=143 → a row was deleted mid-read and the
    // offsets have shifted under us: rows were skipped or duplicated even if
    // the FINAL count happens to match the final total.
    if (page > 1 && (meta.total !== seen.total || meta.pages !== seen.pagesTotal)) {
      return integrityFailure(
        `Books changed mid-read: the API's total went ${seen.total} → ${meta.total} (pages ${seen.pagesTotal} → ${meta.pages}) between pages.`,
      );
    }
    // A server that ignores `page` but echoes the requested number back
    // defeats the echo guard; two consecutive pages starting with the same
    // row is the cheap tell.
    const firstRow = value.length > 0 ? JSON.stringify(value[0]) : null;
    if (page > 1 && firstRow !== null && firstRow === seen.prevFirstRow) {
      return integrityFailure(
        `Duplicate page detected: page ${page} begins with the same row as page ${page - 1} — the server appears to be ignoring the page parameter.`,
      );
    }
    if (value.length === 0 && meta.total > rows.length) {
      return integrityFailure(
        `Zero-progress page: page ${page} returned no rows while ${meta.total - rows.length} of ${meta.total} remain.`,
      );
    }
    rows.push(...value);
    for (const v of value) seen.approxBytes += JSON.stringify(v)?.length ?? 0;
    seen.pagesTotal = meta.pages;
    seen.total = meta.total;
    seen.prevFirstRow = firstRow;

    if (page >= meta.pages) break; // done (also the empty-collection case: pages 0)

    // Budget stops — checked between pages, plain Date.now() at loop top.
    if (page >= pageCap) {
      return { ok: true, complete: false, stopped_by: "page_cap", rows, pages_fetched: page, pages_total: seen.pagesTotal, total: seen.total };
    }
    if (Date.now() - started > budgetMs) {
      return { ok: true, complete: false, stopped_by: "time_budget", rows, pages_fetched: page, pages_total: seen.pagesTotal, total: seen.total };
    }
    if (seen.approxBytes > sizeCeiling) {
      return { ok: true, complete: false, stopped_by: "size_ceiling", rows, pages_fetched: page, pages_total: seen.pagesTotal, total: seen.total };
    }
    page++;
  }

  if (rows.length !== seen.total) {
    return integrityFailure(
      `Row-count mismatch after full read: fetched ${rows.length} rows across ${page} page(s) but the API reports total=${seen.total} (the books changed mid-read).`,
    );
  }
  return { ok: true, complete: true, rows, pages_fetched: page, pages_total: seen.pagesTotal, total: seen.total };
}

/* ------------------------------------------------------------------------- *
 * renderRaw — the ONE place raw results become MCP tool output
 * ------------------------------------------------------------------------- */

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Imperative suffixes (Part G): without one, a model's default reaction to
 * any error is to permute arguments and retry — a write-safety problem against
 * real books. Status-code imperatives run FIRST so a mid-read 401/403 inside
 * an integrity failure still gets the right instruction. */
function errorImperative(f: RawFailure): string {
  if (f.statusCode === "403") {
    return "Do not retry: this is a permanent capability gap — the FreshBooks plan or role behind this profile does not include this feature. Tell the user which account profile lacks it.";
  }
  if (f.statusCode === "422") {
    return "DO NOT guess additional or alternative fields and retry: this API drops unknown keys silently, so a lucky retry can appear to succeed while writing wrong data. Tell the user which field the API rejected (if it reported one).";
  }
  if (f.statusCode === "401") {
    return "Do not immediately retry: the token was rejected. Call freshbooks_list_accounts to check this profile's token health first.";
  }
  switch (f.kind) {
    case "envelope_drift":
      return "Do not retry: this server no longer understands the API's response shape for this endpoint. Show the user the raw payload below and tell them to report it as a bug.";
    case "integrity":
      return "Retry the call once; if it fails again, tell the user the listing could not be completed.";
    case "internal":
      return "Do not retry — this is a bug in this MCP server, not the FreshBooks API. Tell the user to report it.";
    case "transport":
      return "Retry once; if it fails again, tell the user the FreshBooks API is unreachable.";
    default:
      return "If a retry with the same arguments fails again, tell the user rather than permuting arguments.";
  }
}

const INCOMPLETE_WARNING =
  "This listing is INCOMPLETE — it stopped early at a safety budget. Any total, sum, or count computed from this payload will be WRONG. Say so to the user, and narrow the query (e.g. a tighter date range) to get a complete listing.";

/**
 * Render a RawResult/RawListResult as an MCP tool result. Raw handlers are
 * three lines — visibly not members of the 74-strong SDK-backed family — and
 * WARNING_INCOMPLETE, drift echoing, and error imperatives cannot be
 * reimplemented 23 slightly-different ways.
 *
 * `shape` runs only on success. For a single result it maps `data` to the
 * payload to render (envelope unwrapping, summary pruning, params echo). For
 * a LIST result it receives the ROWS ARRAY ONLY — the completeness envelope
 * (WARNING_INCOMPLETE, stopped_by, counts) is assembled here afterwards, so
 * no shape callback can strip the incompleteness warning off a listing.
 */
export function renderRaw(
  result: RawResult | RawListResult,
  shape?: (data: unknown) => unknown,
): McpToolResult {
  if (!result.ok) {
    const parts = [result.message];
    if (result.errors?.length) {
      parts.push(result.errors.map((e) => `- ${e.field ? `${e.field}: ` : ""}${e.message}`).join("\n"));
    }
    const imperative = errorImperative(result);
    if (imperative) parts.push(imperative);
    // Echo the body on drift always, and on an api_error whose structured
    // detail came back empty — the API's own words are the only evidence left.
    const echoBody =
      result.rawBody !== undefined &&
      (result.kind === "envelope_drift" || (result.kind === "api_error" && !result.errors?.length));
    if (echoBody) {
      let echo: string;
      try {
        echo = JSON.stringify(result.rawBody);
      } catch {
        echo = String(result.rawBody);
      }
      parts.push(`Raw payload (for the bug report): ${echo}`);
    }
    return { content: [{ type: "text", text: parts.join("\n") }], isError: true };
  }

  // shape() may legitimately throw EnvelopeDriftError (it usually calls
  // unwrapEnvelope). A throw here must become a failure result, not escape the
  // tool handler — never-throw covers the renderer too.
  try {
    let payload: unknown;
    if ("rows" in result) {
      const rows = shape ? shape(result.rows) : result.rows;
      const base = {
        rows,
        pages_fetched: result.pages_fetched,
        pages_total: result.pages_total,
        total: result.total,
      };
      payload = result.complete
        ? { complete: true, ...base }
        : // WARNING_INCOMPLETE is deliberately the FIRST key so it is the first
          // thing in the rendered JSON — and it is attached AFTER shape ran.
          { WARNING_INCOMPLETE: INCOMPLETE_WARNING, stopped_by: result.stopped_by, complete: false, ...base };
    } else {
      payload = shape ? shape(result.data) : result.data;
    }
    // JSON.stringify(undefined) is undefined — a forgotten `return` in a shape
    // must not produce malformed MCP content.
    const text = JSON.stringify(payload, null, 2) ?? "null";
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const failure =
      err instanceof EnvelopeDriftError
        ? driftFailure(err.message, err.rawBody)
        : internalFailure(err); // a broken shape is OUR bug, not a transport fault
    return renderRaw(failure); // failure branch above — cannot recurse again
  }
}
