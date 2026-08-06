/**
 * FreshBooks MCP — non-interactive setup core.
 *
 * Every setup step that talks to FreshBooks or to disk lives here: building the
 * OAuth client, minting the authorization URL, exchanging the callback code,
 * reading the login's businesses, and writing tokens into `profiles/<name>.env`.
 * Nothing in this module prompts, prints, or reads `process.argv` — the wizard
 * (`scripts/setup.ts`) and the headless verbs each supply their own I/O around
 * these calls, so both drive exactly the same logic.
 *
 * Extracted from `scripts/setup.ts` behavior-identically; the wizard now
 * delegates to it rather than inlining the same steps.
 *
 * Token-hygiene rule for everything below: no function here writes a token to
 * stdout/stderr or embeds one in a thrown message. Profile files are written
 * ONLY through `writeNewProfile` (via `saveProfile`) or
 * `applyTokensToEnv` + `writeAtomic` (via `replaceProfileTokens`) — never with a
 * bare `writeFileSync`.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@freshbooks/api";
import { writeAtomic, readTokenMarkers } from "../src/atomic-write";
import { applyTokensToEnv } from "../src/freshbooks-client";
import { ProfileWriteError, writeNewProfile } from "../src/migrate";
import { parseProfileConfig, type ProfileConfig } from "../src/profiles";

/**
 * What a login's `users.me()` read yields, in the shape setup needs.
 *
 * NOTE: `businessId` is a STRING here. That is deliberate — this value is on its
 * way into a `profiles/<name>.env` line, and every profile field is serialized
 * as text (`ProfileConfig.businessId` is a string too). The server-side contract
 * is the opposite: `getBusinessId()` returns a number because the project
 * endpoints take `businessId: number`. The conversion happens once, at read
 * time, in `src/freshbooks-client.ts`.
 */
export interface Memberships {
  user: { firstName?: string; lastName?: string; email?: string };
  list: { label: string; accountId: string; businessId: string }[];
}

/**
 * Build the pre-authorization `Client` — app credentials only, no tokens yet.
 *
 * This is the carve-out to CLAUDE.md's "a `Client` is constructed in exactly one
 * place" invariant: that invariant governs the SERVING path (`src/`), where
 * `getOrCreateClient` remains the only construction site because a profile's
 * rotating token state must live on one object. Setup runs before any profile
 * exists, so it has no profile to hang a client off — it builds its own here,
 * and only here.
 */
export function buildOAuthClient(clientId: string, clientSecret: string, redirectUri: string): Client {
  return new Client(clientId, { clientSecret, redirectUri });
}

/**
 * Build a `Client` that carries a token pair which is NOT (yet) a saved profile
 * — a freshly exchanged pair, or one staged in a pending file.
 *
 * The pair is assigned after construction (the `src/freshbooks-client.ts:201`
 * pattern) rather than passed as constructor options: the SDK's `call()` re-sets
 * the `Authorization` header from `this.accessToken` on every request, so the
 * two forms are equivalent on the wire and the assignment keeps a single
 * construction site for setup's clients.
 *
 * The app credentials come along because a token client may still need to
 * `refreshAccessToken()` — the SDK's `authorizeCall` requires both the client
 * secret and the redirect URI.
 */
export function buildTokenClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  accessToken: string,
  refreshToken: string,
): Client {
  const client = buildOAuthClient(clientId, clientSecret, redirectUri);
  client.accessToken = accessToken;
  client.refreshToken = refreshToken;
  return client;
}

/** The FreshBooks authorization URL the user opens to approve this connection. */
export function buildAuthUrl(client: Client): string {
  return client.getAuthRequestUrl();
}

/**
 * Pull the `code` out of whatever the user pasted back: a full redirect URL, or
 * the bare code on its own. Returns null when neither is recognizable, so the
 * caller can re-prompt instead of sending garbage to FreshBooks.
 */
export function extractCodeFromUrl(urlString: string): string | null {
  try {
    // Handle both full URLs and just the code value
    if (!urlString.startsWith("http")) {
      return urlString; // User pasted just the code
    }
    const url = new URL(urlString);
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

/**
 * Trade an authorization code for a token pair.
 *
 * Throws on rejection — an expired/mistyped code, or a response the SDK could
 * not turn into tokens (its `getAccessToken` resolves `undefined` when the
 * authorize call did not come back `ok`). Callers map the throw onto their own
 * surface: the wizard re-prompts, the headless verbs exit 3.
 *
 * The SDK's rejection is re-thrown unchanged and never widened: an axios error
 * carries the request body — including `client_secret` — on `err.config.data`,
 * so anything that serialized the error object here would leak the app secret
 * into a transcript.
 */
export async function exchangeCode(
  client: Client,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const tokens = await client.getAccessToken(code);
  if (!tokens) throw new Error("FreshBooks returned no tokens");
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/**
 * Read who this login is and which businesses it belongs to. A pure read: no
 * prompting, no choosing — returning the whole list is what lets the caller
 * decide (the wizard asks the user; `--add-login` refuses a multi-business login
 * until `--business-id` names one).
 *
 * Throws when the identity read yields nothing, so a caller can tell "this login
 * has no businesses" (empty list — a legitimate accounting-only login) apart
 * from "the lookup failed".
 */
export async function discoverMemberships(authed: Client): Promise<Memberships> {
  const meResponse = await authed.users.me();
  if (!meResponse.ok || !meResponse.data) {
    throw new Error("FreshBooks returned no account details for this login");
  }
  const user = meResponse.data as any;
  const memberships: any[] = Array.isArray(user.businessMemberships) ? user.businessMemberships : [];

  return {
    user: { firstName: user.firstName, lastName: user.lastName, email: user.email },
    list: memberships.map((m) => {
      const business = m?.business;
      return {
        label: business?.name ?? "(unnamed business)",
        accountId: String(business?.accountId ?? m?.accountId ?? ""),
        businessId: String(business?.id ?? m?.businessId ?? ""),
      };
    }),
  };
}

/**
 * Persist a NEW login as `profiles/<name>.env`.
 *
 * A pass-through to the shared guarded writer — deliberately adding nothing, so
 * there is exactly one implementation of the duplicate-token / name-collision /
 * same-account guards and setup can never route around them.
 */
export function saveProfile(
  profilesDir: string,
  name: string,
  config: ProfileConfig,
  opts?: Parameters<typeof writeNewProfile>[3],
): string {
  return writeNewProfile(profilesDir, name, config, opts);
}

/**
 * Refuse if any OTHER profile file already carries `refreshToken`.
 *
 * `writeNewProfile` runs this guard for a new profile; re-auth needs it too, but
 * writes in place (the profile already exists), so it never reaches that guard.
 * Two files sharing one refresh token guarantee a double-rotation lockout, so
 * the check must happen on both paths — same code, same message.
 *
 * `name` is the profile being written and must already be normalized: its own
 * file is skipped (re-auth legitimately re-writes its own token). Only
 * `*.env` files are scanned, so a staged `<name>.env.pending` — which holds the
 * very pair being installed — is invisible here.
 */
export function assertNoForeignDuplicate(
  profilesDir: string,
  name: string,
  refreshToken: string,
): void {
  if (!existsSync(profilesDir)) return;
  for (const file of readdirSync(profilesDir)) {
    if (!file.endsWith(".env") || file === `${name}.env`) continue;
    const other = parseProfileConfig(readFileSync(join(profilesDir, file), "utf8"));
    if (!other) continue;
    if (other.refreshToken === refreshToken) {
      throw new ProfileWriteError(
        "DUPLICATE_TOKEN",
        `Refresh token already present in profiles/${file} — refusing to write profiles/${name}.env. ` +
          `Two profile files sharing one refresh token guarantee a double-rotation lockout.`,
      );
    }
  }
}

/**
 * Swap the token pair inside an EXISTING profile file, atomically and verified —
 * the `persistTokens` pattern (`src/freshbooks-client.ts:145-170`) minus the
 * client/config state, since re-auth runs outside any server process.
 *
 * `applyTokensToEnv` throws if either marker line is missing, so a failed
 * substitution surfaces loudly instead of leaving the old token in place; every
 * other line (comments, the distinct-login marker, the IDs) is preserved.
 */
export function replaceProfileTokens(
  profilePath: string,
  accessToken: string,
  refreshToken: string,
): void {
  const next = applyTokensToEnv(readFileSync(profilePath, "utf8"), accessToken, refreshToken);
  writeAtomic(profilePath, next);

  const after = readTokenMarkers(profilePath);
  if (after.access !== accessToken || after.refresh !== refreshToken) {
    throw new Error(`${profilePath} failed post-write verification.`);
  }

  // Security §rescue-file lifecycle, precedence rule: every successful verified
  // guarded token write to <file> shreds <file>.rescue as superseded, so a
  // deliberate re-auth can never be silently reverted by a later adoption of a
  // stale rescue pair. The rescue file itself lands in PR 2 (Task 13, which owns
  // this line's test); `force` makes its absence — the case in PR 1 — a no-op.
  rmSync(`${profilePath}.rescue`, { force: true });
}
