/**
 * FreshBooks MCP — token refresh CLI
 *
 * Audits the OAuth token files and refreshes the access token if it is expired,
 * near expiry, or the files have drifted out of sync. Bundled with the repo so a
 * fresh clone has working token maintenance — no external skill or Python needed.
 *
 *   npm run refresh-tokens                 # refresh only if needed
 *   npm run refresh-tokens -- --check-only # report state, never refresh
 *   npm run refresh-tokens -- --json       # machine-readable output
 *   npm run refresh-tokens -- --buffer-minutes 30
 *
 * Exit codes: 0 healthy/refreshed · 1 refresh failed or unhealthy · 2 config error.
 */
import "dotenv/config";
import {
  inspectTokenHealth,
  refreshTokensNow,
  type TokenHealth,
} from "../src/freshbooks-client";

function parseArgs(argv: string[]): { checkOnly: boolean; json: boolean; bufferMinutes: number } {
  let checkOnly = false;
  let json = false;
  let bufferMinutes = 10;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--json") json = true;
    else if (arg === "--buffer-minutes") {
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
  return { checkOnly, json, bufferMinutes };
}

/** Human-readable report — written to stderr so --json keeps stdout clean. */
function printHealth(health: TokenHealth): void {
  console.error("FreshBooks MCP token files:");
  for (const file of health.files) {
    const tag = file.required ? "required" : "optional";
    if (!file.exists) {
      console.error(`  [${tag}] ${file.path} — absent`);
      continue;
    }
    if (file.error) {
      console.error(`  [${tag}] ${file.path} — ERROR: ${file.error}`);
      continue;
    }
    const access = file.access ? `...${file.access.slice(-10)}` : "(none)";
    const refresh = file.refresh ? `...${file.refresh.slice(-10)}` : "(none)";
    console.error(`  [${tag}] ${file.path} — access=${access} refresh=${refresh}`);
  }
  if (health.expirySeconds === null) {
    console.error("  expiry: unknown (opaque or missing token)");
  } else if (health.expired) {
    console.error(`  expiry: EXPIRED ${Math.round(-health.expirySeconds / 60)} min ago`);
  } else {
    console.error(`  expiry: valid for ${Math.round(health.expirySeconds / 60)} min`);
  }
  if (health.drift) console.error("  DRIFT: token files hold different values");
  for (const issue of health.issues) console.error(`  issue: ${issue}`);
}

async function main(): Promise<void> {
  const { checkOnly, json, bufferMinutes } = parseArgs(process.argv.slice(2));
  const bufferSeconds = bufferMinutes * 60;
  let health = inspectTokenHealth(bufferSeconds);
  const missingRequired = health.files.some((f) => f.required && !f.exists);

  if (checkOnly) {
    if (json) console.log(JSON.stringify(health, null, 2));
    else {
      printHealth(health);
      console.error(health.needsRefresh ? "\nNEEDS REFRESH" : "\nHEALTHY: no refresh needed");
    }
    process.exit(missingRequired ? 2 : health.needsRefresh ? 1 : 0);
  }

  if (missingRequired) {
    if (json) console.log(JSON.stringify({ status: "config_error", health }, null, 2));
    else {
      printHealth(health);
      console.error("\nCONFIG ERROR: .env not found. Run `npm run setup` first.");
    }
    process.exit(2);
  }

  if (!health.needsRefresh) {
    if (json) console.log(JSON.stringify({ status: "healthy", refreshed: false, health }, null, 2));
    else {
      printHealth(health);
      console.error("\nHEALTHY: token is current. No refresh needed.");
    }
    process.exit(0);
  }

  if (!json) console.error("Token needs refresh — refreshing now...");
  try {
    await refreshTokensNow();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ status: "refresh_failed", error: message }, null, 2));
    else {
      console.error(`\nREFRESH FAILED: ${message}`);
      console.error("If the refresh token was rejected, re-run `npm run setup` to re-authorize.");
    }
    process.exit(1);
  }

  health = inspectTokenHealth(bufferSeconds);
  if (json) console.log(JSON.stringify({ status: "refreshed", refreshed: true, health }, null, 2));
  else {
    printHealth(health);
    console.error(
      "\nHEALTHY: refresh succeeded. Restart the MCP server (reload your Claude app) so it picks up the new token.",
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("refresh-tokens failed:", err);
  process.exit(2);
});
