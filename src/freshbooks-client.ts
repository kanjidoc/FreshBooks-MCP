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

/**
 * The single source of truth for OAuth tokens. `.env` lives next to this
 * package; the server loads it by absolute path (`src/load-env.ts`) and the
 * refresh logic writes rotated tokens back here. No other file holds tokens —
 * launcher configs (`.mcp.json`, the Claude Desktop config, `~/.claude.json`)
 * carry only the command to start the server. One home for the secret means
 * there is nothing to keep in sync and nothing that can drift.
 */
const ENV_FILE = join(__dirname, "..", ".env");

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

/** Read the access/refresh tokens currently stored in `.env`. */
function readEnvTokens(): { access?: string; refresh?: string } {
  const content = readFileSync(ENV_FILE, "utf8");
  return {
    access: content.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim(),
    refresh: content.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m)?.[1]?.trim(),
  };
}

/**
 * Return `.env` file content with the two token lines replaced. Throws if
 * either line is absent — a failed substitution must surface loudly, never
 * silently leave the old token in place.
 */
export function applyTokensToEnv(
  content: string,
  accessToken: string,
  refreshToken: string,
): string {
  const next = content
    .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$/m, `FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)
    .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$/m, `FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`);
  if (!next.includes(`FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)) {
    throw new Error("FRESHBOOKS_ACCESS_TOKEN line not found in .env");
  }
  if (!next.includes(`FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`)) {
    throw new Error("FRESHBOOKS_REFRESH_TOKEN line not found in .env");
  }
  return next;
}

/**
 * Verify `.env` is present, readable, writable, and holds both token markers —
 * BEFORE any refresh API call, so a refresh token is never burned when the
 * write-back could not have completed ("no preflight, no rotation").
 */
function preflightEnvFile(): void {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`[freshbooks] ${ENV_FILE} does not exist — run \`npm run setup\``);
  }
  try {
    accessSync(ENV_FILE, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error(`[freshbooks] ${ENV_FILE} is not readable/writable`);
  }
  const { access, refresh } = readEnvTokens();
  const missing: string[] = [];
  if (!access) missing.push("FRESHBOOKS_ACCESS_TOKEN");
  if (!refresh) missing.push("FRESHBOOKS_REFRESH_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `[freshbooks] ${ENV_FILE} is missing ${missing.join(", ")} — refusing to refresh`,
    );
  }
}

function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Write rotated tokens into `.env` — atomically (tmp + rename), with a `.bak`
 * backup and post-write read-back verification. If the write fails, the new
 * tokens are printed to stderr: the refresh has already rotated FreshBooks-side
 * state, so losing them silently would force a full OAuth recovery.
 */
function persistTokens(accessToken: string, refreshToken: string): void {
  try {
    const next = applyTokensToEnv(readFileSync(ENV_FILE, "utf8"), accessToken, refreshToken);
    writeAtomic(ENV_FILE, next);
    const after = readEnvTokens();
    if (after.access !== accessToken || after.refresh !== refreshToken) {
      throw new Error("post-write verification failed");
    }
  } catch (err: any) {
    console.error("[freshbooks] CRITICAL — refresh succeeded but writing .env failed.");
    console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
    console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
    console.error(`[freshbooks]   ${ENV_FILE}: ${err?.message ?? err}`);
    console.error("[freshbooks] Paste the two tokens above into .env NOW.");
    throw new Error(`Token persist to .env failed: ${err?.message ?? err}`, { cause: err });
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
      preflightEnvFile();
      const result = await client.refreshAccessToken();
      if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
      persistTokens(result.accessToken, result.refreshToken);
      client.accessToken = result.accessToken;
      client.refreshToken = result.refreshToken;
      console.error("[freshbooks] access token refreshed");
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

export interface TokenHealth {
  /** Absolute path of the `.env` token store. */
  envPath: string;
  exists: boolean;
  access?: string;
  refresh?: string;
  /** Seconds until the access token expires (negative if already expired). */
  expirySeconds: number | null;
  expired: boolean;
  issues: string[];
  needsRefresh: boolean;
}

/**
 * Read `.env` and report token presence + JWT expiry. No API call, no refresh —
 * safe to run anytime. Backs the `refresh-tokens` CLI's --check-only mode.
 */
export function inspectTokenHealth(bufferSeconds: number = REFRESH_BUFFER_SECONDS): TokenHealth {
  if (!existsSync(ENV_FILE)) {
    return {
      envPath: ENV_FILE,
      exists: false,
      expirySeconds: null,
      expired: false,
      issues: [`${ENV_FILE}: missing — run \`npm run setup\``],
      needsRefresh: false,
    };
  }

  let access: string | undefined;
  let refresh: string | undefined;
  try {
    ({ access, refresh } = readEnvTokens());
  } catch (err: any) {
    return {
      envPath: ENV_FILE,
      exists: true,
      expirySeconds: null,
      expired: false,
      issues: [`${ENV_FILE}: read error — ${err?.message ?? err}`],
      needsRefresh: false,
    };
  }

  const issues: string[] = [];
  if (!access) issues.push(`${ENV_FILE}: no access token`);
  if (!refresh) issues.push(`${ENV_FILE}: no refresh token`);

  let expirySeconds: number | null = null;
  let expired = false;
  if (access) {
    const exp = decodeJwtExp(access);
    if (exp !== null) {
      expirySeconds = exp - Math.floor(Date.now() / 1000);
      expired = expirySeconds <= 0;
    }
  }
  const nearExpiry = expirySeconds !== null && expirySeconds < bufferSeconds;
  const needsRefresh = expired || nearExpiry || (access !== undefined && expirySeconds === null);
  return { envPath: ENV_FILE, exists: true, access, refresh, expirySeconds, expired, issues, needsRefresh };
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
