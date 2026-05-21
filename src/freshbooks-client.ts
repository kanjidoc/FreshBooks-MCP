import { Client } from "@freshbooks/api";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  accessSync,
  copyFileSync,
  renameSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { resolveDesktopConfigPath } from "./config-paths";

let fbClient: Client | null = null;

const REFRESH_BUFFER_SECONDS = 10 * 60;

// The FreshBooks SDK's axios instance ships with no timeout and 10 retries on
// idempotent failures (PUT/GET/DELETE). A hung connection or persistent 5xx —
// e.g. trying to PATCH the amount of a bank-imported expense — produces an
// indefinite spinner in MCP clients with no surfaced error. Cap both.
const REQUEST_TIMEOUT_MS = 30_000;
const IDEMPOTENT_METHODS = ["get", "head", "options", "put", "delete"];
const RETRY_OPTIONS = {
  retries: 2,
  retryDelay: (retryCount: number) => Math.min(1000 * 2 ** retryCount, 5000),
  retryCondition: (err: any) => {
    // A timed-out request has no response; retrying just multiplies the 30s
    // wait. Fail fast instead.
    if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") return false;
    // 429 means the request was rejected, not processed — safe to retry.
    if (err?.response?.status === 429) return true;
    // A pre-response network error may mean the request landed but the
    // response was lost. Only retry idempotent methods — retrying a POST
    // (e.g. create_expense) risks creating a duplicate record.
    const method = String(err?.config?.method ?? "").toLowerCase();
    return !err?.response && IDEMPOTENT_METHODS.includes(method);
  },
};

const ENV_FILE = join(__dirname, "..", ".env");
const MCP_FILE = join(__dirname, "..", ".mcp.json");

const JSON_ENV_PATH = ["mcpServers", "freshbooks", "env"] as const;

export type TokenFile = { path: string; kind: "env" | "json"; required: boolean };

/**
 * The token files this install uses. `.env` is the canonical store and is
 * always required. `.mcp.json` and the Claude Desktop config are OPTIONAL
 * mirrors — kept in sync only when they exist. This is what lets a fresh clone
 * on any OS (or an install that never touches Claude Desktop) refresh cleanly:
 * an absent optional mirror is simply skipped, never a failure.
 */
export function discoverTokenFiles(): TokenFile[] {
  return [
    { path: ENV_FILE, kind: "env", required: true },
    { path: MCP_FILE, kind: "json", required: false },
    { path: resolveDesktopConfigPath(), kind: "json", required: false },
  ];
}

/** Decode a JWT's `exp` (epoch seconds), or null if the token is opaque/invalid. */
export function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function getJsonEnvBlock(data: any): Record<string, string> {
  let cur = data;
  for (const key of JSON_ENV_PATH) {
    if (!cur || typeof cur !== "object" || !(key in cur)) {
      throw new Error(`missing path ${JSON_ENV_PATH.join(".")}`);
    }
    cur = cur[key];
  }
  if (typeof cur !== "object" || cur === null) {
    throw new Error(`path ${JSON_ENV_PATH.join(".")} is not an object`);
  }
  return cur as Record<string, string>;
}

function readTokensFromFile(file: TokenFile): { access?: string; refresh?: string } {
  const content = readFileSync(file.path, "utf8");
  if (file.kind === "env") {
    const access = content.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim();
    const refresh = content.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m)?.[1]?.trim();
    return { access, refresh };
  }
  const block = getJsonEnvBlock(JSON.parse(content));
  return { access: block.FRESHBOOKS_ACCESS_TOKEN, refresh: block.FRESHBOOKS_REFRESH_TOKEN };
}

/**
 * Verify the token files are reachable, writable, and contain both token markers.
 * Throws BEFORE any refresh API call so a refresh token is never burned when
 * persistence cannot complete — the "no preflight, no rotation" rule.
 *
 * An absent OPTIONAL mirror is skipped (legitimately not present). An absent
 * REQUIRED file (`.env`) fails preflight. A file that IS present must pass every
 * check — a present-but-broken mirror would drift, so it must abort the refresh.
 * Returns the files that exist and passed: these are the persist targets.
 */
function preflightTokenFiles(): TokenFile[] {
  const failures: string[] = [];
  const present: TokenFile[] = [];
  for (const file of discoverTokenFiles()) {
    if (!existsSync(file.path)) {
      if (file.required) failures.push(`${file.path}: does not exist (required)`);
      continue;
    }
    try {
      accessSync(file.path, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      failures.push(`${file.path}: not readable/writable`);
      continue;
    }
    try {
      const { access, refresh } = readTokensFromFile(file);
      if (!access) failures.push(`${file.path}: missing FRESHBOOKS_ACCESS_TOKEN`);
      if (!refresh) failures.push(`${file.path}: missing FRESHBOOKS_REFRESH_TOKEN`);
    } catch (err: any) {
      failures.push(`${file.path}: parse error — ${err.message ?? err}`);
      continue;
    }
    present.push(file);
  }
  if (failures.length > 0) {
    throw new Error(
      `[freshbooks] preflight failed — refusing to refresh (would burn refresh token):\n  ` +
        failures.join("\n  "),
    );
  }
  return present;
}

function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function persistOne(file: TokenFile, accessToken: string, refreshToken: string): void {
  const original = readFileSync(file.path, "utf8");
  let next: string;
  if (file.kind === "env") {
    next = original
      .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$/m, `FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)
      .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$/m, `FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`);
    if (!next.includes(`FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)) {
      throw new Error(`replace failed for FRESHBOOKS_ACCESS_TOKEN in ${file.path}`);
    }
    if (!next.includes(`FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`)) {
      throw new Error(`replace failed for FRESHBOOKS_REFRESH_TOKEN in ${file.path}`);
    }
  } else {
    const data = JSON.parse(original);
    const block = getJsonEnvBlock(data);
    if (!("FRESHBOOKS_ACCESS_TOKEN" in block) || !("FRESHBOOKS_REFRESH_TOKEN" in block)) {
      throw new Error(`env block missing token keys in ${file.path}`);
    }
    block.FRESHBOOKS_ACCESS_TOKEN = accessToken;
    block.FRESHBOOKS_REFRESH_TOKEN = refreshToken;
    next = JSON.stringify(data, null, 2) + "\n";
  }
  writeAtomic(file.path, next);
  // Read-back verification.
  const after = readTokensFromFile(file);
  if (after.access !== accessToken || after.refresh !== refreshToken) {
    throw new Error(`post-write verification failed for ${file.path}`);
  }
}

function persistTokens(accessToken: string, refreshToken: string, files: TokenFile[]): void {
  const failures: { path: string; error: string }[] = [];
  for (const file of files) {
    try {
      persistOne(file, accessToken, refreshToken);
    } catch (err: any) {
      failures.push({ path: file.path, error: err?.message ?? String(err) });
    }
  }
  if (failures.length > 0) {
    // Loudly print the new tokens so they aren't lost — refresh has already rotated
    // the FreshBooks-side state, so silently swallowing this would force full OAuth recovery.
    console.error("[freshbooks] CRITICAL — refresh succeeded but persist failed for some files.");
    console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
    console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
    for (const f of failures) {
      console.error(`[freshbooks]   failed: ${f.path} (${f.error})`);
    }
    console.error("[freshbooks] Manually paste the tokens above into the failed files NOW.");
    throw new Error(
      `Token persist failed for ${failures.length}/${files.length} files; new tokens logged above.`,
    );
  }
  process.env.FRESHBOOKS_ACCESS_TOKEN = accessToken;
  process.env.FRESHBOOKS_REFRESH_TOKEN = refreshToken;
}

let refreshInFlight: Promise<void> | null = null;

async function refreshAndPersist(client: Client): Promise<void> {
  // Single-flight: if many tool calls hit a near-expiry token at once, they all
  // await one refresh instead of each rotating the refresh token (only the first
  // rotation is valid — the rest would use a just-revoked token and fail).
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const present = preflightTokenFiles();
      const result = await client.refreshAccessToken();
      if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
      persistTokens(result.accessToken, result.refreshToken, present);
      client.accessToken = result.accessToken;
      client.refreshToken = result.refreshToken;
      console.error(
        `[freshbooks] access token refreshed and persisted to ${present.length} file(s)`,
      );
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Refresh the access token if it cannot be decoded, is expired, or is within
 * `bufferSeconds` of expiring. A no-op (no API call) when the token is current.
 * Returns whether a refresh actually ran.
 */
export async function refreshIfNeeded(
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): Promise<{ refreshed: boolean; reason: string }> {
  const token = process.env.FRESHBOOKS_ACCESS_TOKEN;
  if (!token) return { refreshed: false, reason: "no access token configured" };
  const exp = decodeJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp !== null && exp - now >= bufferSeconds) {
    return { refreshed: false, reason: "access token is current" };
  }
  const reason =
    exp === null
      ? "access token expiry could not be decoded"
      : exp - now <= 0
        ? "access token expired"
        : "access token near expiry";
  await refreshAndPersist(getFreshBooksClient());
  return { refreshed: true, reason };
}

/** Force a token refresh now, regardless of current expiry. */
export async function refreshTokensNow(): Promise<void> {
  await refreshAndPersist(getFreshBooksClient());
}

/** Refresh the access token at startup if it is near expiry. Called from index.ts. */
export async function ensureFreshToken(): Promise<void> {
  await refreshIfNeeded();
}

export interface TokenFileState {
  path: string;
  kind: "env" | "json";
  required: boolean;
  exists: boolean;
  access?: string;
  refresh?: string;
  error?: string;
}

export interface TokenHealth {
  files: TokenFileState[];
  drift: boolean;
  expirySeconds: number | null;
  expired: boolean;
  issues: string[];
  needsRefresh: boolean;
}

/**
 * Read every token file and report drift + JWT expiry. No API call, no refresh —
 * safe to run anytime. Backs the `refresh-tokens` CLI's --check-only mode.
 */
export function inspectTokenHealth(bufferSeconds: number = REFRESH_BUFFER_SECONDS): TokenHealth {
  const states: TokenFileState[] = [];
  const issues: string[] = [];
  for (const file of discoverTokenFiles()) {
    if (!existsSync(file.path)) {
      states.push({ ...file, exists: false });
      if (file.required) issues.push(`${file.path}: missing (required)`);
      continue;
    }
    try {
      const { access, refresh } = readTokensFromFile(file);
      states.push({ ...file, exists: true, access, refresh });
      if (!access) issues.push(`${file.path}: no access token`);
      if (!refresh) issues.push(`${file.path}: no refresh token`);
    } catch (err: any) {
      states.push({ ...file, exists: true, error: err?.message ?? String(err) });
      issues.push(`${file.path}: parse error — ${err?.message ?? err}`);
    }
  }
  const accessValues = new Set(states.map((s) => s.access).filter(Boolean));
  const refreshValues = new Set(states.map((s) => s.refresh).filter(Boolean));
  const drift = accessValues.size > 1 || refreshValues.size > 1;
  if (drift) issues.push("token drift: token files hold different values");

  const primary = states.find((s) => s.access)?.access;
  let expirySeconds: number | null = null;
  let expired = false;
  if (primary) {
    const exp = decodeJwtExp(primary);
    if (exp !== null) {
      expirySeconds = exp - Math.floor(Date.now() / 1000);
      expired = expirySeconds <= 0;
    }
  }
  const nearExpiry = expirySeconds !== null && expirySeconds < bufferSeconds;
  const needsRefresh =
    drift || expired || nearExpiry || (primary !== undefined && expirySeconds === null);
  return { files: states, drift, expirySeconds, expired, issues, needsRefresh };
}

export function getFreshBooksClient(): Client {
  if (!fbClient) {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    if (!clientId) {
      throw new Error("FRESHBOOKS_CLIENT_ID is not set");
    }

    fbClient = new Client(clientId, {
      accessToken: process.env.FRESHBOOKS_ACCESS_TOKEN,
      refreshToken: process.env.FRESHBOOKS_REFRESH_TOKEN,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
      retryOptions: RETRY_OPTIONS as any,
    });

    // The SDK exposes its axios instance; set a hard per-request timeout so a
    // stalled connection fails loudly instead of hanging the MCP tool call.
    (fbClient as any).axios.defaults.timeout = REQUEST_TIMEOUT_MS;
  }
  return fbClient;
}

export function getAccountId(): string {
  const accountId = process.env.FRESHBOOKS_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("FRESHBOOKS_ACCOUNT_ID is not set");
  }
  return accountId;
}

export function getBusinessId(): number {
  const businessId = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!businessId) {
    throw new Error("FRESHBOOKS_BUSINESS_ID is not set");
  }
  return parseInt(businessId, 10);
}
