import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../src/tool-registry";
import { listAccounts } from "../src/tools/accounts";
import { resetRegistry } from "../src/profiles";

describe("registry wiring", () => {
  it("registers exactly 76 tools", () => {
    expect(allTools.length).toBe(76);
  });
  it("includes freshbooks_list_accounts and it has no `account` field", () => {
    const la = allTools.find((t: any) => t.name === "freshbooks_list_accounts");
    expect(la).toBeTruthy();
    expect(Object.keys((la as any).inputSchema)).not.toContain("account");
  });
  it("every API tool except help/list_accounts carries an injected `account` field", () => {
    const free = new Set(["freshbooks_help", "freshbooks_list_accounts"]);
    for (const t of allTools as any[]) {
      if (free.has(t.name)) continue;
      expect(Object.keys(t.inputSchema)).toContain("account");
    }
  });
});

// --- R2: list_accounts surfaces collisions/broken/duplicates and marks quarantined ---

// Far-future JWT so refreshIfNeeded() is a no-op (no network) for any profile.
function jwt(): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({})}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
}
const cfg = (a: string, acc: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=${jwt()}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=rt-${a}\n` +
  `FRESHBOOKS_ACCOUNT_ID=${acc}\n` +
  `FRESHBOOKS_BUSINESS_ID=1\n`;

const created: string[] = [];

function useProfiles(files: Record<string, string>): void {
  const root = mkdtempSync(join(tmpdir(), "fb-acct-"));
  created.push(root);
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body);
  process.env.FRESHBOOKS_PROFILES_DIR = dir;
  process.env.FRESHBOOKS_BASE_ENV = join(root, ".env"); // absent -> zero profiles when empty
  resetRegistry();
}

describe("freshbooks_list_accounts (R2 collision surfacing, network-free)", () => {
  beforeEach(() => {
    // No FRESHBOOKS_CLIENT_ID: getOrCreateClient() throws before any users.me()
    // call, so the company lookup is skipped entirely and the test never hits the
    // network. Token health is still reported from the profile's own config.
    delete process.env.FRESHBOOKS_CLIENT_ID;
  });
  afterEach(() => {
    delete process.env.FRESHBOOKS_PROFILES_DIR;
    delete process.env.FRESHBOOKS_BASE_ENV;
    resetRegistry();
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("never throws and returns one entry per loaded profile with token health", async () => {
    useProfiles({ "acme.env": cfg("a", "A"), "beta.env": cfg("b", "B") });
    const res = await listAccounts.handler({}, {});
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text);
    expect(out.accounts.map((a: any) => a.account).sort()).toEqual(["acme", "beta"]);
    for (const acc of out.accounts) {
      expect(acc.token).toHaveProperty("expiry_seconds");
      expect(acc.token).toHaveProperty("needs_refresh");
      expect(acc.quarantined).toBe(false);
    }
  });

  it("marks a quarantined profile and surfaces the collision (same accountId, distinct token)", async () => {
    useProfiles({
      "acme.env": cfg("a", "SAME"),
      "copy.env": cfg("b", "SAME"), // distinct refresh token, same accountId -> quarantined
    });
    const res = await listAccounts.handler({}, {});
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text);

    const copy = out.accounts.find((a: any) => a.account === "copy");
    const acme = out.accounts.find((a: any) => a.account === "acme");
    expect(acme.quarantined).toBe(false);
    expect(copy.quarantined).toBe(true);

    // The collision is surfaced so the user can see WHY copy won't refresh.
    expect(Array.isArray(out.collisions)).toBe(true);
    const hit = out.collisions.find((c: any) => c.file === "copy.env");
    expect(hit).toBeTruthy();
    expect(hit.kind).toBe("same-account");
    expect(hit.collidesWith).toBe("acme.env");
  });

  it("surfaces broken/duplicate files in the output", async () => {
    useProfiles({
      "acme.env": cfg("a", "A"),
      "stub.env": "FRESHBOOKS_ACCESS_TOKEN=x\n", // missing refresh token -> broken
      "dupe.env": cfg("a", "A"), // identical refresh token rt-a -> same-token duplicate
    });
    const res = await listAccounts.handler({}, {});
    const out = JSON.parse(res.content[0].text);
    expect(out.broken).toContain("stub.env");
    expect(out.duplicates).toContain("dupe.env");
    expect(out.ignored_files).toEqual(expect.arrayContaining(["stub.env", "dupe.env"]));
  });
});
