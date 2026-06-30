import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeProfileName,
  parseProfileConfig,
  UnknownProfileError,
  discoverProfiles,
  getRegistry,
  resetRegistry,
  profileNames,
  profileCount,
  resolveProfile,
  defaultProfileName,
  runInProfile,
  currentProfile,
  currentProfileOrNull,
} from "../src/profiles";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// A profile env body. `a` seeds distinct access/refresh tokens; `acc` is the
// accountId; `biz` the businessId. `extra` lets a test prepend marker lines.
const cfg = (a: string, acc: string, biz = "1", extra = "") =>
  `${extra}FRESHBOOKS_ACCESS_TOKEN=at-${a}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=rt-${a}\n` +
  `FRESHBOOKS_ACCOUNT_ID=${acc}\n` +
  `FRESHBOOKS_BUSINESS_ID=${biz}\n`;

function makeDir(files: Record<string, string>): { dir: string; base: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "fb-prof-"));
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, base: join(root, ".env"), root };
}

// True when the volume distinguishes `x` from `X` (Linux CI). macOS/APFS is
// case-insensitive by default, so this returns false there.
function detectCaseSensitive(root: string): boolean {
  const probe = join(root, "fb-case-probe");
  writeFileSync(probe, "x");
  const sensitive = !existsSync(join(root, "FB-CASE-PROBE"));
  rmSync(probe, { force: true });
  return sensitive;
}

const created: string[] = [];
function tmpRoot(files: Record<string, string>) {
  const made = makeDir(files);
  created.push(made.root);
  return made;
}

afterEach(() => {
  // Tear down env overrides + memoized registry so blocks never leak into one
  // another (and never read the developer's real .env).
  delete process.env.FRESHBOOKS_PROFILES_DIR;
  delete process.env.FRESHBOOKS_BASE_ENV;
  resetRegistry();
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Task 1 — pure parsing / naming
// ---------------------------------------------------------------------------

describe("normalizeProfileName", () => {
  it("lowercases and accepts valid names", () => {
    expect(normalizeProfileName("Acme")).toBe("acme");
    expect(normalizeProfileName("client-2_b")).toBe("client-2_b");
  });
  it("rejects names with spaces or path chars", () => {
    expect(() => normalizeProfileName("acme copy")).toThrow();
    expect(() => normalizeProfileName("../etc")).toThrow();
    expect(() => normalizeProfileName("")).toThrow();
  });
});

describe("parseProfileConfig", () => {
  const good =
    "FRESHBOOKS_ACCESS_TOKEN=a\nFRESHBOOKS_REFRESH_TOKEN=r\nFRESHBOOKS_ACCOUNT_ID=acc\nFRESHBOOKS_BUSINESS_ID=42\n";
  it("parses a complete file", () => {
    expect(parseProfileConfig(good)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      accountId: "acc",
      businessId: "42",
    });
  });
  it("returns null when a TOKEN is missing (refresh absent)", () => {
    expect(parseProfileConfig("FRESHBOOKS_ACCESS_TOKEN=a\n")).toBeNull();
  });
  it("parses with blank account/business ids (accounting-only single-login — U1)", () => {
    expect(parseProfileConfig("FRESHBOOKS_ACCESS_TOKEN=a\nFRESHBOOKS_REFRESH_TOKEN=r\n")).toEqual({
      accessToken: "a",
      refreshToken: "r",
      accountId: "",
      businessId: "",
    });
  });
});

describe("UnknownProfileError", () => {
  it("lists available names", () => {
    const e = new UnknownProfileError("x", ["acme", "beta"]);
    expect(e.message).toContain("acme, beta");
  });
  it("guides setup when none configured", () => {
    expect(new UnknownProfileError("x", []).message).toContain("npm run setup");
  });
});

// ---------------------------------------------------------------------------
// Task 2 / R2 — discovery
// ---------------------------------------------------------------------------

describe("discoverProfiles", () => {
  it("loads valid profiles keyed by lowercased stem, no collisions", () => {
    const { dir, base } = tmpRoot({ "Acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    const r = discoverProfiles(dir, base);
    expect([...r.profiles.keys()].sort()).toEqual(["acme", "beta"]);
    expect(r.collisions).toEqual([]);
    expect(r.broken).toEqual([]);
    expect(r.duplicates).toEqual([]);
  });

  it("excludes malformed files as broken, never counting them", () => {
    const { dir, base } = tmpRoot({ "acme.env": cfg("a", "A1"), "stub.env": "FRESHBOOKS_ACCESS_TOKEN=x\n" });
    const r = discoverProfiles(dir, base);
    expect([...r.profiles.keys()]).toEqual(["acme"]);
    expect(r.broken).toContain("stub.env");
  });

  it("rejects files whose stem is not a valid profile name as broken", () => {
    const { dir, base } = tmpRoot({ "acme.env": cfg("a", "A1"), "_bad.env": cfg("c", "C1") });
    const r = discoverProfiles(dir, base);
    expect([...r.profiles.keys()]).toEqual(["acme"]);
    expect(r.broken).toContain("_bad.env");
  });

  // R2 (a): identical refresh token across two files => second is a duplicate,
  // recorded as a same-token collision, and never enters the registry.
  it("excludes an identical refresh token as a same-token collision", () => {
    const { dir, base } = tmpRoot({
      "acme.env": cfg("shared", "ACC1"),
      "copy.env": cfg("shared", "ACC2"), // same at-/rt- tokens, different account
    });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(1);
    expect([...r.profiles.keys()]).toEqual(["acme"]);
    expect(r.duplicates).toEqual(["copy.env"]);
    expect(r.collisions).toEqual([{ file: "copy.env", collidesWith: "acme.env", kind: "same-token" }]);
  });

  // R2 (b) / Item A: same accountId, DISTINCT tokens, NO opt-in marker on either
  // => FAIL CLOSED. Quarantine EVERY member of the group, not just the second:
  // if the alphabetically-first file were the STALE diverged copy, auto-rotating
  // it would burn the live sibling's token family. profiles.size stays 2
  // (account-required mode). One same-account collision entry per member.
  it("quarantines ALL members of a same-account group when none is marked (fail closed)", () => {
    const { dir, base } = tmpRoot({
      "acme.env": cfg("a", "SAME"),
      "copy.env": cfg("b", "SAME"), // distinct tokens, same account, neither marked
    });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(2);
    expect(r.duplicates).toEqual([]);
    expect(r.profiles.get("acme")!.quarantined).toBe(true);
    expect(r.profiles.get("copy")!.quarantined).toBe(true);
    expect(r.collisions).toEqual([
      { file: "acme.env", collidesWith: "copy.env", kind: "same-account" },
      { file: "copy.env", collidesWith: "acme.env", kind: "same-account" },
    ]);
  });

  // Item A: marking ONE member un-quarantines ONLY that member; the unmarked
  // sibling stays quarantined. Marking the SECOND file proves the first is no
  // longer silently admitted as "canonical".
  it("un-quarantines only the marked member of a same-account group", () => {
    const { dir, base } = tmpRoot({
      "acme.env": cfg("a", "SAME"), // unmarked → still quarantined
      "copy.env": cfg("b", "SAME", "1", "# freshbooks-distinct-login\n"), // marked → admitted
    });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(2);
    expect(r.profiles.get("acme")!.quarantined).toBe(true);
    expect(r.profiles.get("copy")!.quarantined).toBe(false);
    expect(r.collisions).toEqual([
      { file: "acme.env", collidesWith: "copy.env", kind: "same-account" },
      { file: "copy.env", collidesWith: "acme.env", kind: "same-account-optin" },
    ]);
  });

  // Item A opt-in: when EVERY member carries the marker the user has vouched for
  // all of them as distinct live logins => all admitted, none quarantined.
  it("admits all members of a same-account group when every member is marked", () => {
    const { dir, base } = tmpRoot({
      "acme.env": cfg("a", "SAME", "1", "# freshbooks-distinct-login\n"),
      "copy.env": cfg("b", "SAME", "1", "# freshbooks-distinct-login\n"),
    });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(2);
    expect(r.profiles.get("acme")!.quarantined).toBe(false);
    expect(r.profiles.get("copy")!.quarantined).toBe(false);
    expect(r.collisions).toEqual([
      { file: "acme.env", collidesWith: "copy.env", kind: "same-account-optin" },
      { file: "copy.env", collidesWith: "acme.env", kind: "same-account-optin" },
    ]);
  });

  // U1: an empty accountId must not trip the same-account collision logic.
  it("does not collide two accounting-only profiles with blank account ids", () => {
    const { dir, base } = tmpRoot({
      "acme.env": "FRESHBOOKS_ACCESS_TOKEN=at-a\nFRESHBOOKS_REFRESH_TOKEN=rt-a\n",
      "beta.env": "FRESHBOOKS_ACCESS_TOKEN=at-b\nFRESHBOOKS_REFRESH_TOKEN=rt-b\n",
    });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(2);
    expect(r.collisions).toEqual([]);
    expect(r.profiles.get("beta")!.quarantined).toBe(false);
  });

  // U2: filesystem-aware case-collision assertion.
  it("rejects a case-colliding stem (filesystem-aware)", () => {
    const { dir, base, root } = tmpRoot({ "acme.env": cfg("a", "A1") });
    if (detectCaseSensitive(root)) {
      // Case-sensitive volume: a second physical file exists; the lowercase-stem
      // dedupe must reject it.
      writeFileSync(join(dir, "Acme.env"), cfg("c", "C1"));
      const r = discoverProfiles(dir, base);
      expect(r.profiles.size).toBe(1);
      expect(r.duplicates.length + r.broken.length).toBe(1);
    } else {
      // Case-insensitive volume (macOS/APFS): writing "Acme.env" is the SAME
      // file, so there is only ever one entry — never assert two exist here.
      writeFileSync(join(dir, "Acme.env"), cfg("c", "C1"));
      const r = discoverProfiles(dir, base);
      expect(r.profiles.size).toBe(1);
      expect(r.duplicates).toEqual([]);
    }
  });

  it("falls back to a legacy base .env as the 'default' profile when profiles/ is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-leg-"));
    created.push(root);
    const base = join(root, ".env");
    writeFileSync(base, cfg("legacy", "LEG"));
    const r = discoverProfiles(join(root, "profiles"), base);
    expect([...r.profiles.keys()]).toEqual(["default"]);
    expect(r.profiles.get("default")!.filePath).toBe(base);
    expect(r.profiles.get("default")!.quarantined).toBe(false);
  });

  it("returns an empty registry when neither profiles/ nor a legacy .env exist", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-empty-"));
    created.push(root);
    const r = discoverProfiles(join(root, "profiles"), join(root, ".env"));
    expect(r.profiles.size).toBe(0);
  });

  // Item D: discovery parses token material entirely in memory (dotenv.parse,
  // never dotenv.config) — it must NEVER inject a profile's secrets into
  // process.env, or one profile's tokens could leak into another's client.
  it("never injects any profile token/ID into process.env (in-memory-only parse)", () => {
    const LEAK_KEYS = [
      "FRESHBOOKS_ACCESS_TOKEN",
      "FRESHBOOKS_REFRESH_TOKEN",
      "FRESHBOOKS_ACCOUNT_ID",
      "FRESHBOOKS_BUSINESS_ID",
    ];
    for (const k of LEAK_KEYS) delete process.env[k];
    const before = new Set(Object.keys(process.env));

    const { dir, base } = tmpRoot({
      "acme.env": cfg("a", "A1"),
      "copy.env": cfg("b", "SAME"),
      "beta.env": cfg("c", "SAME"), // same-account group exercises both passes
    });
    discoverProfiles(dir, base);

    for (const k of LEAK_KEYS) expect(process.env[k]).toBeUndefined();
    // Discovery introduced no NEW env keys at all.
    expect(Object.keys(process.env).filter((k) => !before.has(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — memoized registry + resolution
// ---------------------------------------------------------------------------

describe("registry + resolution", () => {
  function useProfiles(files: Record<string, string>): void {
    const { dir, base } = tmpRoot(files);
    process.env.FRESHBOOKS_PROFILES_DIR = dir;
    process.env.FRESHBOOKS_BASE_ENV = base; // does not exist -> no legacy leak
    resetRegistry();
  }

  it("memoizes getRegistry until resetRegistry()", () => {
    useProfiles({ "acme.env": cfg("a", "A1") });
    expect(getRegistry()).toBe(getRegistry());
  });

  it("profileNames + profileCount reflect the registry", () => {
    useProfiles({ "acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    expect(profileNames().sort()).toEqual(["acme", "beta"]);
    expect(profileCount()).toBe(2);
  });

  it("profileCount counts quarantined profiles too (keeps account-required mode)", () => {
    useProfiles({ "acme.env": cfg("a", "SAME"), "copy.env": cfg("b", "SAME") });
    expect(profileCount()).toBe(2);
  });

  it("resolveProfile returns the named profile (case-insensitive) and is resolvable when quarantined", () => {
    useProfiles({ "acme.env": cfg("a", "SAME"), "copy.env": cfg("b", "SAME") });
    expect(resolveProfile("Acme").name).toBe("acme");
    expect(resolveProfile("copy").quarantined).toBe(true);
  });

  it("resolveProfile throws UnknownProfileError listing the available names", () => {
    useProfiles({ "acme.env": cfg("a", "A1") });
    try {
      resolveProfile("ghost");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownProfileError);
      expect((e as UnknownProfileError).available).toEqual(["acme"]);
    }
  });

  it("defaultProfileName returns the lone profile, null for 0 or 2+", () => {
    useProfiles({ "acme.env": cfg("a", "A1") });
    expect(defaultProfileName()).toBe("acme");

    useProfiles({ "acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    expect(defaultProfileName()).toBeNull();

    // 2 profiles (one quarantined) is still account-required: no default.
    useProfiles({ "acme.env": cfg("a", "SAME"), "copy.env": cfg("b", "SAME") });
    expect(defaultProfileName()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2 — AsyncLocalStorage context
// ---------------------------------------------------------------------------

describe("AsyncLocalStorage context", () => {
  it("exposes the running profile and isolates concurrent contexts", async () => {
    const { dir, base } = tmpRoot({ "acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    const r = discoverProfiles(dir, base);
    const a = r.profiles.get("acme")!;
    const b = r.profiles.get("beta")!;
    expect(currentProfileOrNull()).toBeNull();
    const [ra, rb] = await Promise.all([
      runInProfile(a, async () => {
        await new Promise((s) => setTimeout(s, 5));
        return currentProfile().name;
      }),
      runInProfile(b, async () => currentProfile().name),
    ]);
    expect([ra, rb]).toEqual(["acme", "beta"]);
    expect(currentProfileOrNull()).toBeNull();
  });

  it("currentProfile throws outside any context", () => {
    expect(() => currentProfile()).toThrow();
  });
});
