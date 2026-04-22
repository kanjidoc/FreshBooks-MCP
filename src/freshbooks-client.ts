import { Client } from "@freshbooks/api";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let fbClient: Client | null = null;

const REFRESH_BUFFER_SECONDS = 10 * 60;

const TOKEN_FILES = [
  join(__dirname, "..", ".env"),
  join(__dirname, "..", ".mcp.json"),
  join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
];

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

function persistTokens(accessToken: string, refreshToken: string): void {
  for (const file of TOKEN_FILES) {
    if (!existsSync(file)) continue;
    try {
      let content = readFileSync(file, "utf8");
      if (file.endsWith(".env")) {
        content = content
          .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$/m, `FRESHBOOKS_ACCESS_TOKEN=${accessToken}`)
          .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$/m, `FRESHBOOKS_REFRESH_TOKEN=${refreshToken}`);
      } else {
        content = content
          .replace(/"FRESHBOOKS_ACCESS_TOKEN":\s*"[^"]*"/, `"FRESHBOOKS_ACCESS_TOKEN": ${JSON.stringify(accessToken)}`)
          .replace(/"FRESHBOOKS_REFRESH_TOKEN":\s*"[^"]*"/, `"FRESHBOOKS_REFRESH_TOKEN": ${JSON.stringify(refreshToken)}`);
      }
      writeFileSync(file, content);
    } catch (err) {
      console.error(`[freshbooks] failed to persist tokens to ${file}:`, err);
    }
  }
  process.env.FRESHBOOKS_ACCESS_TOKEN = accessToken;
  process.env.FRESHBOOKS_REFRESH_TOKEN = refreshToken;
}

async function refreshAndPersist(client: Client): Promise<void> {
  const result = await client.refreshAccessToken();
  if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
  persistTokens(result.accessToken, result.refreshToken);
  client.accessToken = result.accessToken;
  client.refreshToken = result.refreshToken;
  console.error("[freshbooks] access token refreshed");
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
