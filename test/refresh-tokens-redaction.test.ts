import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock ONLY the network rotation (same pattern as refresh-tokens-args.test.ts):
// `inspectTokenHealth` stays real so `health` is derived from the real fixture
// tokens, and the suite is 100% network-free.
vi.mock("../src/freshbooks-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/freshbooks-client")>();
  return { ...actual, refreshTokensNow: vi.fn(async () => {}) };
});

import { run } from "../scripts/refresh-tokens";
import { refreshTokensNow, inspectTokenHealth } from "../src/freshbooks-client";
import { resetRegistry, getRegistry } from "../src/profiles";

// ---------------------------------------------------------------------------
// Credential-redaction regression test.
//
// `npm run check-tokens -- --json` and `npm run refresh-tokens -- --json` used
// to serialize the full TokenHealth struct — which carried the FULL access and
// refresh tokens — straight to stdout, handing both live credentials to any
// agent or script whose transcript captured the output. The human-readable
// mode also printed a token *suffix* (still a credential fragment). The fix
// removed token strings from TokenHealth entirely (presence booleans only).
//
// This suite drives every CLI output path (check-only and refresh, JSON and
// human, success and failure) over fixture profiles whose tokens are
// realistic three-segment base64url JWTs stuffed with distinctive canaries,
// then asserts NO fragment of either token appears anywhere on stdout or
// stderr — so a future field added to TokenHealth (or a stray console.log)
// that reintroduces token material fails loudly here.
// ---------------------------------------------------------------------------

/** A realistic 3-segment base64url JWT with a distinctive canary in payload and signature. */
function canaryJwt(expSecondsFromNow: number, canary: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT" });
  const payload = enc({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    leak_canary: `DO-NOT-PRINT-${canary}`,
  });
  const signature = Buffer.from(`SIGNATURE-CANARY-${canary}-NEVER-EMIT`).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Assert `output` contains no contiguous fragment of `token`. Checked with a
 * sliding 8-char window over the whole token (segments AND dots), so even a
 * partial leak — a suffix, a prefix, one JWT segment — trips the assertion.
 */
function expectNoTokenMaterial(output: string, token: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= token.length; i += 1) {
    expect(output).not.toContain(token.slice(i, i + WINDOW));
  }
}

describe("refresh-tokens CLI never emits token material", () => {
  let savedDir: string | undefined;
  let savedBase: string | undefined;

  // Fixture tokens — regenerated per test so `exp` stays relative to "now".
  let healthyAccess: string;
  let healthyRefresh: string;
  let staleAccess: string;
  let staleRefresh: string;
  let allTokens: string[];

  let logs: string[];
  let errs: string[];

  /** Everything the CLI wrote, both streams — the surface an agent transcript sees. */
  const allOutput = () => [...logs, ...errs].join("\n");

  const expectCleanOutput = () => {
    const combined = allOutput();
    for (const token of allTokens) expectNoTokenMaterial(combined, token);
  };

  beforeEach(() => {
    savedDir = process.env.FRESHBOOKS_PROFILES_DIR;
    savedBase = process.env.FRESHBOOKS_BASE_ENV;
    process.env.FRESHBOOKS_CLIENT_ID = "cid";

    healthyAccess = canaryJwt(3600, "ACCESS-HEALTHY-7f3a9c1e");
    healthyRefresh = canaryJwt(86_400, "REFRESH-HEALTHY-2b8d4f6a");
    staleAccess = canaryJwt(-60, "ACCESS-STALE-9e5c7a3b");
    staleRefresh = canaryJwt(86_400, "REFRESH-STALE-4d2f8b6c");
    allTokens = [healthyAccess, healthyRefresh, staleAccess, staleRefresh];

    const root = mkdtempSync(join(tmpdir(), "fb-redact-"));
    const dir = join(root, "profiles");
    mkdirSync(dir);
    // Distinct accountIds → neither profile is quarantined.
    writeFileSync(
      join(dir, "healthy.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${healthyAccess}\nFRESHBOOKS_REFRESH_TOKEN=${healthyRefresh}\nFRESHBOOKS_ACCOUNT_ID=ACC1\nFRESHBOOKS_BUSINESS_ID=1\n`,
    );
    writeFileSync(
      join(dir, "stale.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${staleAccess}\nFRESHBOOKS_REFRESH_TOKEN=${staleRefresh}\nFRESHBOOKS_ACCOUNT_ID=ACC2\nFRESHBOOKS_BUSINESS_ID=2\n`,
    );
    process.env.FRESHBOOKS_PROFILES_DIR = dir;
    process.env.FRESHBOOKS_BASE_ENV = join(root, ".env"); // nonexistent → no legacy fallback

    resetRegistry();
    vi.mocked(refreshTokensNow).mockClear();
    vi.mocked(refreshTokensNow).mockImplementation(async () => {});

    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.FRESHBOOKS_PROFILES_DIR;
    else process.env.FRESHBOOKS_PROFILES_DIR = savedDir;
    if (savedBase === undefined) delete process.env.FRESHBOOKS_BASE_ENV;
    else process.env.FRESHBOOKS_BASE_ENV = savedBase;
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("sanity: the fragment assertion DOES catch a raw token in output", () => {
    // Guards the guard: if expectNoTokenMaterial were broken, every test below
    // would pass vacuously.
    expect(() => expectNoTokenMaterial(`prefix ${staleAccess} suffix`, staleAccess)).toThrow();
    expect(() =>
      expectNoTokenMaterial(`suffix only: ...${staleAccess.slice(-10)}`, staleAccess),
    ).toThrow();
  });

  it("--check-only (human mode) reports presence and expiry without token material", async () => {
    const code = await run(["--check-only"]);

    expect(code).toBe(1); // stale profile is unhealthy
    expectCleanOutput();
    const out = errs.join("\n");
    // Still useful: names both profiles, reports presence + expiry state.
    expect(out).toContain("[healthy]");
    expect(out).toContain("[stale]");
    expect(out).toContain("access=present refresh=present");
    expect(out).toMatch(/EXPIRED/);
  });

  it("--check-only --json emits parseable per-profile health with NO token strings", async () => {
    await run(["--check-only", "--json"]);

    expectCleanOutput();
    const rows = logs.map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Presence is booleans; the old string fields must be gone.
      expect(row.health.hasAccessToken).toBe(true);
      expect(row.health.hasRefreshToken).toBe(true);
      expect(row.health).not.toHaveProperty("access");
      expect(row.health).not.toHaveProperty("refresh");
      expect(typeof row.health.expirySeconds).toBe("number");
    }
  });

  it("refresh path --json (the `health: after` emission) carries no token material", async () => {
    const code = await run(["--json"]);

    expect(code).toBe(0);
    expect(refreshTokensNow).toHaveBeenCalledTimes(1); // only the stale profile
    expectCleanOutput();
    const rows = logs.map((l) => JSON.parse(l));
    const refreshed = rows.find((r) => r.profile === "stale");
    expect(refreshed?.status).toBe("refreshed");
    expect(refreshed?.health).not.toHaveProperty("access");
    expect(refreshed?.health).not.toHaveProperty("refresh");
  });

  it("refresh path (human mode) prints the post-refresh report without token material", async () => {
    const code = await run([]);

    expect(code).toBe(0);
    expectCleanOutput();
    expect(errs.join("\n")).toContain("[stale] refreshed");
  });

  it("refresh FAILURE paths (json and human) stay clean", async () => {
    vi.mocked(refreshTokensNow).mockRejectedValue(new Error("simulated rotation failure"));

    const jsonCode = await run(["--json"]);
    expect(jsonCode).toBe(1);
    const failed = logs.map((l) => JSON.parse(l)).find((r) => r.profile === "stale");
    expect(failed?.status).toBe("refresh_failed");

    const humanCode = await run([]);
    expect(humanCode).toBe(1);
    expect(errs.join("\n")).toContain("REFRESH FAILED");

    expectCleanOutput();
  });

  it("TokenHealth itself carries no token strings (the struct is the allowlist)", () => {
    const profile = getRegistry().profiles.get("stale");
    expect(profile).toBeDefined();
    const health = inspectTokenHealth(profile!);
    const serialized = JSON.stringify(health);
    for (const token of allTokens) expectNoTokenMaterial(serialized, token);
    expect(health.hasAccessToken).toBe(true);
    expect(health.hasRefreshToken).toBe(true);
  });
});
