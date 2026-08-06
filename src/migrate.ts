import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic, readTokenMarkers } from "./atomic-write";
import { parseProfileConfig, normalizeProfileName, type ProfileConfig } from "./profiles";
import { lockPathFor, isServerLockFresh } from "./server-lock";

/**
 * Migration of a legacy single-login `.env` into `profiles/<name>.env`.
 *
 * This is the highest-consequence operation in the multi-account feature: during
 * the move both copies of the ONLY refresh token live on disk, so ordering and the
 * live-server guard are load-bearing. A bug here can permanently lock the owner out
 * of their FreshBooks books. The invariants enforced below:
 *   - R1: never migrate while a live server holds the lock (it could rotate the
 *         token concurrently and burn it) — `confirmNoServer` is the ONLY override.
 *   - Transactional: the profile file is written AND post-write verified BEFORE the
 *         base `.env` is stripped, so a failure never leaves the tokens nowhere.
 *   - R2: refuse to write a profile whose refresh token already exists in another
 *         profile file (two files sharing one refresh token => double-rotation burn).
 *   - U4: shred the token-bearing `.env.bak` once the migration has verified.
 *   - U5: strip ALL occurrences of each token/ID line (global flag), so a duplicated
 *         line can't survive and be silently repopulated by load-env's override:true.
 *   - U10: a run interrupted after the profile write but before the strip is resumable.
 */
export const MIGRATED_MARKER = "FRESHBOOKS_MIGRATED";

/** The machine-readable reasons `writeNewProfile` refuses to write a profile. */
export type ProfileWriteErrorCode = "NAME_TAKEN" | "DUPLICATE_TOKEN" | "SAME_ACCOUNT";

/**
 * A refusal from a profile-write guard, carrying a `code` callers can branch on.
 *
 * The codes exist so headless callers can map a refusal onto an exit code without
 * parsing prose. The MESSAGES are deliberately unchanged from the untyped throws
 * they replace: `scripts/setup.ts` prints `err.message` verbatim to the user and
 * the existing suite matches on that text, so reword nothing here.
 */
export class ProfileWriteError extends Error {
  constructor(
    public readonly code: ProfileWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProfileWriteError";
  }
}

export function isMigrated(baseEnvContent: string): boolean {
  return new RegExp(`^${MIGRATED_MARKER}=`, "m").test(baseEnvContent);
}

export function buildProfileFileContent(config: ProfileConfig): string {
  return [
    `FRESHBOOKS_ACCESS_TOKEN=${config.accessToken}`,
    `FRESHBOOKS_REFRESH_TOKEN=${config.refreshToken}`,
    `FRESHBOOKS_ACCOUNT_ID=${config.accountId}`,
    `FRESHBOOKS_BUSINESS_ID=${config.businessId}`,
    "",
  ].join("\n");
}

/**
 * Remove every token/ID line from the base `.env` and append the idempotency marker.
 * (U5) The `/gm` global flag is deliberate: a partial prior write or a hand-edit can
 * leave the same marker line twice; a non-global `/m` regex would strip only the first
 * and leave a residual that `load-env`'s `override:true` silently re-injects into
 * `process.env`. We assert post-strip that none of the four markers survives.
 */
export function stripTokensFromBaseEnv(content: string): string {
  let out = content
    .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$\n?/gm, "")
    .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$\n?/gm, "")
    .replace(/^FRESHBOOKS_ACCOUNT_ID=.*$\n?/gm, "")
    .replace(/^FRESHBOOKS_BUSINESS_ID=.*$\n?/gm, "");
  // (U5/A10) Enforce — not just promise — that NO token/ID line survives. With the
  // `/gm` global flag this holds even for a doubled line; were `/g` ever dropped in
  // a refactor, a residual duplicate would slip through and `load-env`'s
  // `override:true` would silently re-inject it. Fail loudly here rather than write
  // a base `.env` that still carries a login's secrets.
  const residual = out.match(
    /^FRESHBOOKS_(?:ACCESS_TOKEN|REFRESH_TOKEN|ACCOUNT_ID|BUSINESS_ID)=.*$/m,
  );
  if (residual) {
    throw new Error(
      `stripTokensFromBaseEnv left a residual token/ID line ("${residual[0]}") — ` +
        "the base .env is malformed; refusing to write a still-leaky base .env.",
    );
  }
  if (!isMigrated(out)) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += `${MIGRATED_MARKER}=1\n`;
  }
  return out;
}

/**
 * Move the legacy single-login tokens from base `.env` into `profiles/<name>.env`.
 *
 * Ordering (Amendment A2): refuse if a live server holds the lock (unless the caller
 * confirms none is attached) -> re-read the FRESHEST tokens from `.env` -> write+verify
 * the profile file atomically -> ONLY THEN strip+mark base `.env` -> shred the backup.
 *
 * `confirmNoServer` is the ONLY way past a live lock; there is intentionally NO blind
 * `force` that skips the liveness probe — training the user to disable the one safety
 * guarding against permanent lockout is unacceptable. The setup CLI sets it only after
 * interactively asking the user to confirm no server is running.
 */
export function runMigration(opts: {
  name: string;
  rootDir: string;
  confirmNoServer?: boolean;
}): { profilePath: string } {
  const { rootDir } = opts;
  const name = normalizeProfileName(opts.name);
  const baseEnv = join(rootDir, ".env");
  const profilesDir = join(rootDir, "profiles");
  const profilePath = join(profilesDir, `${name}.env`);

  if (!existsSync(baseEnv)) {
    throw new Error(`No .env at ${baseEnv} — nothing to migrate.`);
  }

  // (R1) Live-server guard — pure pid liveness. A live server could rotate the only
  // refresh token concurrently and burn it (the A2 CRITICAL race).
  if (isServerLockFresh(lockPathFor(rootDir)) && !opts.confirmNoServer) {
    throw new Error(
      "A FreshBooks MCP server appears to be running (a live .server.lock is held). " +
        "Stop it and retry, or re-run confirming no server is attached (confirmNoServer). " +
        "Migrating while a server is live can burn the only refresh token.",
    );
  }

  // Re-read the freshest token pair from disk immediately before the move.
  const baseContent = readFileSync(baseEnv, "utf8");
  if (isMigrated(baseContent)) {
    throw new Error("Base .env is already migrated (FRESHBOOKS_MIGRATED marker present).");
  }

  const config = parseProfileConfig(baseContent);
  if (!config) {
    throw new Error("Base .env has no complete token set to migrate.");
  }

  // (U10) Resumability: a prior run may have written the profile and then died before
  // stripping base .env. If the profile already exists AND holds the SAME token set,
  // treat the profile-write step as done and fall through to (re)strip+mark. If it
  // exists but differs, refuse — clobbering it could destroy a distinct login's tokens.
  if (existsSync(profilePath)) {
    const existing = parseProfileConfig(readFileSync(profilePath, "utf8"));
    const sameTokens =
      existing?.accessToken === config.accessToken && existing?.refreshToken === config.refreshToken;
    if (!sameTokens) {
      throw new Error(
        `profiles/${name}.env already exists with a DIFFERENT token set — refusing to overwrite. ` +
          `Manual recovery: inspect profiles/${name}.env and base .env; if the profile is the one to keep, ` +
          `remove the tokens from base .env (or add ${MIGRATED_MARKER}=1) by hand; otherwise rename/remove ` +
          `the profile and re-run.`,
      );
    }
    // else: resume — the profile write is already done and verified-equal.
  } else {
    // 1) write + verify the profile file FIRST (writeNewProfile refuses to overwrite
    //    and hard-refuses a duplicate refresh token across existing profiles).
    writeNewProfile(profilesDir, name, config);
  }

  // 2) only now strip + mark base .env atomically.
  writeAtomic(baseEnv, stripTokensFromBaseEnv(baseContent));

  // (U4) Shred the token-bearing pre-strip backup now that the profile is verified and
  // the strip has landed, plus any leftover staged temp files. `force` so absence is fine.
  rmSync(`${baseEnv}.bak`, { force: true });
  rmSync(`${baseEnv}.tmp`, { force: true });
  rmSync(`${profilePath}.tmp`, { force: true });

  return { profilePath };
}

/**
 * Atomically create `profiles/<name>.env`, REFUSING to clobber another login's tokens.
 *
 * Guards (in order):
 *   - (R2) hard-refuse if any OTHER existing `profiles/*.env` already carries the same
 *     refresh token — two files sharing one refresh token guarantee a double-rotation
 *     lockout. A duplicate accountId with a DISTINCT token is a loud warning, not a
 *     refusal (two separate logins can legitimately share one company).
 *   - name/case collision: on a case-insensitive filesystem (macOS APFS) `existsSync`
 *     catches an "Acme" vs "acme" collision before it can overwrite a login's tokens.
 *
 * Shared by `runMigration` AND the setup add-login loop (Task 10) so neither path can
 * silently destroy another login's refresh token. Verifies the write by re-reading.
 *
 * Every refusal throws a `ProfileWriteError` whose `code` names the guard; the message
 * text is unchanged from the untyped throws. `opts.onSameAccount` selects what the
 * duplicate-accountId condition does: the default `"warn"` is today's behavior (warn,
 * then write); `"refuse"` throws `SAME_ACCOUNT` BEFORE anything is written, for callers
 * that must first get a human to confirm this really is a different person's login.
 * Marking the resulting group as distinct logins is the caller's job (`markDistinctLogin`).
 */
export function writeNewProfile(
  profilesDir: string,
  rawName: string,
  config: ProfileConfig,
  opts?: { onSameAccount?: "warn" | "refuse" },
): string {
  const name = normalizeProfileName(rawName);
  const profilePath = join(profilesDir, `${name}.env`);

  // (R2) Scan existing profiles for a duplicate refresh token (hard-refuse) or a
  // duplicate accountId with a different token (warn only). Skip the same-name file —
  // that case is the name/case collision handled below.
  if (existsSync(profilesDir)) {
    for (const file of readdirSync(profilesDir)) {
      if (!file.endsWith(".env") || file === `${name}.env`) continue;
      const other = parseProfileConfig(readFileSync(join(profilesDir, file), "utf8"));
      if (!other) continue;
      if (other.refreshToken === config.refreshToken) {
        throw new ProfileWriteError(
          "DUPLICATE_TOKEN",
          `Refresh token already present in profiles/${file} — refusing to write profiles/${name}.env. ` +
            `Two profile files sharing one refresh token guarantee a double-rotation lockout.`,
        );
      }
      if (config.accountId && other.accountId === config.accountId) {
        if (opts?.onSameAccount === "refuse") {
          // Refuse BEFORE any write: the caller wants a human to confirm this is a
          // different person's login for the same company first.
          throw new ProfileWriteError(
            "SAME_ACCOUNT",
            `profiles/${file} already uses accountId ${config.accountId} — refusing to write ` +
              `profiles/${name}.env without confirmation that this is a DISTINCT login.`,
          );
        }
        console.warn(
          `Warning: profiles/${file} already uses accountId ${config.accountId}. ` +
            `Writing profiles/${name}.env as a DISTINCT login that shares that company.`,
        );
      }
    }
  }

  if (existsSync(profilePath)) {
    throw new ProfileWriteError(
      "NAME_TAKEN",
      `profiles/${name}.env already exists — refusing to overwrite. Choose a different name.`,
    );
  }

  mkdirSync(profilesDir, { recursive: true });
  if (!existsSync(profilesDir)) throw new Error(`Failed to create ${profilesDir}.`);

  writeAtomic(profilePath, buildProfileFileContent(config));

  // Post-write verification: re-read the markers and confirm the tokens landed.
  const check = readTokenMarkers(profilePath);
  if (check.access !== config.accessToken || check.refresh !== config.refreshToken) {
    throw new Error(`profiles/${name}.env failed post-write verification.`);
  }
  return profilePath;
}
