import { Client } from "@freshbooks/api";
import {
  existsSync,
  accessSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
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

/**
 * Decode a JWT's `iat` (epoch seconds), or null if the token is opaque/invalid.
 *
 * `iat` — not `exp` — is what orders two token pairs: a rescued pair and the
 * pair in the profile file can share an expiry window, but the one FreshBooks
 * issued LAST is the only one whose refresh token is still live.
 */
export function decodeJwtIat(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof payload.iat === "number" ? payload.iat : null;
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

// ---------------------------------------------------------------------------
// The rescue file — `<profile-file>.rescue` (spec §Security hardening)
// ---------------------------------------------------------------------------
//
// A refresh that succeeds FreshBooks-side and then fails to write the profile
// file leaves the only live token pair in memory: the pair on disk is revoked,
// so the next process to start is locked out of that login. The rescue file is
// where that pair goes instead of onto stderr, and the refresh path — not the
// user, not a later verb — owns adopting it back.
//
// Two rules keep it from becoming a second, competing token store:
//
//   1. ADOPT ONLY WHAT IS NEWER. Adoption compares the access tokens' `iat`
//      against the pair ON DISK, and only a strictly newer rescue is adopted.
//   2. EVERY VERIFIED GUARDED WRITE SHREDS IT. `persistTokens` here and
//      `replaceProfileTokens` (the `--reauth` path) both delete it on success,
//      so a deliberate re-auth can never be silently reverted by a later
//      adoption.

/** Where a profile's rescued pair lives. */
function rescuePathFor(filePath: string): string {
  return `${filePath}.rescue`;
}

/**
 * Write the rescued pair next to the profile file, 0600. Returns false — never
 * throws — when the write fails, because the caller's fallback is the last-resort
 * stderr print and it must still happen.
 *
 * The content is the two dotenv token lines and nothing else: it parses as a
 * profile fragment (`parseProfileConfig` requires exactly these two), so the
 * adopting read is the same `readTokenMarkers` every other token read uses.
 */
function writeRescue(filePath: string, access: string, refresh: string): boolean {
  const path = rescuePathFor(filePath);
  try {
    writeFileSync(
      path,
      `FRESHBOOKS_ACCESS_TOKEN=${access}\nFRESHBOOKS_REFRESH_TOKEN=${refresh}\n`,
      { mode: 0o600 },
    );
    try {
      // `mode` applies at creation only — an overwritten older rescue would
      // otherwise keep its (possibly looser) permissions.
      chmodSync(path, 0o600);
    } catch {
      // Best-effort; `--doctor`'s permission check reports what is left loose.
    }
    return true;
  } catch {
    return false;
  }
}

/** Delete a superseded rescue. Best-effort: a stale one is a warning, not a lockout. */
function shredRescue(filePath: string, why: string): void {
  const path = rescuePathFor(filePath);
  try {
    rmSync(path, { force: true });
  } catch (err: any) {
    console.error(
      `[freshbooks] could not delete ${path} (${err?.message ?? err}) — ${why}; ` +
        "delete it by hand.",
    );
  }
}

/**
 * Adopt `<file>.rescue` when it holds a pair NEWER than the profile file's, and
 * return whether it did.
 *
 * Comparison is against the token ON DISK, never `profile.config`: on the
 * same-process persist-failure path A10 has already synced `config` to the
 * rescued pair, so a config comparison would read "equal", shred the rescue,
 * and leave the disk holding the revoked pair — the exact lockout the rescue
 * exists to prevent.
 *
 * Adoption is BOTH halves — the profile file AND the in-memory pair (config +
 * the live client, mirroring U3's adopt) — because a rescue older than the
 * access-token lifetime fails the freshness gate, and rotation would then run
 * with the revoked in-memory refresh token and burn the family in exactly the
 * unattended-overnight-restart case this mechanism exists for.
 *
 * Fail closed: an undecodable pair on either side is neither adopted NOR
 * shredded, so `--doctor` keeps reporting it and no guess rotates anything.
 */
function tryAdoptRescue(profile: ProfileState): boolean {
  const path = rescuePathFor(profile.filePath);
  if (!existsSync(path)) return false;

  let rescue: { access?: string; refresh?: string };
  try {
    rescue = readTokenMarkers(path);
  } catch (err: any) {
    console.error(
      `[freshbooks] ${path} could not be read (${err?.message ?? err}) — keeping it, not adopting.`,
    );
    return false;
  }
  if (!rescue.access || !rescue.refresh) {
    console.error(`[freshbooks] ${path} is missing a token line — keeping it, not adopting.`);
    return false;
  }

  const rescueIat = decodeJwtIat(rescue.access);
  const diskIat = decodeJwtIat(readTokenMarkers(profile.filePath).access ?? "");
  if (rescueIat === null || diskIat === null) {
    console.error(
      `[freshbooks] ${path} cannot be ordered against ${profile.filePath} ` +
        "(an access token has no decodable iat) — keeping it, not adopting.",
    );
    return false;
  }

  if (rescueIat <= diskIat) {
    // Announce first, shred second: a failed shred prints its own correction
    // right after this line rather than contradicting it from above.
    console.error(
      `[freshbooks] discarding superseded rescue file ${path} for profile "${profile.name}" ` +
        "— the profile file already holds an equally new or newer pair.",
    );
    shredRescue(profile.filePath, "it is superseded");
    return false;
  }

  // Newer: write it into the profile file first, verified, so the in-memory
  // adopt below is never the only record of it. A failure here keeps the rescue
  // and throws — loudly, with the pair still on disk to try again from.
  const next = applyTokensToEnv(
    readFileSync(profile.filePath, "utf8"),
    rescue.access,
    rescue.refresh,
  );
  writeAtomic(profile.filePath, next);
  const after = readTokenMarkers(profile.filePath);
  if (after.access !== rescue.access || after.refresh !== rescue.refresh) {
    throw new Error(
      `[freshbooks] adopting ${path} into ${profile.filePath} failed post-write verification`,
    );
  }

  // Hand-rolled rather than routed through persistTokens: this is not a
  // rotation, and persistTokens would shred the rescue before the file write
  // it is protecting had been verified.
  profile.config.accessToken = rescue.access;
  profile.config.refreshToken = rescue.refresh;
  const client = getOrCreateClient(profile);
  client.accessToken = rescue.access;
  client.refreshToken = rescue.refresh;

  console.error(
    `[freshbooks] adopted the rescued token pair from ${path} into ${profile.filePath}`,
  );
  shredRescue(profile.filePath, "it has been adopted");
  return true;
}

/**
 * Write rotated tokens into the profile file — atomically (tmp + rename), with a
 * `.bak` backup and post-write read-back verification. The profile `config` is
 * updated to the rotated values on BOTH the success path AND the write-failure
 * path (Amendment A10): the refresh has already rotated FreshBooks-side state, so
 * the in-memory authoritative copy must agree with the (revoked-old) token either
 * way, or this process would churn re-rotations.
 *
 * On write failure the pair goes to `<file>.rescue` and only its PATH is printed;
 * the tokens themselves reach stderr solely when even that write fails — the one
 * sanctioned exception to this project's "tokens never on an output surface"
 * rule, and the last thing standing between the user and a locked-out login.
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
    if (writeRescue(profile.filePath, accessToken, refreshToken)) {
      console.error(`[freshbooks] The new token pair was saved to ${rescuePathFor(profile.filePath)} (mode 0600).`);
      console.error(
        "[freshbooks] It is adopted automatically at the next refresh that needs it; " +
          "`npm run setup -- --headless --doctor` reports it until then.",
      );
    } else {
      console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
      console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
      console.error("[freshbooks] Paste the two tokens above into the profile file NOW.");
    }
    console.error(`[freshbooks]   ${err?.message ?? err}`);
    // A10: keep config authoritative even on write failure so the live (already-
    // rotated) client and the expiry check agree, avoiding a re-rotation churn
    // loop this process.
    profile.config.accessToken = accessToken;
    profile.config.refreshToken = refreshToken;
    throw new Error(`Token persist to ${profile.filePath} failed: ${err?.message ?? err}`, { cause: err });
  }
  profile.config.accessToken = accessToken;
  profile.config.refreshToken = refreshToken;
  // Precedence rule: a verified guarded write supersedes any rescue, whatever it
  // holds — including one this refresh could not order and therefore kept.
  shredRescue(profile.filePath, "the profile file now holds a newer pair");
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
  const run = (async () => {
    preflightEnvFile(profile.filePath);
    const client = getOrCreateClient(profile); // SAME object the handler uses (A1)

    // A rescued pair from an earlier failed write outranks everything below: it
    // is the newest pair FreshBooks issued, so the on-disk pair the U3 read is
    // about to consult may already be revoked. Adoption writes it to disk AND
    // in memory; if it is still fresh there is nothing left to rotate.
    const adopted = tryAdoptRescue(profile);
    if (adopted && isTokenFresh(profile.config.accessToken, bufferSeconds)) {
      console.error(`[freshbooks] adopted rescue pair for "${profile.name}"; skipping refresh`);
      return;
    }
    // A stale adopted pair falls through deliberately: the rotation below now
    // runs with the ADOPTED refresh token (the live one) rather than the
    // revoked pair the profile file held a moment ago.

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
  })();
  // Reset the single-flight handle STRICTLY AFTER assigning it, as a microtask —
  // never synchronously inside the IIFE. The IIFE body runs synchronously up to
  // its first `await`, so any path that settles before that await (the U3-adopt
  // early `return`, or a synchronous throw from preflightEnvFile/getOrCreateClient/
  // readTokenMarkers) would, under an inner `finally { refreshInFlight = null }`,
  // null the handle BEFORE this assignment ran — then the assignment would re-pin
  // it to an already-settled promise and wedge every later refresh on the stale
  // settled handle. Assigning first and resetting via `.finally` (which always
  // fires as a microtask, even for an already-settled promise) keeps the
  // guard→assign step synchronous while guaranteeing the reset overwrites a value
  // that is definitely `run`.
  profile.refreshInFlight = run;
  run
    .finally(() => {
      profile.refreshInFlight = null;
    })
    // The caller awaits `run` directly, so body rejections still propagate to it;
    // this `.catch` only suppresses an unhandled-rejection warning on the derived
    // reset chain — it must NOT (and does not) swallow the caller's error.
    .catch(() => {});
  return run;
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

/**
 * SECURITY INVARIANT — this struct must NEVER carry token material (not even a
 * substring/suffix). It is serialized verbatim by the `refresh-tokens` CLI's
 * `--json` mode and rendered by `freshbooks_list_accounts`, so anything on it
 * lands in agent transcripts and logs. Presence is reported as booleans;
 * anything that needs the actual tokens reads `profile.config` directly.
 * Guarded by test/refresh-tokens-redaction.test.ts.
 */
export interface TokenHealth {
  /** Profile name (registry key). */
  name: string;
  /** Absolute path of this profile's token file. */
  filePath: string;
  /** Whether an access token is configured (the token itself is never exposed). */
  hasAccessToken: boolean;
  /** Whether a refresh token is configured (the token itself is never exposed). */
  hasRefreshToken: boolean;
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
    hasAccessToken: Boolean(access),
    hasRefreshToken: Boolean(refresh),
    expirySeconds,
    expired,
    issues,
    needsRefresh,
  };
}
