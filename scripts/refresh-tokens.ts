/**
 * FreshBooks MCP — token refresh CLI (multi-profile)
 *
 * Iterates EVERY configured profile (`profiles/<name>.env`, or the legacy base
 * `.env` fallback) and audits / refreshes each one independently. Bundled with
 * the repo so a fresh clone has working token maintenance — no external skill or
 * Python needed.
 *
 *   npm run refresh-tokens                       # refresh every profile that needs it
 *   npm run refresh-tokens -- --check-only       # report state, never refresh
 *   npm run refresh-tokens -- --profile work     # restrict to one profile (case-insensitive)
 *   npm run refresh-tokens -- --json             # machine-readable, one object per profile
 *   npm run refresh-tokens -- --buffer-minutes 30
 *
 * Human-readable output goes to stderr; --json output to stdout, so --json stays
 * clean and parseable.
 *
 * Exit codes: 0 all healthy/refreshed · 1 a refresh failed or a profile is
 * unhealthy (--check-only) · 2 config error (no matching profiles / bad args).
 */
import "../src/load-env";
import { getRegistry, type ProfileState } from "../src/profiles";
import { inspectTokenHealth, refreshTokensNow, type TokenHealth } from "../src/freshbooks-client";

interface CliArgs {
  checkOnly: boolean;
  json: boolean;
  bufferMinutes: number;
  only?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let checkOnly = false;
  let json = false;
  let bufferMinutes = 10;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--json") json = true;
    else if (arg === "--profile") {
      const value = argv[(i += 1)];
      if (value === undefined || value.trim() === "") {
        console.error("--profile requires a profile name");
        process.exit(2);
      }
      only = value.trim();
    } else if (arg === "--buffer-minutes") {
      bufferMinutes = Number(argv[(i += 1)]);
      if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0) {
        console.error("--buffer-minutes requires a non-negative number");
        process.exit(2);
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { checkOnly, json, bufferMinutes, only };
}

/**
 * R2 — pure refresh skip decision. A quarantined profile is a same-`accountId`
 * collision whose on-disk refresh token may be a SUPERSEDED snapshot of another
 * login's token family. Rotating it triggers FreshBooks refresh-token-reuse
 * revocation, which revokes the WHOLE family (including the live sibling) →
 * permanent lockout. So a quarantined profile is NEVER auto-rotated — not in a
 * no-arg `npm run refresh-tokens` (bulk mode) AND not even when explicitly named
 * with `--profile`. The ONLY opt-in is the on-disk `# freshbooks-distinct-login`
 * marker, which un-quarantines the profile during discovery (so it never reaches
 * here quarantined). This matches `withAccount`, which also hard-refuses a
 * quarantined profile, and the startup `ensureFreshTokens()`, which skips them.
 *
 * Returns true when this profile must be SKIPPED for refresh in this run. `only`
 * (the `--profile` target, if any) is irrelevant to the decision — it is the
 * caller's job to distinguish an explicit-target refusal (exit 1) from a benign
 * bulk skip (exit 0).
 */
export function shouldSkipQuarantinedRefresh(
  profile: Pick<ProfileState, "quarantined">,
  _only: string | undefined,
): boolean {
  return Boolean(profile.quarantined);
}

/**
 * Human-readable report for one profile — written to stderr so --json keeps
 * stdout clean. Reports token PRESENCE only, never token material: this
 * output lands in agent transcripts and logs, and even a token suffix is a
 * credential fragment. (TokenHealth itself carries no token strings — see the
 * security invariant on the struct in src/freshbooks-client.ts.)
 */
function printHealth(health: TokenHealth): void {
  const access = health.hasAccessToken ? "present" : "(none)";
  const refresh = health.hasRefreshToken ? "present" : "(none)";
  console.error(`[${health.name}] ${health.filePath}`);
  console.error(`  access=${access} refresh=${refresh}`);
  if (health.expirySeconds === null) {
    console.error("  expiry: unknown (opaque or missing token)");
  } else if (health.expired) {
    console.error(`  expiry: EXPIRED ${Math.round(-health.expirySeconds / 60)} min ago`);
  } else {
    console.error(`  expiry: valid for ${Math.round(health.expirySeconds / 60)} min`);
  }
  for (const issue of health.issues) console.error(`  issue: ${issue}`);
}

/**
 * Core CLI logic. Returns the intended process exit code instead of calling
 * `process.exit` itself, so it can be driven from a test (network-free) that
 * inspects which profiles were refreshed. Exit codes: 0 healthy/refreshed ·
 * 1 a refresh failed or a profile is unhealthy (--check-only) · 2 config error.
 */
export async function run(argv: string[]): Promise<number> {
  const { checkOnly, json, bufferMinutes, only } = parseArgs(argv);
  const bufferSeconds = bufferMinutes * 60;

  const reg = getRegistry();
  let profiles: ProfileState[] = [...reg.profiles.values()];
  if (only) {
    const wanted = only.toLowerCase();
    profiles = profiles.filter((p) => p.name === wanted);
  }

  if (profiles.length === 0) {
    const message = only
      ? `No profile named "${only}".`
      : "No FreshBooks accounts configured. Run `npm run setup`.";
    if (json) console.log(JSON.stringify({ status: "config_error", error: message }));
    else console.error(message);
    return 2;
  }

  let anyUnhealthy = false;
  let anyFailed = false;
  let anyRefused = false; // an explicit --profile target was quarantined (exit 1)

  for (const profile of profiles) {
    const health = inspectTokenHealth(profile, bufferSeconds);
    const unhealthy = health.needsRefresh || health.issues.length > 0;
    // TokenHealth (src/freshbooks-client.ts) deliberately knows nothing about
    // quarantine — that is a registry concern — so the CLI surfaces it here.
    const quarantined = profile.quarantined ?? false;

    if (checkOnly) {
      if (json) console.log(JSON.stringify({ profile: profile.name, quarantined, health }));
      else {
        printHealth(health);
        if (quarantined)
          console.error(
            `  quarantined: yes — same-accountId collision; auto-refresh SKIPS this (R2), even with --profile. ` +
              `If it is a genuinely distinct login, add "# freshbooks-distinct-login" to ${profile.filePath} to opt in; otherwise remove the stale file.`,
          );
        console.error(unhealthy ? `[${profile.name}] NEEDS ATTENTION` : `[${profile.name}] healthy`);
      }
      anyUnhealthy ||= unhealthy;
      continue;
    }

    // R2: a quarantined profile is NEVER rotated (token-family lockout vector) —
    // not in bulk mode and NOT even with an explicit --profile. The only opt-in is
    // the on-disk `# freshbooks-distinct-login` marker, which un-quarantines the
    // profile in discovery (so a non-quarantined one never reaches here). An
    // explicit --profile target gets a non-zero exit so a script notices the
    // refusal; a benign bulk skip stays exit 0. Same warning either way.
    if (shouldSkipQuarantinedRefresh(profile, only)) {
      const explicit = Boolean(only); // operator named THIS profile via --profile
      if (explicit) anyRefused = true;
      const warning =
        `[${profile.name}] quarantined (shares account_id with another login); not refreshing. ` +
        `If it is a genuinely separate login, add "# freshbooks-distinct-login" to profiles/${profile.name}.env ` +
        `(which un-quarantines it), then retry.`;
      if (json)
        console.log(
          JSON.stringify({
            profile: profile.name,
            status: "skipped_quarantined",
            refreshed: false,
            quarantined: true,
            refused: explicit,
          }),
        );
      else console.error(warning);
      continue;
    }

    if (!unhealthy) {
      if (json)
        console.log(JSON.stringify({ profile: profile.name, status: "healthy", refreshed: false, quarantined }));
      else console.error(`[${profile.name}] healthy — no refresh needed`);
      continue;
    }

    // Per-profile try/catch: one profile's failure must not abort the others.
    if (!json) console.error(`[${profile.name}] needs refresh — refreshing now...`);
    try {
      await refreshTokensNow(profile);
      const after = inspectTokenHealth(profile, bufferSeconds);
      if (json) {
        console.log(
          JSON.stringify({ profile: profile.name, status: "refreshed", refreshed: true, quarantined, health: after }),
        );
      } else {
        printHealth(after);
        console.error(`[${profile.name}] refreshed`);
      }
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      if (json)
        console.log(JSON.stringify({ profile: profile.name, status: "refresh_failed", quarantined, error: message }));
      else {
        console.error(`[${profile.name}] REFRESH FAILED: ${message}`);
        console.error(
          `[${profile.name}] If the refresh token was rejected, re-run \`npm run setup\` to re-authorize.`,
        );
      }
    }
  }

  return checkOnly ? (anyUnhealthy ? 1 : 0) : anyFailed || anyRefused ? 1 : 0;
}

// Only run as a CLI when executed directly (ts-node). Under vitest the module is
// imported to unit-test parseArgs/run/shouldSkipQuarantinedRefresh, so run() must
// not call process.exit itself — the entry point below maps its code to an exit.
if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("refresh-tokens failed:", err);
      process.exit(2);
    });
}
