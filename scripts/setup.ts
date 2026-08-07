/**
 * FreshBooks MCP — Interactive Setup Script
 *
 * Walks you through:
 * 1. Entering your FreshBooks Developer App credentials
 * 2. (Legacy installs) Migrating an existing single-login `.env` into a named
 *    profile under `profiles/<name>.env`
 * 3. Completing the OAuth2 flow (browser-based, paste-the-URL) for one or more
 *    named logins
 * 4. Fetching each login's Account ID and Business ID (you pick which business
 *    when a login is a member of more than one)
 * 5. Writing per-login tokens to `profiles/<name>.env` and leaving base `.env`
 *    holding ONLY the shared app credentials (no tokens, no IDs)
 * 6. Building the server and installing it into Claude Desktop and/or Claude Code
 *
 * Token model: base `.env` holds only FRESHBOOKS_CLIENT_ID/SECRET/REDIRECT_URI
 * (plus FRESHBOOKS_MIGRATED=1 once a legacy `.env` has been migrated). Every
 * login's tokens live ONLY in `profiles/<name>.env`, written exclusively through
 * the collision-guarded `writeNewProfile`/`runMigration` — never by hand here.
 *
 * Usage:
 *   npx ts-node scripts/setup.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import type { Client } from "@freshbooks/api";
import { resolveDesktopConfigPath } from "../src/config-paths";
import { buildClaudeServerConfig, buildClaudeCodeServerJson } from "../src/mcp-config";
import { runMigration, isMigrated, MIGRATED_MARKER } from "../src/migrate";
import { normalizeProfileName, type ProfileConfig } from "../src/profiles";
import type { SetupCtx, SetupStep } from "../src/setup-flow";
import {
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  claudeMcpAddJson,
  discoverMemberships,
  exchangeCode,
  extractCodeFromUrl,
  installDesktop,
  isClaudeCliAvailable,
  saveProfile,
  writeCredentialFile,
} from "./setup-core";
import { runHeadless } from "./setup-headless";

const PROJECT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.resolve(PROJECT_DIR, ".env");
const PROFILES_DIR = path.resolve(PROJECT_DIR, "profiles");
const MCP_JSON_PATH = path.resolve(PROJECT_DIR, ".mcp.json");
const CLAUDE_DESKTOP_CONFIG_PATH = resolveDesktopConfigPath();
/**
 * The one OAuth redirect URI this project uses, everywhere: the wizard's
 * `Client`, the base `.env` it writes, the headless `--init`/`--auth-url`, and
 * the Book's `developer-app` instructions ("set the Redirect URI to exactly
 * …"). Exported so `scripts/setup-headless.ts` uses this definition rather
 * than a second copy that could drift.
 */
export const REDIRECT_URI = "https://localhost/callback";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Yes/no parse. `defaultYes` decides what a bare Enter (empty input) means. */
function isYes(answer: string, defaultYes = false): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

/**
 * The wizard's ONE prompt renderer. Pure — it produces the string `ask()` hands
 * to readline and nothing else, which is why it is unit-testable without any
 * I/O stub.
 *
 * Both yes/no renderings are drafted by the design spec (§Surface 1: "One
 * `prompt()` helper; both default renderings specified: `(y = yes, Enter = no)`
 * and `(Enter = yes, n = no)`") and must not be paraphrased — a prompt that
 * shows the wrong default silently inverts a consent. `def` names what a bare
 * Enter means, so it always agrees with the `isYes(answer, defaultYes)` call it
 * is paired with; `null` is a free-text prompt (no hint).
 *
 * The question text is emitted verbatim, leading indentation included — the
 * caller owns the wizard's house style, this function owns only the suffix.
 */
export function formatPrompt(question: string, def: "yes" | "no" | null): string {
  const hint =
    def === "yes" ? " (Enter = yes, n = no)" : def === "no" ? " (y = yes, Enter = no)" : "";
  return `${question}${hint}: `;
}

/**
 * The checklist's three markers (plan Task 17): a check mark for done, a
 * right-pointing triangle for where we are, a hollow circle for still to come.
 */
const CHECK_DONE = "✓";
const CHECK_CURRENT = "▶";
const CHECK_PENDING = "○";

/**
 * The append-only progress checklist — the wizard reprints this whole block at
 * each stage boundary rather than redrawing the cursor (spec §Decisions: "Plain
 * sequential text; append-only rendering").
 *
 * Pure, and deliberately so: it renders the `wizard`-surface steps of the Book
 * it is handed, `appliesIf`-filtered against `ctx` and `repeats`-expanded, and
 * it asks nothing of the filesystem. In particular it NEVER calls a step's
 * `check()` — completion arrives as `doneIds`, which the wizard computes once
 * from those same `check(ctx)` functions. That single-sourcing is the point:
 * the wizard must never re-implement a check the Book already carries, and two
 * evaluation sites would be two chances to disagree.
 *
 * - `doneIds` / `currentId` are step ids. `currentId` wins over `doneIds` when
 *   both match: on a re-run a step's check can already pass while the user is
 *   standing on it, and where-we-are is the more useful thing to show.
 * - `loginCount` is the login currently being worked on (1 while the first is
 *   in flight), not a total known up front — the wizard's add-login loop has no
 *   such total. So the per-login group is emitted `loginCount` times,
 *   annotated `(login N)` once there is more than one, and every group before
 *   the last renders as done: the wizard only moves the counter after finishing
 *   a login. 0 (no login started yet) renders one un-annotated pending group so
 *   the user can still see the work that is coming.
 * - Surface filtering happens here, so `renderChecklist(SETUP_FLOW, …)` is the
 *   natural call; handing in an already-wizard-filtered list is identical.
 * - Returns the block with no trailing newline — the caller owns the spacing.
 */
export function renderChecklist(
  steps: SetupStep[],
  ctx: SetupCtx,
  doneIds: string[],
  currentId: string,
  loginCount: number,
): string {
  const visible = steps.filter(
    (step) => step.surfaces.includes("wizard") && (step.appliesIf ? step.appliesIf(ctx) : true),
  );
  const done = new Set(doneIds);
  const markerFor = (id: string) =>
    id === currentId ? CHECK_CURRENT : done.has(id) ? CHECK_DONE : CHECK_PENDING;

  // A non-finite or sub-1 count still owes the user one pending group.
  const iterations = Math.max(1, Number.isFinite(loginCount) ? Math.floor(loginCount) : 1);

  const out: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].repeats !== "per-login") {
      out.push(`${markerFor(visible[i].id)} ${visible[i].title}`);
      continue;
    }
    // A maximal contiguous run of per-login steps is one login's worth of work,
    // so the RUN repeats — nickname/authorize/save-login of login 1, then of
    // login 2 — which is the order they actually happen in.
    let end = i;
    while (end + 1 < visible.length && visible[end + 1].repeats === "per-login") end++;
    const run = visible.slice(i, end + 1);
    for (let n = 1; n <= iterations; n++) {
      const suffix = iterations > 1 ? ` (login ${n})` : "";
      for (const step of run) {
        const marker = n < iterations ? CHECK_DONE : markerFor(step.id);
        out.push(`${marker} ${step.title}${suffix}`);
      }
    }
    i = end;
  }
  return out.join("\n");
}

function openBrowser(url: string) {
  const { execFile } = require("child_process");
  const platform = process.platform;
  // execFile spawns no shell — the URL is passed as a literal argument, so
  // there is no quoting or command-injection concern on any platform.
  if (platform === "darwin") execFile("open", [url]);
  // `start` is a cmd builtin, not an executable; the empty "" is its window
  // title argument — without it, cmd treats the URL itself as the title.
  else if (platform === "win32") execFile("cmd", ["/c", "start", "", url]);
  else execFile("xdg-open", [url]);
}

/**
 * Pure: the env-var object the wizard persists to base `.env`.
 *
 * (U11) base `.env` carries ONLY the shared app credentials — never the
 * per-login token/ID set (FRESHBOOKS_ACCESS_TOKEN/REFRESH_TOKEN/ACCOUNT_ID/
 * BUSINESS_ID). Those live exclusively in `profiles/<name>.env` via
 * `writeNewProfile`/`runMigration`. The FRESHBOOKS_MIGRATED marker is appended
 * only once a legacy `.env` has been migrated, so the decoupling is total.
 * Exported (and kept side-effect free) so the decoupling can be unit-tested.
 */
export function buildBaseEnvVars(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  migrated: boolean,
): Record<string, string> {
  const vars: Record<string, string> = {
    FRESHBOOKS_CLIENT_ID: clientId,
    FRESHBOOKS_CLIENT_SECRET: clientSecret,
    FRESHBOOKS_REDIRECT_URI: redirectUri,
  };
  if (migrated) vars[MIGRATED_MARKER] = "1";
  return vars;
}

/** Pure: serialize an env-var object to `.env` file content. */
export function serializeEnv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

function writeEnvFile(vars: Record<string, string>) {
  // The base `.env` carries the app secret, so it is written 0600 at creation
  // and an existing file is tightened BEFORE the new content lands — the shared
  // writer the headless `--init` uses, so the two cannot drift.
  writeCredentialFile(ENV_PATH, serializeEnv(vars));
}

function writeMcpJson(projectDir: string) {
  const config = {
    mcpServers: {
      freshbooks: buildClaudeServerConfig(projectDir),
    },
  };
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * The launcher-config writers live in `setup-core.ts` so the wizard and the
 * headless `--install` verb share one merge implementation (and one set of
 * foreign-entry guarantees). The wizard keeps its own wording for every
 * outcome — the core returns a `reason` token, never prose.
 */
const INSTALL_PATHS = {
  rootDir: PROJECT_DIR,
  desktopConfigPath: CLAUDE_DESKTOP_CONFIG_PATH,
  mcpJsonPath: MCP_JSON_PATH,
};

function upsertClaudeDesktopConfig(): boolean {
  const result = installDesktop(INSTALL_PATHS);
  if (result.ok) return true;
  console.log(
    result.reason === "invalid-json"
      ? `   Warning: existing ${CLAUDE_DESKTOP_CONFIG_PATH} is not valid JSON. Skipping auto-merge.`
      : `   Warning: could not write Claude Desktop config (${result.detail}).`,
  );
  return false;
}

/**
 * Register the server with Claude Code at user scope (available in every
 * project) via the `claude` CLI. Re-running setup is idempotent: any existing
 * entry is removed first. Returns whether registration succeeded.
 */
function installIntoClaudeCode(projectDir: string): boolean {
  try {
    claudeMcpAddJson(projectDir);
    return true;
  } catch (err: any) {
    console.log(`   Warning: could not register with Claude Code (${err.message}).`);
    return false;
  }
}

function printMcpConfig(projectDir: string) {
  const distPath = path.join(projectDir, "dist", "index.js");

  console.log(`
${"=".repeat(70)}
   MCP SERVER CONFIGURATION (manual)
${"=".repeat(70)}

The server reads the shared app credentials from .env and each login's tokens
from profiles/<name>.env — these config blocks only tell Claude how to launch
it, so they contain no secrets.


--- CLAUDE DESKTOP ---
File: ~/Library/Application Support/Claude/claude_desktop_config.json (Mac)
      %APPDATA%\\Claude\\claude_desktop_config.json (Windows)

{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["${distPath}"]
    }
  }
}


--- CLAUDE CODE ---
A project-scoped config file (.mcp.json) has already been written to this
project folder. Open this folder as your project in Claude Code and enable
the "freshbooks" server when prompted.

To make FreshBooks available in EVERY Claude Code project, install the
"claude" CLI and run:

  claude mcp add-json freshbooks '${JSON.stringify(buildClaudeCodeServerJson(projectDir))}' --scope user


${"=".repeat(70)}
`);
}

/**
 * (Legacy installs) If base `.env` still carries a single login's tokens and has
 * not yet been migrated, offer to move them into `profiles/<name>.env`.
 *
 * (R1) Migrating while a live FreshBooks MCP server holds the lock can burn the
 * only refresh token, so we INTERACTIVELY confirm no server is attached and pass
 * that answer through as `confirmNoServer` — the ONLY override of the live-lock
 * guard. If `runMigration` still refuses (a live lock with no confirmation), we
 * surface the error and stop rather than loop-forcing past the one safety.
 *
 * Returns true once base `.env` is (or already was) migrated.
 */
async function maybeMigrateLegacyEnv(existingBaseEnv: string): Promise<boolean> {
  if (isMigrated(existingBaseEnv)) return true;

  const baseHasTokens = /^FRESHBOOKS_REFRESH_TOKEN=.+/m.test(existingBaseEnv);
  if (!baseHasTokens) return false;

  console.log(`
Found an existing single-login .env to migrate into a named profile.
Before continuing, in this exact order:
  1) Fully quit Claude / stop ANY running FreshBooks MCP server
  2) Run \`npm run build\`
  3) Continue this setup to migrate

Migrating while a server is live can burn your only refresh token, so this is
gated on you confirming nothing is attached.
`);

  const stopped = isYes(
    await ask(
      formatPrompt(
        "   Have you fully stopped Claude / any running FreshBooks MCP server?",
        "no",
      ),
    ),
  );

  let name = "";
  while (!name) {
    try {
      name = normalizeProfileName(await ask("   Name for this existing login (e.g. 'acme'): "));
    } catch (err: any) {
      console.log(`   ${err.message}\n`);
    }
  }

  try {
    const { profilePath } = runMigration({
      name,
      rootDir: PROJECT_DIR,
      confirmNoServer: stopped,
    });
    console.log(`   Migrated existing tokens -> ${profilePath}\n`);
    return true;
  } catch (err: any) {
    // (R1) Surface and stop — do NOT loop-force past the live-server guard.
    console.error(`\n   Migration could not proceed: ${err.message}\n`);
    console.error(
      "   Stop the running server (fully quit Claude / any MCP process) and re-run\n" +
        "   `npm run setup`.\n",
    );
    process.exit(1);
  }
}

/** Prompt for a 1-based business choice and return the 0-based index. */
async function askBusinessChoice(count: number): Promise<number> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await ask(`   Enter the number of the business to use [1-${count}]: `);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
    console.log("   Please enter a valid number from the list.\n");
  }
}

/**
 * Resolve the accountId/businessId for a freshly authorized login.
 *
 * Fixes the old `businessMemberships[0]` limitation: when a login belongs to
 * more than one business, list them and let the user pick which one THIS profile
 * maps to. An accounting-only login may legitimately have a blank businessId
 * (U1) — that is accepted, not forced.
 */
async function discoverIds(
  authedClient: Client,
): Promise<{ accountId: string; businessId: string }> {
  let accountId = "";
  let businessId = "";

  try {
    const { user, list } = await discoverMemberships(authedClient);
    console.log(
      `   Logged in as: ${user.firstName ?? ""} ${user.lastName ?? ""} (${user.email ?? ""})\n`,
    );

    if (list.length > 0) {
      let chosen = list[0];

      if (list.length > 1) {
        console.log("   This login is a member of multiple businesses. Choose one for");
        console.log("   this profile:\n");
        list.forEach((m, i) => {
          console.log(
            `     ${i + 1}) ${m.label}  (accountId=${m.accountId}, businessId=${m.businessId})`,
          );
        });
        console.log("");
        chosen = list[await askBusinessChoice(list.length)];
      }

      accountId = chosen.accountId;
      businessId = chosen.businessId;
      console.log(`\n   Account ID:  ${accountId}`);
      console.log(`   Business ID: ${businessId || "(none — accounting-only)"}\n`);
    }
  } catch (err: any) {
    console.log(`   Warning: Could not auto-detect IDs (${err.message}).`);
    console.log("   You can find them in FreshBooks Settings or via the API.\n");
  }

  if (!accountId) {
    accountId = await ask("   Enter your Account ID manually: ");
  }
  if (!businessId) {
    businessId = await ask(
      "   Enter your Business ID manually (leave blank for accounting-only logins): ",
    );
  }

  return { accountId, businessId };
}

/**
 * Run one OAuth flow and persist the resulting login as `profiles/<name>.env`.
 *
 * The profile file is written ONLY through `saveProfile` — the setup-core
 * pass-through to the shared guarded `writeNewProfile`, which normalizes
 * the name and hard-refuses a duplicate refresh token or an existing profile
 * name (Amendments A6/A7/R2) — so a clashing name can never silently clobber
 * another login's tokens. On refusal we surface the message and re-prompt for a
 * different name (blank cancels, so a genuinely unresolvable clash can't loop
 * forever). Returns true if a login was saved.
 */
async function addLogin(clientId: string, clientSecret: string): Promise<boolean> {
  const fbClient = buildOAuthClient(clientId, clientSecret, REDIRECT_URI);

  const authUrl = buildAuthUrl(fbClient);
  console.log(`
   Opening your browser to authorize this login...
   Authorization URL:
   ${authUrl}
`);
  try {
    openBrowser(authUrl);
    console.log("   (Browser should open automatically. If not, copy the URL above.)\n");
  } catch {
    console.log("   Could not open browser automatically. Please visit the URL above.\n");
  }

  console.log(`   After you authorize, your browser will redirect to a page that
   won't load (this is expected). Copy the FULL URL from your
   browser's address bar and paste it below.

   It will look like: ${REDIRECT_URI}?code=abc123...
`);

  // One loop covers both a bad paste (no code) and a rejected/expired code, so
  // a single mistake re-prompts instead of aborting the whole wizard. A response
  // the SDK could not turn into tokens rejects too (`exchangeCode`), and its
  // reason lands inside the same message.
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  while (!tokens) {
    const input = await ask("   Paste the redirect URL (or just the code): ");
    const code = extractCodeFromUrl(input);
    if (!code) {
      console.log("   Could not find an authorization code in that. Please try again.\n");
      continue;
    }
    try {
      tokens = await exchangeCode(fbClient, code);
    } catch (err: any) {
      console.log(
        `   That authorization code was rejected (${err?.message ?? err}).\n` +
          "   It may have expired or been mistyped — paste a fresh redirect URL.\n",
      );
      tokens = null;
    }
  }

  console.log("\n   Access token obtained! Fetching your Account ID and Business ID...\n");

  const authedClient = buildTokenClient(
    clientId,
    clientSecret,
    REDIRECT_URI,
    tokens.accessToken,
    tokens.refreshToken,
  );

  const { accountId, businessId } = await discoverIds(authedClient);

  const config: ProfileConfig = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accountId,
    businessId,
  };

  // Persist via the SHARED guarded writer only — never writeAtomic/writeEnvFile.
  while (true) {
    const raw = await ask("   Name for this login (e.g. 'acme'), or blank to cancel: ");
    if (!raw) {
      console.log("   Skipped saving this login.\n");
      return false;
    }
    let name: string;
    try {
      name = normalizeProfileName(raw);
    } catch (err: any) {
      console.log(`   ${err.message}\n`);
      continue;
    }
    try {
      const profilePath = saveProfile(PROFILES_DIR, name, config);
      console.log(`   Saved login -> ${profilePath}\n`);
      return true;
    } catch (err: any) {
      // Duplicate refresh token or existing profile name (A6/A7/R2). Show it and
      // re-prompt for a different name; blank cancels.
      console.log(`   Could not save this login: ${err.message}`);
      console.log("   Choose a different name (or blank to cancel).\n");
    }
  }
}

async function main() {
  // The headless (agent) surface shares this entry point: `--headless <verb>`
  // hands the whole run to the verb dispatcher and the wizard never starts.
  // `process.exitCode` rather than `process.exit()` — the latter can truncate a
  // piped `--json` stdout before it flushes.
  if (process.argv.includes("--headless")) {
    process.exitCode = await runHeadless(process.argv.slice(2));
    return;
  }

  console.log(`
${"=".repeat(70)}
   FreshBooks MCP Server — Setup
${"=".repeat(70)}

This wizard connects one or more FreshBooks logins. Each login's tokens are
stored in its own profiles/<name>.env; the base .env keeps only your shared
app credentials.

STEP 1: Create a FreshBooks Developer App
------------------------------------------
  1. Log in to FreshBooks
  2. Go to: Settings > Developer Portal
     URL: https://my.freshbooks.com/#/developer
  3. Click "Create an App"
  4. Set Application Type to "Private App"
  5. Set the Redirect URI to: ${REDIRECT_URI}
  6. Save and copy the Client ID and Client Secret

`);

  const existingBaseEnv = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const existing = dotenv.parse(existingBaseEnv);

  // --- Migration phase (legacy single-login .env) ---
  const migrated = await maybeMigrateLegacyEnv(existingBaseEnv);

  // --- Shared app credentials (re-used for every login's OAuth + base .env) ---
  const defaultId = existing.FRESHBOOKS_CLIENT_ID ?? "";
  const defaultSecret = existing.FRESHBOOKS_CLIENT_SECRET ?? "";
  const clientId =
    (await ask(`   Enter your Client ID${defaultId ? " [Enter to keep existing]" : ""}: `)) ||
    defaultId;
  const clientSecret =
    (await ask(
      `   Enter your Client Secret${defaultSecret ? " [Enter to keep existing]" : ""}: `,
    )) || defaultSecret;

  if (!clientId || !clientSecret) {
    console.error("\n   Error: Client ID and Client Secret are required.\n");
    process.exit(1);
  }

  // --- Add-login loop ---
  console.log(`
STEP 2: Authorize your FreshBooks login(s)
-------------------------------------------
`);

  // A fresh install needs at least one login; right after a migration adding
  // another is optional (the migrated login is already a profile).
  // (H) Track whether >=1 login exists. A migration already produced a profile;
  // a fresh install must not finish with zero — we warn and re-offer add-login
  // rather than writing a base .env with no usable profile.
  let savedAny = migrated;
  let again = true;
  if (migrated) {
    again = isYes(await ask(formatPrompt("   Add another FreshBooks login now?", "no")));
  }
  while (again) {
    if (await addLogin(clientId, clientSecret)) savedAny = true;
    if (!savedAny) {
      console.log(
        "\n   No login has been saved yet — the server needs at least one to work.\n",
      );
      again = isYes(await ask(formatPrompt("   Add a login now?", "yes")), true);
    } else {
      again = isYes(await ask(formatPrompt("   Add another login?", "no")));
    }
  }

  if (!savedAny) {
    console.log(
      "\n   Warning: no FreshBooks login was configured. The server will start, but\n" +
        "   every tool reports no account until you re-run `npm run setup` and add one.\n",
    );
  }

  // --- Save base .env (app credentials only) + launcher config ---
  console.log(`
STEP 3: Saving configuration
------------------------------
`);

  writeEnvFile(buildBaseEnvVars(clientId, clientSecret, REDIRECT_URI, migrated));
  console.log(`   Base .env (app credentials only — no tokens) written to: ${ENV_PATH}`);

  writeMcpJson(PROJECT_DIR);
  console.log(`   .mcp.json file written to: ${MCP_JSON_PATH}\n`);

  console.log(`
STEP 4: Building the MCP server
---------------------------------
`);

  const { execSync } = require("child_process");
  try {
    execSync("npm run build", { cwd: PROJECT_DIR, stdio: "inherit" });
    console.log("\n   Build successful!\n");
  } catch {
    console.error("\n   Build failed. Run 'npm run build' manually to see errors.\n");
  }

  console.log(`
STEP 5: Connecting to Claude
------------------------------
`);

  let desktopInstalled = false;
  if (isYes(await ask(formatPrompt("   Add the server to Claude Desktop?", "yes")), true)) {
    desktopInstalled = upsertClaudeDesktopConfig();
    if (desktopInstalled) {
      console.log(`   Claude Desktop config updated: ${CLAUDE_DESKTOP_CONFIG_PATH}\n`);
    }
  }

  let codeInstalled = false;
  if (isClaudeCliAvailable()) {
    if (
      isYes(
        await ask(formatPrompt("   Add the server to Claude Code, for all your projects?", "yes")),
        true,
      )
    ) {
      codeInstalled = installIntoClaudeCode(PROJECT_DIR);
      if (codeInstalled) {
        console.log(`   Claude Code: registered the "freshbooks" server at user scope.\n`);
      }
    }
  }

  if (!desktopInstalled && !codeInstalled) {
    console.log(`   No automatic install was done. Add the server by hand using the
   configuration below.\n`);
    printMcpConfig(PROJECT_DIR);
  }

  console.log(`
DONE! Next steps:
  1. Fully quit and reopen Claude (Desktop: quit the app entirely; Code: start
     a new session) so it picks up the new MCP server.
  2. With more than one login, name the account in your request, e.g.
     "List recent invoices for acme". With a single login it is used by default.

Tokens auto-refresh on every server start and live in profiles/<name>.env, so
you shouldn't have to run this setup again unless a refresh token is revoked
(e.g. the FreshBooks Developer app is deleted). To add another login later,
just re-run \`npm run setup\`.

The full walkthrough and troubleshooting are in SETUP.md.
`);
}

// Only auto-run when invoked as a script (ts-node scripts/setup.ts), never when
// imported (the decoupling test imports buildBaseEnvVars/serializeEnv).
if (require.main === module) {
  main().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
