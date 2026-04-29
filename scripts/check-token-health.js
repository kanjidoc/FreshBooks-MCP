#!/usr/bin/env node
/**
 * Token health check for the FreshBooks MCP.
 *
 * Verifies (no API call):
 *   - all 3 token files exist, are readable, contain the token markers
 *   - access tokens identical across files (no drift)
 *   - refresh tokens identical across files (no drift)
 *   - access token JWT not expired (reports remaining time)
 *
 * Exits 0 healthy, non-zero on drift or expiry. Run from cron/launchd.
 *
 *   node scripts/check-token-health.js
 *   npm run check-tokens
 */
const { readFileSync, existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const ENV_FILE = join(__dirname, "..", ".env");
const MCP_FILE = join(__dirname, "..", ".mcp.json");
const DESKTOP_FILE = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json",
);

function readEnv(path) {
  const c = readFileSync(path, "utf8");
  return {
    access: (c.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m) || [])[1]?.trim(),
    refresh: (c.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m) || [])[1]?.trim(),
  };
}

function readJson(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const block = data?.mcpServers?.freshbooks?.env || {};
  return { access: block.FRESHBOOKS_ACCESS_TOKEN, refresh: block.FRESHBOOKS_REFRESH_TOKEN };
}

function decodeExp(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

const sources = [
  { label: ".env", path: ENV_FILE, read: readEnv },
  { label: ".mcp.json", path: MCP_FILE, read: readJson },
  { label: "claude_desktop_config", path: DESKTOP_FILE, read: readJson },
];

const issues = [];
const tokens = [];

for (const s of sources) {
  if (!existsSync(s.path)) {
    issues.push(`${s.label} missing at ${s.path}`);
    tokens.push({});
    continue;
  }
  try {
    const t = s.read(s.path);
    if (!t.access) issues.push(`${s.label}: no access token`);
    if (!t.refresh) issues.push(`${s.label}: no refresh token`);
    tokens.push(t);
  } catch (e) {
    issues.push(`${s.label}: parse error — ${e.message}`);
    tokens.push({});
  }
}

const accessSet = new Set(tokens.map((t) => t.access).filter(Boolean));
const refreshSet = new Set(tokens.map((t) => t.refresh).filter(Boolean));
if (accessSet.size > 1) issues.push(`access token drift: ${accessSet.size} distinct values across files`);
if (refreshSet.size > 1) issues.push(`refresh token drift: ${refreshSet.size} distinct values across files`);

const access = tokens[0]?.access;
let expLine = "  expiry: (no access token)";
if (access) {
  const exp = decodeExp(access);
  if (exp === null) {
    expLine = "  expiry: (opaque token, cannot decode)";
  } else {
    const remaining = exp - Math.floor(Date.now() / 1000);
    if (remaining <= 0) {
      issues.push(`access token expired ${(-remaining / 3600).toFixed(1)}h ago`);
      expLine = `  expiry: EXPIRED ${(-remaining / 3600).toFixed(1)}h ago`;
    } else {
      expLine = `  expiry: valid for ${(remaining / 60).toFixed(1)} min`;
    }
  }
}

console.log("FreshBooks MCP token health:");
for (let i = 0; i < sources.length; i++) {
  const s = sources[i];
  const t = tokens[i];
  console.log(
    `  ${s.label.padEnd(24)} access=...${(t.access || "?").slice(-10)}  refresh=...${(t.refresh || "?").slice(-10)}`,
  );
}
console.log(expLine);

if (issues.length > 0) {
  console.error("\nUNHEALTHY:");
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}
console.log("\nHEALTHY: all 3 files in sync.");
