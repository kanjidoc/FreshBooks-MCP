/**
 * FreshBooks MCP — Interactive Setup Script
 *
 * Walks you through:
 * 1. Entering your FreshBooks Developer App credentials
 * 2. Completing the OAuth2 flow (browser-based, paste-the-URL)
 * 3. Fetching your Account ID and Business ID
 * 4. Writing everything to .env
 * 5. Printing MCP config for Claude Desktop, Claude Code, and claude.ai/code
 *
 * Usage:
 *   npx ts-node scripts/setup.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { Client } from "@freshbooks/api";

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const MCP_JSON_PATH = path.resolve(__dirname, "..", ".mcp.json");
const CLAUDE_DESKTOP_CONFIG_PATH =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
    ? path.join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
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

function buildFreshbooksServerConfig(envVars: Record<string, string>, projectDir: string) {
  return {
    command: "node",
    args: [path.join(projectDir, "dist", "index.js")],
    env: envVars,
  };
}

function writeMcpJson(envVars: Record<string, string>, projectDir: string) {
  const config = {
    mcpServers: {
      freshbooks: buildFreshbooksServerConfig(envVars, projectDir),
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
    existing.mcpServers.freshbooks = buildFreshbooksServerConfig(envVars, projectDir);
    fs.writeFileSync(CLAUDE_DESKTOP_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
    return true;
  } catch (err: any) {
    console.log(`   Warning: could not write Claude Desktop config (${err.message}).`);
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


--- CLAUDE CODE (CLI / IDE) ---
File: ~/.claude/settings.json  (global)
  or: <project>/.claude/settings.json  (per-project)

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


--- CLAUDE.AI/CODE (WEB) ---
Same as Claude Code — add to your project's .claude/settings.json
and push to the repo so the web environment picks it up.


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
STEP 6: Installing into Claude Desktop
----------------------------------------
`);

  const installAnswer = (
    await ask(`   Add the FreshBooks MCP server to Claude Desktop automatically? [Y/n]: `)
  ).toLowerCase();
  const installed =
    installAnswer === "" || installAnswer === "y" || installAnswer === "yes"
      ? upsertClaudeDesktopConfig(envVars, projectDir)
      : false;

  if (installed) {
    console.log(`   Claude Desktop config updated: ${CLAUDE_DESKTOP_CONFIG_PATH}\n`);
  } else {
    console.log(`   Skipped. You can copy the config block below manually instead.\n`);
    printMcpConfig(envVars, projectDir);
  }

  console.log(`
DONE! Next steps:
  1. Quit and reopen Claude Desktop so it picks up the new MCP server
  2. Try asking: "List my recent invoices"

Tokens will auto-refresh on every server start, so you shouldn't have to
re-run this setup again unless the refresh token is revoked (e.g. the app
is deleted from the FreshBooks Developer Portal).

`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
