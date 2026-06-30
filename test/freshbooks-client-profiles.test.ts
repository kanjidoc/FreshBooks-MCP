import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProfiles, runInProfile, getRegistry, resetRegistry } from "../src/profiles";
import {
  getAccountId,
  getBusinessId,
  getOrCreateClient,
  refreshIfNeeded,
  inspectTokenHealth,
  ensureFreshTokens,
} from "../src/freshbooks-client";

// ---------------------------------------------------------------------------
// Helpers — all token material is synthetic so the suite is 100% network-free.
// ---------------------------------------------------------------------------

/** A 3-part JWT whose `exp` is `expSecondsFromNow` from now (negative = past). */
function jwt(expSecondsFromNow: number): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const cfg = (a: string, acc: string, biz: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=at-${a}\nFRESHBOOKS_REFRESH_TOKEN=rt-${a}\nFRESHBOOKS_ACCOUNT_ID=${acc}\nFRESHBOOKS_BUSINESS_ID=${biz}\n`;

// ---------------------------------------------------------------------------
// Task 4: ALS-backed id getters + single per-profile Client
// ---------------------------------------------------------------------------

describe("ALS-backed id getters", () => {
  let acme: any, beta: any;
  beforeEach(() => {
    process.env.FRESHBOOKS_CLIENT_ID = "cid";
    const root = mkdtempSync(join(tmpdir(), "fb-cli-"));
    const dir = join(root, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "acme.env"), cfg("a", "ACC_A", "11"));
    writeFileSync(join(dir, "beta.env"), cfg("b", "ACC_B", "22"));
    const r = discoverProfiles(dir, join(root, ".env"));
    acme = r.profiles.get("acme");
    beta = r.profiles.get("beta");
  });

  it("returns each profile's account/business id under its context", async () => {
    const a = await runInProfile(acme, async () => [getAccountId(), getBusinessId()]);
    const b = await runInProfile(beta, async () => [getAccountId(), getBusinessId()]);
    expect(a).toEqual(["ACC_A", 11]);
    expect(b).toEqual(["ACC_B", 22]);
  });

  it("getOrCreateClient returns a stable single instance per profile", () => {
    const c1 = getOrCreateClient(acme);
    const c2 = getOrCreateClient(acme);
    expect(c1).toBe(c2);
    expect(getOrCreateClient(beta)).not.toBe(c1);
  });

  it("getAccountId/getBusinessId throw at call time when the id is blank", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-blank-"));
    const dir = join(root, "profiles");
    mkdirSync(dir);
    // Valid tokens, but blank account/business ids (the U1 accounting-only case).
    writeFileSync(
      join(dir, "blank.env"),
      "FRESHBOOKS_ACCESS_TOKEN=at-z\nFRESHBOOKS_REFRESH_TOKEN=rt-z\n",
    );
    const blank = discoverProfiles(dir, join(root, ".env")).profiles.get("blank");
    await runInProfile(blank!, async () => {
      expect(() => getAccountId()).toThrow();
      expect(() => getBusinessId()).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Task 5: per-profile refresh (no-op when current) + health
// ---------------------------------------------------------------------------

describe("refreshIfNeeded (no network when current)", () => {
  it("is a no-op for a token far from expiry", async () => {
    const profile: any = {
      name: "x",
      filePath: "/dev/null",
      config: { accessToken: jwt(3600), refreshToken: "r", accountId: "A", businessId: "1" },
      client: null,
      refreshInFlight: null,
    };
    const r = await refreshIfNeeded(profile);
    expect(r.refreshed).toBe(false);
    expect(r.reason).toContain("current");
  });
});

describe("inspectTokenHealth", () => {
  it("reports expiry from the profile's own config token", () => {
    const profile: any = {
      name: "x",
      filePath: "/dev/null",
      config: { accessToken: jwt(-10), refreshToken: "r", accountId: "A", businessId: "1" },
      client: null,
      refreshInFlight: null,
    };
    const h = inspectTokenHealth(profile);
    expect(h.name).toBe("x");
    expect(h.filePath).toBe("/dev/null");
    expect(h.expired).toBe(true);
    expect(h.needsRefresh).toBe(true);
  });

  it("reports healthy for a far-future token", () => {
    const profile: any = {
      name: "y",
      filePath: "/tmp/y.env",
      config: { accessToken: jwt(3600), refreshToken: "r", accountId: "A", businessId: "1" },
      client: null,
      refreshInFlight: null,
    };
    const h = inspectTokenHealth(profile);
    expect(h.expired).toBe(false);
    expect(h.needsRefresh).toBe(false);
    expect(h.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U3: cross-process refresh guard — adopt a fresher on-disk token, skip rotation
// ---------------------------------------------------------------------------

describe("U3 cross-process refresh guard", () => {
  it("adopts a fresher on-disk token and does NOT call the network rotation", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-u3-"));
    const filePath = join(root, "x.env");
    const diskAccess = jwt(3600); // another process already rotated to a FRESH token
    writeFileSync(
      filePath,
      `FRESHBOOKS_ACCESS_TOKEN=${diskAccess}\nFRESHBOOKS_REFRESH_TOKEN=rt-disk\nFRESHBOOKS_ACCOUNT_ID=A\nFRESHBOOKS_BUSINESS_ID=1\n`,
    );

    let rotateCalls = 0;
    const profile: any = {
      name: "x",
      filePath,
      // In-memory token is near expiry, so refreshIfNeeded decides a refresh is due.
      config: { accessToken: jwt(60), refreshToken: "rt-mem", accountId: "A", businessId: "1" },
      // Pre-seed the cached client with a spy so getOrCreateClient hands it back and
      // any network rotation is observable (it must NOT fire).
      client: {
        accessToken: jwt(60),
        refreshToken: "rt-mem",
        refreshAccessToken: async () => {
          rotateCalls++;
          return { accessToken: "should-not-be-used", refreshToken: "should-not-be-used" };
        },
      },
      refreshInFlight: null,
    };

    const r = await refreshIfNeeded(profile);

    expect(rotateCalls).toBe(0); // network rotation skipped
    expect(profile.config.accessToken).toBe(diskAccess); // adopted on-disk token
    expect(profile.config.refreshToken).toBe("rt-disk");
    expect(profile.client.accessToken).toBe(diskAccess); // live client updated too
    expect(profile.client.refreshToken).toBe("rt-disk");
    expect(r.refreshed).toBe(true);
  });

  it("does NOT adopt when the on-disk token is itself stale (would rotate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-u3b-"));
    const filePath = join(root, "x.env");
    // On-disk token differs but is ALSO near expiry → not a fresh sibling rotation.
    writeFileSync(
      filePath,
      `FRESHBOOKS_ACCESS_TOKEN=${jwt(30)}\nFRESHBOOKS_REFRESH_TOKEN=rt-disk\nFRESHBOOKS_ACCOUNT_ID=A\nFRESHBOOKS_BUSINESS_ID=1\n`,
    );

    let rotateCalls = 0;
    const rotated = jwt(7200);
    const profile: any = {
      name: "x",
      filePath,
      config: { accessToken: jwt(60), refreshToken: "rt-mem", accountId: "A", businessId: "1" },
      client: {
        accessToken: jwt(60),
        refreshToken: "rt-mem",
        refreshAccessToken: async () => {
          rotateCalls++;
          return { accessToken: rotated, refreshToken: "rt-rotated" };
        },
      },
      refreshInFlight: null,
    };

    const r = await refreshIfNeeded(profile);

    expect(rotateCalls).toBe(1); // on-disk was stale → real rotation ran
    expect(profile.config.accessToken).toBe(rotated);
    expect(profile.config.refreshToken).toBe("rt-rotated");
    // And the rotated tokens were persisted to the profile file (A1/A10).
    expect(readFileSync(filePath, "utf8")).toContain(`FRESHBOOKS_ACCESS_TOKEN=${rotated}`);
    expect(readFileSync(filePath, "utf8")).toContain("FRESHBOOKS_REFRESH_TOKEN=rt-rotated");
    expect(r.refreshed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2: ensureFreshTokens skips quarantined profiles
// ---------------------------------------------------------------------------

describe("R2 ensureFreshTokens skips quarantined profiles", () => {
  let savedDir: string | undefined;
  let savedBase: string | undefined;

  beforeEach(() => {
    savedDir = process.env.FRESHBOOKS_PROFILES_DIR;
    savedBase = process.env.FRESHBOOKS_BASE_ENV;
    process.env.FRESHBOOKS_CLIENT_ID = "cid";
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.FRESHBOOKS_PROFILES_DIR;
    else process.env.FRESHBOOKS_PROFILES_DIR = savedDir;
    if (savedBase === undefined) delete process.env.FRESHBOOKS_BASE_ENV;
    else process.env.FRESHBOOKS_BASE_ENV = savedBase;
    resetRegistry();
  });

  it("never attempts to refresh a quarantined profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-r2-"));
    const dir = join(root, "profiles");
    mkdirSync(dir);
    // aaa claims ACC with a far-future token (refresh is a no-op).
    writeFileSync(
      join(dir, "aaa.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${jwt(3600)}\nFRESHBOOKS_REFRESH_TOKEN=rt-1\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=1\n`,
    );
    // bbb shares ACC with a DISTINCT refresh token and a near-expiry access token,
    // and carries NO opt-in marker → discovery quarantines it. If it were NOT
    // skipped, its near-expiry token would trigger a (spied) network rotation.
    writeFileSync(
      join(dir, "bbb.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${jwt(60)}\nFRESHBOOKS_REFRESH_TOKEN=rt-2\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=2\n`,
    );

    process.env.FRESHBOOKS_PROFILES_DIR = dir;
    process.env.FRESHBOOKS_BASE_ENV = join(root, ".env");
    resetRegistry();

    const bbb = getRegistry().profiles.get("bbb");
    expect(bbb).toBeDefined();
    expect(bbb!.quarantined).toBe(true); // precondition: bbb really is quarantined

    let rotateCalls = 0;
    bbb!.client = {
      accessToken: bbb!.config.accessToken,
      refreshToken: bbb!.config.refreshToken,
      refreshAccessToken: async () => {
        rotateCalls++;
        return { accessToken: "x", refreshToken: "y" };
      },
    } as any;

    await ensureFreshTokens();

    expect(rotateCalls).toBe(0); // quarantined profile never rotated
  });
});
