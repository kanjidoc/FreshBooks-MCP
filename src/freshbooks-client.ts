import { Client } from "@freshbooks/api";
import { existsSync, accessSync, readFileSync, constants as fsConstants } from "node:fs";
import { writeAtomic, readTokenMarkers } from "./atomic-write";
import { currentProfile, getRegistry, type ProfileState } from "./profiles";

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

/** True when `token` decodes to an `exp` at least `bufferSeconds` in the future. */
function isTokenFresh(token: string, bufferSeconds: number): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return false; // opaque / undecodable → never treat as provably fresh
  return exp - Math.floor(Date.now() / 1000) >= bufferSeconds;
}

/**
 * Return a profile env-file's content with the two token lines replaced. Throws
 * if either line is absent — a failed substitution must surface loudly, never
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
 * The ONLY place a FreshBooks `Client` is constructed (Amendment A1). The client
 * is cached on `profile.client`, so the refresh path and the tool handlers share
 * one object — a rotated token applied to it is seen everywhere immediately.
 */
export function getOrCreateClient(profile: ProfileState): Client {
  if (!profile.client) {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    if (!clientId) throw new Error("FRESHBOOKS_CLIENT_ID is not set");
    profile.client = new Client(clientId, {
      accessToken: profile.config.accessToken,
      refreshToken: profile.config.refreshToken,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
      retryOptions: RETRY_OPTIONS as any,
    });
    // The SDK exposes its axios instance; set a hard per-request timeout so a
    // stalled connection fails loudly instead of hanging the MCP tool call.
    (profile.client as any).axios.defaults.timeout = REQUEST_TIMEOUT_MS;
  }
  return profile.client;
}

/** The client for the active profile (ALS context). */
export function getFreshBooksClient(): Client {
  return getOrCreateClient(currentProfile());
}

export function getAccountId(): string {
  const id = currentProfile().config.accountId;
  if (!id) throw new Error("account id is not set for the active profile");
  return id;
}

export function getBusinessId(): number {
  const id = currentProfile().config.businessId;
  if (!id) throw new Error("business id is not set for the active profile");
  return parseInt(id, 10);
}

/**
 * Verify a profile's token file is present, readable, writable, and holds both
 * token markers — BEFORE any refresh API call, so a refresh token is never
 * burned when the write-back could not have completed ("no preflight, no
 * rotation").
 */
function preflightEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`[freshbooks] ${filePath} does not exist — run \`npm run setup\``);
  }
  try {
    accessSync(filePath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error(`[freshbooks] ${filePath} is not readable/writable`);
  }
  const { access, refresh } = readTokenMarkers(filePath);
  const missing: string[] = [];
  if (!access) missing.push("FRESHBOOKS_ACCESS_TOKEN");
  if (!refresh) missing.push("FRESHBOOKS_REFRESH_TOKEN");
  if (missing.length > 0) {
    throw new Error(`[freshbooks] ${filePath} is missing ${missing.join(", ")} — refusing to refresh`);
  }
}

/**
 * Write rotated tokens into the profile file — atomically (tmp + rename), with a
 * `.bak` backup and post-write read-back verification. The profile `config` is
 * updated to the rotated values on BOTH the success path AND the write-failure
 * path (Amendment A10): the refresh has already rotated FreshBooks-side state, so
 * the in-memory authoritative copy must agree with the (revoked-old) token either
 * way, or this process would churn re-rotations. On write failure the new tokens
 * are printed to stderr so they can be pasted into the file manually.
 */
function persistTokens(profile: ProfileState, accessToken: string, refreshToken: string): void {
  try {
    const next = applyTokensToEnv(readFileSync(profile.filePath, "utf8"), accessToken, refreshToken);
    writeAtomic(profile.filePath, next);
    const after = readTokenMarkers(profile.filePath);
    if (after.access !== accessToken || after.refresh !== refreshToken) {
      throw new Error("post-write verification failed");
    }
  } catch (err: any) {
    console.error(
      `[freshbooks] CRITICAL — refresh succeeded but writing ${profile.filePath} failed (profile "${profile.name}").`,
    );
    console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
    console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
    console.error(`[freshbooks]   ${err?.message ?? err}`);
    console.error("[freshbooks] Paste the two tokens above into the profile file NOW.");
    // A10: keep config authoritative even on write failure so the live (already-
    // rotated) client and the expiry check agree, avoiding a re-rotation churn
    // loop this process.
    profile.config.accessToken = accessToken;
    profile.config.refreshToken = refreshToken;
    throw new Error(`Token persist to ${profile.filePath} failed: ${err?.message ?? err}`, { cause: err });
  }
  profile.config.accessToken = accessToken;
  profile.config.refreshToken = refreshToken;
}

async function refreshAndPersist(
  profile: ProfileState,
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): Promise<void> {
  // Per-profile single-flight: if many tool calls hit a near-expiry token at
  // once, they all await one refresh instead of each rotating the refresh token
  // (only the first rotation is valid — the rest would use a just-revoked token
  // and fail). The check-then-set is synchronous (no await before the assignment)
  // so concurrent callers in the same process can never both pass the guard.
  if (profile.refreshInFlight) return profile.refreshInFlight;
  profile.refreshInFlight = (async () => {
    try {
      preflightEnvFile(profile.filePath);
      const client = getOrCreateClient(profile); // SAME object the handler uses (A1)

      // U3 — cross-process refresh guard. The in-memory single-flight does not
      // coordinate across separate server processes, and SETUP.md documents
      // registering the server in multiple Claude surfaces (each its own process
      // against one profiles/ dir). Re-read the token file immediately before
      // rotating: if another process already rotated it to a token that DIFFERS
      // from ours AND is itself still fresh, adopt that token and SKIP rotation.
      // Double-rotating would burn the refresh-token family and lock the login
      // out; this also heals stale-in-memory state after another process rotated.
      const onDisk = readTokenMarkers(profile.filePath);
      if (
        onDisk.access &&
        onDisk.access !== profile.config.accessToken &&
        isTokenFresh(onDisk.access, bufferSeconds)
      ) {
        profile.config.accessToken = onDisk.access;
        client.accessToken = onDisk.access;
        if (onDisk.refresh) {
          profile.config.refreshToken = onDisk.refresh;
          client.refreshToken = onDisk.refresh;
        }
        console.error(
          `[freshbooks] adopted on-disk token for profile "${profile.name}" (rotated by another process); skipping refresh`,
        );
        return;
      }

      const result = await client.refreshAccessToken();
      if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
      // Update the shared client BEFORE the (throwing) persist so a file-write
      // failure can never leave the live client on the just-revoked token (A1).
      // This does not depend on the SDK also mutating these internally (it does —
      // that is defense-in-depth).
      client.accessToken = result.accessToken;
      client.refreshToken = result.refreshToken;
      persistTokens(profile, result.accessToken, result.refreshToken);
      console.error(`[freshbooks] access token refreshed for profile "${profile.name}"`);
    } finally {
      profile.refreshInFlight = null;
    }
  })();
  return profile.refreshInFlight;
}

/**
 * Refresh a profile's access token if it cannot be decoded, is expired, or is
 * within `bufferSeconds` of expiring. A no-op (no API call) when the token is
 * current. Returns whether a refresh was triggered and why.
 */
export async function refreshIfNeeded(
  profile: ProfileState,
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): Promise<{ refreshed: boolean; reason: string }> {
  const token = profile.config.accessToken;
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
  await refreshAndPersist(profile, bufferSeconds);
  return { refreshed: true, reason };
}

/** Force a token refresh now for one profile, regardless of current expiry. */
export async function refreshTokensNow(profile: ProfileState): Promise<void> {
  await refreshAndPersist(profile);
}

/**
 * Startup: refresh each configured profile sequentially with per-profile
 * isolation (Amendment A4). Never throws — a single bad profile must not abort
 * startup for the others. (R2) Quarantined profiles are SKIPPED entirely: a
 * same-accountId collision may be a diverged copy whose superseded refresh token
 * would lock the login's token family out if rotated.
 */
export async function ensureFreshTokens(): Promise<void> {
  for (const profile of getRegistry().profiles.values()) {
    if (profile.quarantined) {
      console.error(
        `[freshbooks] skipping quarantined profile "${profile.name}" — not auto-refreshed (R2)`,
      );
      continue;
    }
    try {
      await refreshIfNeeded(profile);
    } catch (err) {
      console.error(
        `[freshbooks] startup refresh failed for "${profile.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export interface TokenHealth {
  /** Profile name (registry key). */
  name: string;
  /** Absolute path of this profile's token file. */
  filePath: string;
  access?: string;
  refresh?: string;
  /** Seconds until the access token expires (negative if already expired). */
  expirySeconds: number | null;
  expired: boolean;
  issues: string[];
  needsRefresh: boolean;
}

/**
 * Report a profile's token presence + JWT expiry from its authoritative
 * `config`. No API call, no refresh — safe to run anytime. Backs the
 * `refresh-tokens` CLI's --check-only mode.
 */
export function inspectTokenHealth(
  profile: ProfileState,
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): TokenHealth {
  const { accessToken: access, refreshToken: refresh } = profile.config;
  const issues: string[] = [];
  if (!access) issues.push("no access token");
  if (!refresh) issues.push("no refresh token");

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
  return {
    name: profile.name,
    filePath: profile.filePath,
    access,
    refresh,
    expirySeconds,
    expired,
    issues,
    needsRefresh,
  };
}
