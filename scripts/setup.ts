/**
 * FreshBooks MCP — Interactive Setup Script
 *
 * Walks you through:
 * 1. Entering your FreshBooks Developer App credentials
 * 2. Completing the OAuth2 flow (browser-based, paste-the-URL)
 * 3. Fetching your Account ID and Business ID
 * 4. Writing everything to .env
 * 5. Building the server and installing it into Claude Desktop and/or Claude Code
 *
 * Usage:
 *   npx ts-node scripts/setup.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Client } from "@freshbooks/api";
import { resolveDesktopConfigPath } from "../src/config-paths";
import { buildClaudeServerConfig, buildClaudeCodeServerJson } from "../src/mcp-config";

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const MCP_JSON_PATH = path.resolve(__dirname, "..", ".mcp.json");
const CLAUDE_DESKTOP_CONFIG_PATH = resolveDesktopConfigPath();
const REDIRECT_URI = "https://localhost/callback";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string) {
  const { exec } = require("child_process");
  const platform = process.platform;
  if (platform === "darwin") exec(`open "${url}"`);
  else if (platform === "win32") exec(`start "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function extractCodeFromUrl(urlString: string): string | null {
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

function writeEnvFile(vars: Record<string, string>) {
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(ENV_PATH, lines + "\n");
}

function writeMcpJson(envVars: Record<string, string>, projectDir: string) {
  const config = {
    mcpServers: {
      freshbooks: buildClaudeServerConfig(envVars, projectDir),
    },
  };
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
}

function upsertClaudeDesktopConfig(envVars: Record<string, string>, projectDir: string): boolean {
  try {
    fs.mkdirSync(path.dirname(CLAUDE_DESKTOP_CONFIG_PATH), { recursive: true });
    let existing: any = {};
    if (fs.existsSync(CLAUDE_DESKTOP_CONFIG_PATH)) {
      try {
        existing = JSON.parse(fs.readFileSync(CLAUDE_DESKTOP_CONFIG_PATH, "utf8"));
      } catch {
        console.log(`   Warning: existing ${CLAUDE_DESKTOP_CONFIG_PATH} is not valid JSON. Skipping auto-merge.`);
        return false;
      }
    }
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers.freshbooks = buildClaudeServerConfig(envVars, projectDir);
    fs.writeFileSync(CLAUDE_DESKTOP_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
    return true;
  } catch (err: any) {
    console.log(`   Warning: could not write Claude Desktop config (${err.message}).`);
    return false;
  }
}

/** True if the `claude` CLI (Claude Code) is installed and on PATH. */
function isClaudeCliAvailable(): boolean {
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the server with Claude Code at user scope (available in every
 * project) via the `claude` CLI. Re-running setup is idempotent: any existing
 * entry is removed first. Returns whether registration succeeded.
 */
function installIntoClaudeCode(envVars: Record<string, string>, projectDir: string): boolean {
  const { execFileSync } = require("child_process");
  const serverJson = JSON.stringify(buildClaudeCodeServerJson(envVars, projectDir));
  try {
    try {
      execFileSync("claude", ["mcp", "remove", "freshbooks", "--scope", "user"], {
        stdio: "ignore",
      });
    } catch {
      // Not previously installed — nothing to remove.
    }
    execFileSync("claude", ["mcp", "add-json", "freshbooks", serverJson, "--scope", "user"], {
      stdio: "ignore",
    });
    return true;
  } catch (err: any) {
    console.log(`   Warning: could not register with Claude Code (${err.message}).`);
    return false;
  }
}

function printMcpConfig(envVars: Record<string, string>, projectDir: string) {
  const distPath = path.join(projectDir, "dist", "index.js");

  const envBlock = Object.entries(envVars)
    .map(([k, v]) => `        "${k}": "${v}"`)
    .join(",\n");

  console.log(`
${"=".repeat(70)}
   MCP SERVER CONFIGURATION
${"=".repeat(70)}

Copy the relevant config below into your Claude setup.


--- CLAUDE DESKTOP ---
File: ~/Library/Application Support/Claude/claude_desktop_config.json (Mac)
      %APPDATA%\\Claude\\claude_desktop_config.json (Windows)

{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["${distPath}"],
      "env": {
${envBlock}
      }
    }
  }
}


--- CLAUDE CODE ---
A project-scoped config file (.mcp.json) has already been written to this
project folder. Open this folder as your project in Claude Code and enable
the "freshbooks" server when prompted.

To make FreshBooks available in EVERY Claude Code project, install the
"claude" CLI and run:

  claude mcp add-json freshbooks '${JSON.stringify(buildClaudeCodeServerJson(envVars, projectDir))}' --scope user


${"=".repeat(70)}
`);
}

async function main() {
  console.log(`
${"=".repeat(70)}
   FreshBooks MCP Server — Setup
${"=".repeat(70)}

This script will walk you through connecting your FreshBooks account.

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

  const clientId = await ask("   Enter your Client ID: ");
  const clientSecret = await ask("   Enter your Client Secret: ");

  if (!clientId || !clientSecret) {
    console.error("\n   Error: Client ID and Client Secret are required.\n");
    process.exit(1);
  }

  console.log(`
STEP 2: Authorize with FreshBooks
-----------------------------------
  Opening your browser to authorize the app...
`);

  const fbClient = new Client(clientId, {
    clientSecret,
    redirectUri: REDIRECT_URI,
  });

  const authUrl = fbClient.getAuthRequestUrl();
  console.log(`   Authorization URL:\n   ${authUrl}\n`);

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

  let code: string | null = null;
  while (!code) {
    const input = await ask("   Paste the redirect URL (or just the code): ");
    code = extractCodeFromUrl(input);
    if (!code) {
      console.log("   Could not extract authorization code. Please try again.\n");
    }
  }

  console.log("\n   Authorization code received. Exchanging for tokens...\n");

  const tokens = await fbClient.getAccessToken(code);
  if (!tokens) {
    console.error("   Error: Failed to exchange code for tokens.\n");
    process.exit(1);
  }

  console.log("   Access token obtained!\n");

  console.log(`
STEP 3: Fetching your Account ID and Business ID
--------------------------------------------------
`);

  // Now create a client with the access token to call users.me()
  const authedClient = new Client(clientId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientSecret,
    redirectUri: REDIRECT_URI,
  });

  let accountId = "";
  let businessId = "";

  try {
    const meResponse = await authedClient.users.me();
    if (meResponse.ok && meResponse.data) {
      const user = meResponse.data as any;
      console.log(`   Logged in as: ${user.firstName ?? ""} ${user.lastName ?? ""} (${user.email ?? ""})\n`);

      // Extract account ID and business ID from business memberships
      if (user.businessMemberships && user.businessMemberships.length > 0) {
        const membership = user.businessMemberships[0];
        const business = membership.business;
        accountId = String(business?.accountId ?? membership?.accountId ?? "");
        businessId = String(business?.id ?? membership?.businessId ?? "");

        if (user.businessMemberships.length > 1) {
          console.log("   Multiple businesses found. Using the first one:");
        }
        console.log(`   Account ID:  ${accountId}`);
        console.log(`   Business ID: ${businessId}\n`);
      }
    }
  } catch (err: any) {
    console.log(`   Warning: Could not auto-detect IDs (${err.message}).`);
    console.log("   You can find them in FreshBooks Settings or via the API.\n");
  }

  if (!accountId) {
    accountId = await ask("   Enter your Account ID manually: ");
  }
  if (!businessId) {
    businessId = await ask("   Enter your Business ID manually: ");
  }

  console.log(`
STEP 4: Saving configuration
------------------------------
`);

  const envVars: Record<string, string> = {
    FRESHBOOKS_CLIENT_ID: clientId,
    FRESHBOOKS_CLIENT_SECRET: clientSecret,
    FRESHBOOKS_REDIRECT_URI: REDIRECT_URI,
    FRESHBOOKS_ACCESS_TOKEN: tokens.accessToken,
    FRESHBOOKS_REFRESH_TOKEN: tokens.refreshToken,
    FRESHBOOKS_ACCOUNT_ID: accountId,
    FRESHBOOKS_BUSINESS_ID: businessId,
  };

  const projectDir = path.resolve(__dirname, "..");

  writeEnvFile(envVars);
  console.log(`   .env file written to: ${ENV_PATH}`);

  writeMcpJson(envVars, projectDir);
  console.log(`   .mcp.json file written to: ${MCP_JSON_PATH}\n`);

  console.log(`
STEP 5: Building the MCP server
---------------------------------
`);

  const { execSync } = require("child_process");
  try {
    execSync("npm run build", { cwd: projectDir, stdio: "inherit" });
    console.log("\n   Build successful!\n");
  } catch {
    console.error("\n   Build failed. Run 'npm run build' manually to see errors.\n");
  }

  console.log(`
STEP 6: Connecting to Claude
------------------------------
`);

  const isYes = (answer: string): boolean => {
    const a = answer.trim().toLowerCase();
    return a === "" || a === "y" || a === "yes";
  };

  let desktopInstalled = false;
  if (isYes(await ask("   Add the server to Claude Desktop? [Y/n]: "))) {
    desktopInstalled = upsertClaudeDesktopConfig(envVars, projectDir);
    if (desktopInstalled) {
      console.log(`   Claude Desktop config updated: ${CLAUDE_DESKTOP_CONFIG_PATH}\n`);
    }
  }

  let codeInstalled = false;
  if (isClaudeCliAvailable()) {
    if (isYes(await ask("   Add the server to Claude Code, for all your projects? [Y/n]: "))) {
      codeInstalled = installIntoClaudeCode(envVars, projectDir);
      if (codeInstalled) {
        console.log(`   Claude Code: registered the "freshbooks" server at user scope.\n`);
      }
    }
  }

  if (!desktopInstalled && !codeInstalled) {
    console.log(`   No automatic install was done. Add the server by hand using the
   configuration below.\n`);
    printMcpConfig(envVars, projectDir);
  }

  console.log(`
DONE! Next steps:
  1. Fully quit and reopen Claude (Desktop: quit the app entirely; Code: start
     a new session) so it picks up the new MCP server.
  2. Try asking: "List my recent FreshBooks invoices"

Tokens auto-refresh on every server start, so you shouldn't have to run this
setup again unless the refresh token is revoked (e.g. the FreshBooks Developer
app is deleted).

The full walkthrough and troubleshooting are in SETUP.md.
`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
