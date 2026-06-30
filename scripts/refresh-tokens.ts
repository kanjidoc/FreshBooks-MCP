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

/** Human-readable report for one profile — written to stderr so --json keeps stdout clean. */
function printHealth(health: TokenHealth): void {
  const access = health.access ? `...${health.access.slice(-10)}` : "(none)";
  const refresh = health.refresh ? `...${health.refresh.slice(-10)}` : "(none)";
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

async function main(): Promise<void> {
  const { checkOnly, json, bufferMinutes, only } = parseArgs(process.argv.slice(2));
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
    process.exit(2);
  }

  let anyUnhealthy = false;
  let anyFailed = false;

  for (const profile of profiles) {
    const health = inspectTokenHealth(profile, bufferSeconds);
    const unhealthy = health.needsRefresh || health.issues.length > 0;

    if (checkOnly) {
      if (json) console.log(JSON.stringify({ profile: profile.name, health }));
      else {
        printHealth(health);
        console.error(unhealthy ? `[${profile.name}] NEEDS ATTENTION` : `[${profile.name}] healthy`);
      }
      anyUnhealthy ||= unhealthy;
      continue;
    }

    if (!unhealthy) {
      if (json) console.log(JSON.stringify({ profile: profile.name, status: "healthy", refreshed: false }));
      else console.error(`[${profile.name}] healthy — no refresh needed`);
      continue;
    }

    // Per-profile try/catch: one profile's failure must not abort the others.
    if (!json) console.error(`[${profile.name}] needs refresh — refreshing now...`);
    try {
      await refreshTokensNow(profile);
      const after = inspectTokenHealth(profile, bufferSeconds);
      if (json) {
        console.log(JSON.stringify({ profile: profile.name, status: "refreshed", refreshed: true, health: after }));
      } else {
        printHealth(after);
        console.error(`[${profile.name}] refreshed`);
      }
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      if (json) console.log(JSON.stringify({ profile: profile.name, status: "refresh_failed", error: message }));
      else {
        console.error(`[${profile.name}] REFRESH FAILED: ${message}`);
        console.error(
          `[${profile.name}] If the refresh token was rejected, re-run \`npm run setup\` to re-authorize.`,
        );
      }
    }
  }

  process.exit(checkOnly ? (anyUnhealthy ? 1 : 0) : anyFailed ? 1 : 0);
}

// Only run as a CLI when executed directly (ts-node). Under vitest the module is
// imported to unit-test parseArgs, and main() (which calls process.exit) must not fire.
if (require.main === module) {
  main().catch((err) => {
    console.error("refresh-tokens failed:", err);
    process.exit(2);
  });
}
