import { Client } from "@freshbooks/api";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  accessSync,
  copyFileSync,
  renameSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let fbClient: Client | null = null;

const REFRESH_BUFFER_SECONDS = 10 * 60;

const ENV_FILE = join(__dirname, "..", ".env");
const MCP_FILE = join(__dirname, "..", ".mcp.json");
const DESKTOP_FILE = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude_desktop_config.json",
);

const TOKEN_FILES: TokenFile[] = [
  { path: ENV_FILE, kind: "env" },
  { path: MCP_FILE, kind: "json" },
  { path: DESKTOP_FILE, kind: "json" },
];

const JSON_ENV_PATH = ["mcpServers", "freshbooks", "env"] as const;

type TokenFile = { path: string; kind: "env" | "json" };

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function getJsonEnvBlock(data: any): Record<string, string> {
  let cur = data;
  for (const key of JSON_ENV_PATH) {
    if (!cur || typeof cur !== "object" || !(key in cur)) {
      throw new Error(`missing path ${JSON_ENV_PATH.join(".")}`);
    }
    cur = cur[key];
  }
  if (typeof cur !== "object" || cur === null) {
    throw new Error(`path ${JSON_ENV_PATH.join(".")} is not an object`);
  }
  return cur as Record<string, string>;
}

function readTokensFromFile(file: TokenFile): { access?: string; refresh?: string } {
  const content = readFileSync(file.path, "utf8");
  if (file.kind === "env") {
    const access = content.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim();
    const refresh = content.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m)?.[1]?.trim();
    return { access, refresh };
  }
  const block = getJsonEnvBlock(JSON.parse(content));
  return { access: block.FRESHBOOKS_ACCESS_TOKEN, refresh: block.FRESHBOOKS_REFRESH_TOKEN };
}

/**
 * Verify every token file is reachable, writable, and contains both token markers.
 * Throws BEFORE any refresh API call so we never burn a refresh token when persistence
 * cannot complete. Encodes the rule: "no preflight, no rotation."
 */
function preflightTokenFiles(): void {
  const failures: string[] = [];
  for (const file of TOKEN_FILES) {
    if (!existsSync(file.path)) {
      failures.push(`${file.path}: does not exist`);
      continue;
    }
    try {
      accessSync(file.path, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      failures.push(`${file.path}: not readable/writable`);
      continue;
    }
    try {
      const { access, refresh } = readTokensFromFile(file);
      if (!access) failures.push(`${file.path}: missing FRESHBOOKS_ACCESS_TOKEN`);
      if (!refresh) failures.push(`${file.path}: missing FRESHBOOKS_REFRESH_TOKEN`);
    } catch (err: any) {
      failures.push(`${file.path}: parse error — ${err.message ?? err}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `[freshbooks] preflight failed — refusing to refresh (would burn refresh token):\n  ` +
        failures.join("\n  "),
    );
  }
}

function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function persistOne(file: TokenFile, accessToken: string, refreshToken: string): void {
  const original = readFileSync(file.path, "utf8");
  let next: string;
  if (file.kind === "env") {
    next = original
      .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$/m, `FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)
      .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$/m, `FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`);
    if (!next.includes(`FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)) {
      throw new Error(`replace failed for FRESHBOOKS_ACCESS_TOKEN in ${file.path}`);
    }
    if (!next.includes(`FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`)) {
      throw new Error(`replace failed for FRESHBOOKS_REFRESH_TOKEN in ${file.path}`);
    }
  } else {
    const data = JSON.parse(original);
    const block = getJsonEnvBlock(data);
    if (!("FRESHBOOKS_ACCESS_TOKEN" in block) || !("FRESHBOOKS_REFRESH_TOKEN" in block)) {
      throw new Error(`env block missing token keys in ${file.path}`);
    }
    block.FRESHBOOKS_ACCESS_TOKEN = accessToken;
    block.FRESHBOOKS_REFRESH_TOKEN = refreshToken;
    next = JSON.stringify(data, null, 2) + "\n";
  }
  writeAtomic(file.path, next);
  // Read-back verification.
  const after = readTokensFromFile(file);
  if (after.access !== accessToken || after.refresh !== refreshToken) {
    throw new Error(`post-write verification failed for ${file.path}`);
  }
}

function persistTokens(accessToken: string, refreshToken: string): void {
  const failures: { path: string; error: string }[] = [];
  for (const file of TOKEN_FILES) {
    try {
      persistOne(file, accessToken, refreshToken);
    } catch (err: any) {
      failures.push({ path: file.path, error: err?.message ?? String(err) });
    }
  }
  if (failures.length > 0) {
    // Loudly print the new tokens so they aren't lost — refresh has already rotated
    // the FreshBooks-side state, so silently swallowing this would force full OAuth recovery.
    console.error("[freshbooks] CRITICAL — refresh succeeded but persist failed for some files.");
    console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
    console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
    for (const f of failures) {
      console.error(`[freshbooks]   failed: ${f.path} (${f.error})`);
    }
    console.error("[freshbooks] Manually paste the tokens above into the failed files NOW.");
    throw new Error(
      `Token persist failed for ${failures.length}/${TOKEN_FILES.length} files; new tokens logged above.`,
    );
  }
  process.env.FRESHBOOKS_ACCESS_TOKEN = accessToken;
  process.env.FRESHBOOKS_REFRESH_TOKEN = refreshToken;
}

async function refreshAndPersist(client: Client): Promise<void> {
  preflightTokenFiles();
  const result = await client.refreshAccessToken();
  if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
  persistTokens(result.accessToken, result.refreshToken);
  client.accessToken = result.accessToken;
  client.refreshToken = result.refreshToken;
  console.error("[freshbooks] access token refreshed and persisted to all 3 files");
}

export async function ensureFreshToken(): Promise<void> {
  const client = getFreshBooksClient();
  const token = process.env.FRESHBOOKS_ACCESS_TOKEN;
  if (!token) return;
  const exp = decodeJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp === null || exp - now < REFRESH_BUFFER_SECONDS) {
    await refreshAndPersist(client);
  }
}

export async function withAutoRefresh<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status;
    if (status !== 401 && status !== "401") throw err;
    await refreshAndPersist(getFreshBooksClient());
    return await fn();
  }
}

export function getFreshBooksClient(): Client {
  if (!fbClient) {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    if (!clientId) {
      throw new Error("FRESHBOOKS_CLIENT_ID is not set");
    }

    fbClient = new Client(clientId, {
      accessToken: process.env.FRESHBOOKS_ACCESS_TOKEN,
      refreshToken: process.env.FRESHBOOKS_REFRESH_TOKEN,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
    });
  }
  return fbClient;
}

export function getAccountId(): string {
  const accountId = process.env.FRESHBOOKS_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("FRESHBOOKS_ACCOUNT_ID is not set");
  }
  return accountId;
}

export function getBusinessId(): number {
  const businessId = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!businessId) {
    throw new Error("FRESHBOOKS_BUSINESS_ID is not set");
  }
  return parseInt(businessId, 10);
}
