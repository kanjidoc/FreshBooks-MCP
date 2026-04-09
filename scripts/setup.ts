/**
 * FreshBooks MCP — Interactive Setup Script
 *
 * Walks you through:
 * 1. Entering your FreshBooks Developer App credentials
 * 2. Completing the OAuth2 flow (opens browser, captures callback)
 * 3. Fetching your Account ID and Business ID
 * 4. Writing everything to .env
 * 5. Printing MCP config for Claude Desktop, Claude Code, and claude.ai/code
 *
 * Usage:
 *   npx ts-node scripts/setup.ts
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Client } from "@freshbooks/api";

const ENV_PATH = path.resolve(__dirname, "..", ".env");
const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

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

async function waitForOAuthCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: system-ui; text-align: center; padding: 60px;">
              <h1>&#10004; Authorization successful!</h1>
              <p>You can close this tab and return to the terminal.</p>
            </body></html>
          `);
          server.close();
          resolve(code);
        } else {
          const error = url.searchParams.get("error") || "No code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Error: ${error}</h1></body></html>`);
          server.close();
          reject(new Error(error));
        }
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`\n   Waiting for OAuth callback on http://localhost:${REDIRECT_PORT}/callback ...\n`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

function writeEnvFile(vars: Record<string, string>) {
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(ENV_PATH, lines + "\n");
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
  4. Set the Redirect URI to: ${REDIRECT_URI}
  5. Save and copy the Client ID and Client Secret

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

  let code: string;
  try {
    code = await waitForOAuthCallback();
  } catch (err: any) {
    console.error(`\n   Error: ${err.message}\n`);
    process.exit(1);
  }

  console.log("   Authorization code received. Exchanging for tokens...\n");

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

  writeEnvFile(envVars);
  console.log(`   .env file written to: ${ENV_PATH}\n`);

  console.log(`
STEP 5: Building the MCP server
---------------------------------
`);

  const { execSync } = require("child_process");
  try {
    execSync("npm run build", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
    console.log("\n   Build successful!\n");
  } catch {
    console.error("\n   Build failed. Run 'npm run build' manually to see errors.\n");
  }

  const projectDir = path.resolve(__dirname, "..");
  printMcpConfig(envVars, projectDir);

  console.log(`
DONE! Next steps:
  1. Copy the MCP config above into your Claude setup
  2. Restart Claude (Desktop) or reload settings (Claude Code)
  3. Try asking: "List my recent invoices"

`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
