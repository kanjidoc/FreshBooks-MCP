import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../src/atomic-write";
import { decodeJwtIat, refreshIfNeeded } from "../src/freshbooks-client";
import { replaceProfileTokens } from "../scripts/setup-core";

/**
 * The rescue-file lifecycle (spec §Security hardening) and the 0600 credential
 * writes that go with it.
 *
 * SAFETY: every test runs against a throwaway temp directory and a hand-built
 * `ProfileState` whose `client` is a stub — the developer's real `.env`,
 * `profiles/` and the FreshBooks API are never touched. The only network-shaped
 * call in the whole file is `client.refreshAccessToken`, which is a local
 * function that counts its own invocations.
 *
 * TOKEN HYGIENE: every token here is a canary — a 3-segment JWT whose payload
 * carries a distinctive marker string — and the persist-failure tests sweep
 * stderr with a sliding window, so a partial echo fails as loudly as a whole
 * one. The ONE sanctioned exception in this project is the last-resort print
 * asserted in "the rescue write also fails" below.
 */

const roots: string[] = [];
let errs: string[];

/** Everything written to stderr during one test. */
const stderr = () => errs.join("\n");

/** A fresh temp directory, removed after the test. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fb-rescue-"));
  roots.push(dir);
  return dir;
}

/**
 * A 3-segment JWT with the given `exp`/`iat` offsets (seconds from now) and a
 * canary payload marker, so a leak of any fragment is attributable.
 */
function jwt(label: string, expOffset: number, iatOffset: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: "none" }),
    enc({ canary: `JWT-CANARY-${label}-7d3f9b2e`, exp: now + expOffset, iat: now + iatOffset }),
    "sig",
  ].join(".");
}

/** Assert `output` holds no contiguous 8-character fragment of `secret`. */
function expectNoTokenMaterial(output: string, secret: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + WINDOW));
  }
}

/** A profile file holding one token pair, plus the usual ids. */
function seedProfile(dir: string, access: string, refresh: string): string {
  const filePath = join(dir, "main.env");
  writeFileSync(
    filePath,
    `FRESHBOOKS_ACCESS_TOKEN=${access}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=${refresh}\n` +
      "FRESHBOOKS_ACCOUNT_ID=ACC\n" +
      "FRESHBOOKS_BUSINESS_ID=1\n",
  );
  return filePath;
}

/** A `.rescue` file next to `filePath`, in the two-line dotenv shape. */
function seedRescue(filePath: string, access: string, refresh: string): string {
  const path = `${filePath}.rescue`;
  writeFileSync(path, `FRESHBOOKS_ACCESS_TOKEN=${access}\nFRESHBOOKS_REFRESH_TOKEN=${refresh}\n`);
  return path;
}

const ROTATED_ACCESS = jwt("rotated", 7200, 0);
const ROTATED_REFRESH = "rt-rotated-CANARY-4c8e1b6a";

interface Stub {
  /** The hand-built `ProfileState` (typed loose — the real one wants a `Client`). */
  profile: any;
  /** `client.refreshToken` as it stood at each rotation call. */
  calls: string[];
  rotated: { accessToken: string; refreshToken: string };
}

/**
 * A profile whose cached client is a stub: the rotation is observable (and
 * records the refresh token it WOULD have sent, which is what test (i) turns
 * on — `refreshAccessToken()` takes no arguments).
 */
function stubProfile(filePath: string, access: string, refresh: string): Stub {
  const rotated = { accessToken: ROTATED_ACCESS, refreshToken: ROTATED_REFRESH };
  const calls: string[] = [];
  const client: any = {
    accessToken: access,
    refreshToken: refresh,
    refreshAccessToken: async () => {
      calls.push(client.refreshToken);
      return rotated;
    },
  };
  return {
    profile: {
      name: "main",
      filePath,
      config: { accessToken: access, refreshToken: refresh, accountId: "ACC", businessId: "1" },
      client,
      refreshInFlight: null,
    },
    calls,
    rotated,
  };
}

beforeEach(() => {
  errs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("decodeJwtIat", () => {
  it("extracts the numeric iat claim, and null for anything else", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(decodeJwtIat(`h.${enc({ iat: 1893456000 })}.s`)).toBe(1893456000);
    expect(decodeJwtIat(`h.${enc({ exp: 1893456000 })}.s`)).toBeNull();
    expect(decodeJwtIat("not-a-jwt")).toBeNull();
    expect(decodeJwtIat("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (a)/(b) persist failure — the rescue write, and the one sanctioned print
// ---------------------------------------------------------------------------

describe("persistTokens failure", () => {
  it("(a) writes the rescue pair and names ONLY its path on stderr", async () => {
    const dir = tmp();
    const oldAccess = jwt("old", 60, -3600);
    const filePath = seedProfile(dir, oldAccess, "rt-old");
    // A directory squatting at the staging name: `writeAtomic`'s tmp write
    // fails, while the rescue write — a different name — still succeeds.
    mkdirSync(`${filePath}.tmp`);
    const { profile, rotated } = stubProfile(filePath, oldAccess, "rt-old");

    await expect(refreshIfNeeded(profile)).rejects.toThrow(/Token persist/);

    const rescuePath = `${filePath}.rescue`;
    expect(existsSync(rescuePath)).toBe(true);
    const rescue = readFileSync(rescuePath, "utf8");
    expect(rescue).toContain(`FRESHBOOKS_ACCESS_TOKEN=${rotated.accessToken}`);
    expect(rescue).toContain(`FRESHBOOKS_REFRESH_TOKEN=${rotated.refreshToken}`);

    // The path is named; neither token is.
    expect(stderr()).toContain(rescuePath);
    expectNoTokenMaterial(stderr(), rotated.accessToken);
    expectNoTokenMaterial(stderr(), rotated.refreshToken);
    expect(stderr()).not.toContain("NEW ACCESS TOKEN");

    // A10 still holds: the in-memory copy follows the rotation either way.
    expect(profile.config.accessToken).toBe(rotated.accessToken);
    expect(profile.config.refreshToken).toBe(rotated.refreshToken);
  });

  it.skipIf(process.platform === "win32")("(a) writes the rescue file 0600", async () => {
    const dir = tmp();
    const oldAccess = jwt("old", 60, -3600);
    const filePath = seedProfile(dir, oldAccess, "rt-old");
    mkdirSync(`${filePath}.tmp`);
    const { profile } = stubProfile(filePath, oldAccess, "rt-old");

    await expect(refreshIfNeeded(profile)).rejects.toThrow(/Token persist/);

    expect(statSync(`${filePath}.rescue`).mode & 0o777).toBe(0o600);
  });

  it("(b) prints the tokens as a last resort when the rescue write ALSO fails", async () => {
    const dir = tmp();
    const oldAccess = jwt("old", 60, -3600);
    const filePath = seedProfile(dir, oldAccess, "rt-old");
    // Both names squatted: neither the profile write nor the rescue can land.
    mkdirSync(`${filePath}.tmp`);
    mkdirSync(`${filePath}.rescue`);
    const { profile, rotated } = stubProfile(filePath, oldAccess, "rt-old");

    await expect(refreshIfNeeded(profile)).rejects.toThrow(/Token persist/);

    // The SOLE sanctioned token print in this project (global constraints).
    expect(stderr()).toContain("NEW ACCESS TOKEN");
    expect(stderr()).toContain(rotated.accessToken);
    expect(stderr()).toContain(rotated.refreshToken);
    expect(stderr()).toContain("Paste the two tokens above");
  });

  it("(g) a verified profile write shreds a lingering rescue", async () => {
    const dir = tmp();
    const nearExpiry = jwt("near", 60, -3600);
    const filePath = seedProfile(dir, nearExpiry, "rt-old");
    // Undecodable rescue: adoption keeps it (fail closed), so the shred under
    // test is unambiguously the one on the persist SUCCESS path.
    const rescuePath = seedRescue(filePath, "opaque-not-a-jwt", "rt-rescue");
    const { profile, calls } = stubProfile(filePath, nearExpiry, "rt-old");

    await refreshIfNeeded(profile);

    expect(calls).toHaveLength(1); // a real rotation ran
    expect(readFileSync(filePath, "utf8")).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ROTATED_ACCESS}`);
    expect(existsSync(rescuePath)).toBe(false); // superseded by the verified write
  });
});

// ---------------------------------------------------------------------------
// (c)/(d)/(e)/(i) adoption
// ---------------------------------------------------------------------------

describe("rescue adoption", () => {
  it("(c) adopts a NEWER rescue pair into file + config + client, and skips rotation", async () => {
    const dir = tmp();
    const oldAccess = jwt("old", 60, -86400); // issued a day ago, near expiry
    const filePath = seedProfile(dir, oldAccess, "rt-old");
    const rescueAccess = jwt("rescue", 3600, 0); // issued now, still fresh
    const rescuePath = seedRescue(filePath, rescueAccess, "rt-rescue");
    const { profile, calls } = stubProfile(filePath, oldAccess, "rt-old");

    await refreshIfNeeded(profile);

    expect(calls).toHaveLength(0); // no rotation — the rescue pair is fresh
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain(`FRESHBOOKS_ACCESS_TOKEN=${rescueAccess}`);
    expect(content).toContain("FRESHBOOKS_REFRESH_TOKEN=rt-rescue");
    expect(content).toContain("FRESHBOOKS_ACCOUNT_ID=ACC"); // every other line preserved
    expect(profile.config.accessToken).toBe(rescueAccess);
    expect(profile.config.refreshToken).toBe("rt-rescue");
    expect(profile.client.accessToken).toBe(rescueAccess);
    expect(profile.client.refreshToken).toBe("rt-rescue");
    expect(existsSync(rescuePath)).toBe(false);
    expect(stderr()).toContain('adopted rescue pair for "main"; skipping refresh');
    expectNoTokenMaterial(stderr(), rescueAccess);
  });

  it("(d) shreds a SUPERSEDED rescue with a warning and rotates normally", async () => {
    const dir = tmp();
    const fileAccess = jwt("file", 60, -3600); // issued an hour ago
    const filePath = seedProfile(dir, fileAccess, "rt-old");
    const rescuePath = seedRescue(filePath, jwt("rescue", 3600, -7200), "rt-rescue"); // older iat
    const { profile, calls } = stubProfile(filePath, fileAccess, "rt-old");

    await refreshIfNeeded(profile);

    expect(existsSync(rescuePath)).toBe(false);
    expect(stderr()).toContain(rescuePath);
    expect(stderr()).toMatch(/superseded/i);
    expect(calls).toEqual(["rt-old"]); // rotation ran with the file's own pair
    expect(profile.config.accessToken).toBe(ROTATED_ACCESS);
    expect(profile.config.refreshToken).toBe(ROTATED_REFRESH);
  });

  it("(e) keeps an undecodable rescue, warns, and never adopts it", async () => {
    const dir = tmp();
    // The on-disk pair is FRESH and differs from the in-memory one, so the U3
    // cross-process guard returns before any rotation — isolating adoption.
    const diskAccess = jwt("disk", 3600, 0);
    const filePath = seedProfile(dir, diskAccess, "rt-disk");
    const rescuePath = seedRescue(filePath, "opaque-not-a-jwt", "rt-rescue");
    const { profile, calls } = stubProfile(filePath, jwt("mem", 60, -3600), "rt-mem");

    await refreshIfNeeded(profile);

    expect(existsSync(rescuePath)).toBe(true); // fail closed: kept for the doctor
    expect(readFileSync(rescuePath, "utf8")).toContain("FRESHBOOKS_ACCESS_TOKEN=opaque-not-a-jwt");
    expect(stderr()).toContain(rescuePath);
    expect(calls).toHaveLength(0);
    expect(profile.config.accessToken).toBe(diskAccess); // the U3 adopt, not the rescue
    expect(profile.config.refreshToken).toBe("rt-disk");
  });

  it("(i) rotates WITH the adopted refresh token when the adopted pair is stale", async () => {
    const dir = tmp();
    const fileAccess = jwt("file", -100, -172800); // expired, issued two days ago
    const filePath = seedProfile(dir, fileAccess, "rt-old");
    const rescueAccess = jwt("rescue", -50, -86400); // newer iat, but ALSO expired
    const rescuePath = seedRescue(filePath, rescueAccess, "rt-rescue");
    const { profile, calls } = stubProfile(filePath, fileAccess, "rt-old");

    await refreshIfNeeded(profile);

    // Adopted (newer iat) but not fresh → rotation proceeds, and it MUST carry
    // the adopted refresh token: rotating with the revoked one burns the family.
    expect(calls).toEqual(["rt-rescue"]);
    expect(existsSync(rescuePath)).toBe(false);
    expect(profile.config.accessToken).toBe(ROTATED_ACCESS);
    expect(profile.config.refreshToken).toBe(ROTATED_REFRESH);
    expect(readFileSync(filePath, "utf8")).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ROTATED_ACCESS}`);
  });
});

// ---------------------------------------------------------------------------
// (f) the precedence rule on the re-auth path
// ---------------------------------------------------------------------------

describe("replaceProfileTokens", () => {
  it("(f) shreds a lingering rescue as superseded", () => {
    const dir = tmp();
    const filePath = seedProfile(dir, jwt("old", 3600, 0), "rt-old");
    const rescuePath = seedRescue(filePath, jwt("rescue", 3600, 0), "rt-rescue");

    replaceProfileTokens(filePath, "at-reauth", "rt-reauth");

    expect(readFileSync(filePath, "utf8")).toContain("FRESHBOOKS_ACCESS_TOKEN=at-reauth");
    expect(existsSync(rescuePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (h) 0600 at creation
// ---------------------------------------------------------------------------

describe("writeAtomic permissions", () => {
  it.skipIf(process.platform === "win32")(
    "creates the target 0600 and tightens the .bak it leaves behind",
    () => {
      const dir = tmp();

      // A fresh file: the tmp's creation mode survives the rename.
      const fresh = join(dir, "fresh.env");
      writeAtomic(fresh, "a\n");
      expect(statSync(fresh).mode & 0o777).toBe(0o600);

      // An existing loose file: the backup copies its content AND its mode, so
      // the .bak is tightened explicitly.
      const existing = join(dir, "existing.env");
      writeFileSync(existing, "old\n");
      chmodSync(existing, 0o644);
      writeAtomic(existing, "new\n");
      expect(statSync(existing).mode & 0o777).toBe(0o600);
      expect(statSync(`${existing}.bak`).mode & 0o777).toBe(0o600);
    },
  );
});
