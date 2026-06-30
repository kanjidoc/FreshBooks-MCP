import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock ONLY the network rotation. `inspectTokenHealth` stays real (importOriginal)
// so health is derived from the real synthetic tokens and the suite is 100%
// network-free; `refreshTokensNow` becomes a spy so we can assert exactly which
// profiles a run would rotate.
vi.mock("../src/freshbooks-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/freshbooks-client")>();
  return { ...actual, refreshTokensNow: vi.fn(async () => {}) };
});

import { parseArgs, run, shouldSkipQuarantinedRefresh } from "../scripts/refresh-tokens";
import { refreshTokensNow } from "../src/freshbooks-client";
import { resetRegistry } from "../src/profiles";

/** A 3-part JWT whose `exp` is `expSecondsFromNow` from now (negative = past). */
function jwt(expSecondsFromNow: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

describe("refresh-tokens parseArgs", () => {
  it("defaults: no flags", () => {
    expect(parseArgs([])).toEqual({
      checkOnly: false,
      json: false,
      bufferMinutes: 10,
      only: undefined,
    });
  });

  it("parses --check-only and --json", () => {
    const args = parseArgs(["--check-only", "--json"]);
    expect(args.checkOnly).toBe(true);
    expect(args.json).toBe(true);
  });

  it("parses --profile <name> into `only`", () => {
    expect(parseArgs(["--profile", "work"]).only).toBe("work");
  });

  it("trims the --profile value", () => {
    expect(parseArgs(["--profile", "  work  "]).only).toBe("work");
  });

  it("parses --buffer-minutes", () => {
    expect(parseArgs(["--buffer-minutes", "30"]).bufferMinutes).toBe(30);
  });

  it("combines flags in any order", () => {
    const args = parseArgs(["--profile", "Home", "--check-only", "--buffer-minutes", "5"]);
    expect(args).toEqual({
      checkOnly: true,
      json: false,
      bufferMinutes: 5,
      only: "Home",
    });
  });
});

// ---------------------------------------------------------------------------
// R2 — pure bulk-refresh skip decision
// ---------------------------------------------------------------------------

describe("shouldSkipQuarantinedRefresh (R2 predicate)", () => {
  it("SKIPS a quarantined profile in bulk mode (no --profile target)", () => {
    expect(shouldSkipQuarantinedRefresh({ quarantined: true }, undefined)).toBe(true);
  });

  it("ALLOWS a quarantined profile when explicitly targeted with --profile", () => {
    expect(shouldSkipQuarantinedRefresh({ quarantined: true }, "bbb")).toBe(false);
  });

  it("never skips a non-quarantined profile", () => {
    expect(shouldSkipQuarantinedRefresh({ quarantined: false }, undefined)).toBe(false);
    expect(shouldSkipQuarantinedRefresh({}, undefined)).toBe(false); // quarantined undefined
  });
});

// ---------------------------------------------------------------------------
// R2 — bulk `npm run refresh-tokens` must NOT rotate a quarantined profile
// (token-family lockout vector), but --profile <quarantined> opts in.
// Real profile discovery over a temp dir; only the network rotation is spied.
// ---------------------------------------------------------------------------

describe("R2 refresh-tokens CLI skips quarantined profiles in bulk", () => {
  let savedDir: string | undefined;
  let savedBase: string | undefined;
  let dir: string;
  let root: string;

  beforeEach(() => {
    savedDir = process.env.FRESHBOOKS_PROFILES_DIR;
    savedBase = process.env.FRESHBOOKS_BASE_ENV;
    process.env.FRESHBOOKS_CLIENT_ID = "cid";

    root = mkdtempSync(join(tmpdir(), "fb-cli-r2-"));
    dir = join(root, "profiles");
    mkdirSync(dir);
    // Both NEED a refresh (near-expiry) and share accountId ACC with DISTINCT
    // refresh tokens and no opt-in marker → the second (bbb) is quarantined.
    writeFileSync(
      join(dir, "aaa.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${jwt(60)}\nFRESHBOOKS_REFRESH_TOKEN=rt-1\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=1\n`,
    );
    writeFileSync(
      join(dir, "bbb.env"),
      `FRESHBOOKS_ACCESS_TOKEN=${jwt(60)}\nFRESHBOOKS_REFRESH_TOKEN=rt-2\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=2\n`,
    );
    process.env.FRESHBOOKS_PROFILES_DIR = dir;
    process.env.FRESHBOOKS_BASE_ENV = join(root, ".env"); // nonexistent → no legacy fallback
    resetRegistry();
    vi.mocked(refreshTokensNow).mockClear();
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.FRESHBOOKS_PROFILES_DIR;
    else process.env.FRESHBOOKS_PROFILES_DIR = savedDir;
    if (savedBase === undefined) delete process.env.FRESHBOOKS_BASE_ENV;
    else process.env.FRESHBOOKS_BASE_ENV = savedBase;
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("(a) bulk mode refreshes the non-quarantined profile but NOT the quarantined one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await run([]); // no --profile → bulk mode

    // aaa rotated exactly once; bbb (quarantined) never rotated.
    expect(refreshTokensNow).toHaveBeenCalledTimes(1);
    expect(refreshTokensNow).toHaveBeenCalledWith(expect.objectContaining({ name: "aaa" }));
    expect(refreshTokensNow).not.toHaveBeenCalledWith(expect.objectContaining({ name: "bbb" }));
    expect(code).toBe(0); // a skip is benign, not a failure
  });

  it("(b) --profile <quarantined> opts in and DOES rotate it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await run(["--profile", "bbb"]);

    expect(refreshTokensNow).toHaveBeenCalledTimes(1);
    expect(refreshTokensNow).toHaveBeenCalledWith(expect.objectContaining({ name: "bbb" }));
    expect(code).toBe(0);
  });

  it("(c) --check-only --json surfaces `quarantined` per profile and never rotates", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      lines.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await run(["--check-only", "--json"]);

    expect(refreshTokensNow).not.toHaveBeenCalled(); // check-only never refreshes
    const byName = new Map(
      lines.map((l) => JSON.parse(l) as { profile: string; quarantined: boolean }).map((o) => [o.profile, o]),
    );
    expect(byName.get("bbb")?.quarantined).toBe(true);
    expect(byName.get("aaa")?.quarantined).toBe(false);
  });
});
