import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPendings,
  loadPending,
  pendingPath,
  shredPending,
  stagePending,
  type PendingRecord,
} from "../scripts/setup-core";
import { discoverProfiles, parseProfileConfig } from "../src/profiles";
import { writeNewProfile } from "../src/migrate";

/**
 * Staged-pending file ops (`profiles/<name>.env.pending`).
 *
 * A pending holds the token pair from a completed OAuth exchange that has NOT yet
 * become a profile — the `--add-login` / `--reauth` state machine stages it right
 * after the exchange so a failure between exchange and save (multi-business
 * choice, same-account confirmation, a flaky discovery call) can be resumed
 * without burning the grant on a second authorization round-trip.
 *
 * Two properties carry the safety weight and are asserted here directly:
 *   - the file is invisible to BOTH scans that read `profiles/` — discovery
 *     (`src/profiles.ts:109`) and the duplicate-token guard (`src/migrate.ts:214`),
 *     each of which filters on `endsWith(".env")`. A pending deliberately holds a
 *     pair that is about to become a profile's, so being seen by either scan
 *     would make the server rotate a staged pair or make the save refuse itself.
 *   - the pair is never world-readable (mode 0600).
 *
 * Every fixture is a fresh temp dir; nothing here reads the developer's real
 * `.env` / `profiles/` (the `discoverProfiles` call passes an explicit,
 * nonexistent base-env path so the legacy fallback cannot reach the real one).
 */

const roots: string[] = [];

/** A throwaway `profiles/` dir seeded with `files`; removed in afterEach. */
function seed(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "fb-pending-"));
  roots.push(root);
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** A base `.env` path that does not exist — keeps discovery off the real one. */
const noBaseEnv = (profilesDir: string) => join(profilesDir, "..", "no-such.env");

const rec = (over: Partial<PendingRecord> = {}): PendingRecord => ({
  mode: "add",
  stagedAt: "2026-08-06T12:00:00.000Z",
  accessToken: "at-staged",
  refreshToken: "rt-staged",
  ...over,
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("pendingPath", () => {
  it("names the staged file <name>.env.pending inside profiles/", () => {
    const dir = seed();
    expect(pendingPath(dir, "acme")).toBe(join(dir, "acme.env.pending"));
  });
});

describe("stagePending / loadPending", () => {
  it("round-trips the record", () => {
    const dir = seed();
    const staged = rec({ mode: "reauth" });

    stagePending(dir, "acme", staged);

    expect(loadPending(dir, "acme")).toEqual(staged);
  });

  it("creates profiles/ when the very first login stages before any profile exists", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-pending-"));
    roots.push(root);
    const dir = join(root, "profiles");

    stagePending(dir, "acme", rec());

    expect(loadPending(dir, "acme")).toEqual(rec());
  });

  it("serializes as dotenv token lines plus the two marker comments", () => {
    const dir = seed();

    stagePending(dir, "acme", rec());
    const raw = readFileSync(pendingPath(dir, "acme"), "utf8");

    // parseProfileConfig is the contract: only the two tokens are required
    // (`src/profiles.ts:79`), so the comment lines cost nothing.
    expect(parseProfileConfig(raw)).toEqual({
      accessToken: "at-staged",
      refreshToken: "rt-staged",
      accountId: "",
      businessId: "",
    });
    expect(raw).toContain("# mode=add");
    expect(raw).toContain("# staged=2026-08-06T12:00:00.000Z");
  });

  it("keeps exactly one pending per name — a new exchange overwrites the old pair", () => {
    const dir = seed();

    stagePending(dir, "acme", rec());
    stagePending(dir, "acme", rec({ accessToken: "at-2", refreshToken: "rt-2" }));

    expect(loadPending(dir, "acme")).toEqual(rec({ accessToken: "at-2", refreshToken: "rt-2" }));
    expect(listPendings(dir)).toHaveLength(1);
  });

  it("returns null when nothing is staged for that name", () => {
    const dir = seed();
    expect(loadPending(dir, "acme")).toBeNull();
    expect(loadPending(join(dir, "nope"), "acme")).toBeNull();
  });

  it("returns null for a file with no token pair rather than a half-empty record", () => {
    const dir = seed({ "acme.env.pending": "# mode=add\n# staged=2026-08-06T12:00:00.000Z\n" });
    expect(loadPending(dir, "acme")).toBeNull();
  });

  it("returns null when the mode marker is missing or unrecognized", () => {
    // The mode decides WHICH write path resumes (create a profile vs replace an
    // existing profile's tokens); guessing it could drive the wrong one.
    const body = "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\n";
    const dir = seed({
      "nomode.env.pending": body,
      "bogus.env.pending": `${body}# mode=sideways\n`,
    });

    expect(loadPending(dir, "nomode")).toBeNull();
    expect(loadPending(dir, "bogus")).toBeNull();
  });

  it("falls back to the file's mtime when only the staged-at marker is damaged", () => {
    // stagedAt drives a staleness WARNING only, so a cosmetic marker problem must
    // not make a real staged pair unresumable.
    const dir = seed({
      "acme.env.pending": "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\n# mode=add\n",
    });

    const loaded = loadPending(dir, "acme");

    expect(loaded?.accessToken).toBe("at");
    expect(Number.isNaN(Date.parse(loaded!.stagedAt))).toBe(false);
  });
});

describe("staged pair permissions", () => {
  it.skipIf(process.platform === "win32")("writes the file mode 0600", () => {
    const dir = seed();
    stagePending(dir, "acme", rec());
    expect(statSync(pendingPath(dir, "acme")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing loose pending", () => {
    // writeFileSync's `mode` applies at CREATION only, so an overwrite of a
    // pre-existing looser file would otherwise silently keep 0644.
    const dir = seed();
    writeFileSync(pendingPath(dir, "acme"), "stale\n", { mode: 0o644 });

    stagePending(dir, "acme", rec());

    expect(statSync(pendingPath(dir, "acme")).mode & 0o777).toBe(0o600);
  });
});

describe("shredPending", () => {
  it("removes the staged file and is a no-op when there is nothing to remove", () => {
    const dir = seed();
    stagePending(dir, "acme", rec());

    shredPending(dir, "acme");

    expect(existsSync(pendingPath(dir, "acme"))).toBe(false);
    expect(() => shredPending(dir, "acme")).not.toThrow();
  });
});

describe("a staged pending is invisible to every profiles/ scan", () => {
  it("never appears in discoverProfiles — not as a profile, not even as broken", () => {
    const dir = seed();
    stagePending(dir, "acme", rec());

    const result = discoverProfiles(dir, noBaseEnv(dir));

    expect([...result.profiles.keys()]).toEqual([]);
    expect(result.broken).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.collisions).toEqual([]);
  });

  it("never trips writeNewProfile's duplicate-token guard against its own pair", () => {
    // The save that follows a resume writes the very pair that is staged; if the
    // pending were scanned, every add-login would refuse itself as a duplicate.
    const dir = seed();
    stagePending(dir, "acme", rec());

    const path = writeNewProfile(dir, "acme", {
      accessToken: "at-staged",
      refreshToken: "rt-staged",
      accountId: "A1",
      businessId: "1",
    });

    expect(existsSync(path)).toBe(true);
  });
});

describe("listPendings", () => {
  it("reports each staged file's name, mode and age", () => {
    const dir = seed();
    const dayMs = 24 * 60 * 60 * 1000;
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    stagePending(dir, "acme", rec({ mode: "add", stagedAt: stale }));
    stagePending(dir, "beta", rec({ mode: "reauth", stagedAt: new Date().toISOString() }));

    const listed = listPendings(dir);

    expect(listed.map((p) => p.name)).toEqual(["acme", "beta"]);
    expect(listed.map((p) => p.mode)).toEqual(["add", "reauth"]);
    // The doctor's staleness rule is "warn past 24 h" — the ages must sit either
    // side of that line.
    expect(listed[0].ageMs).toBeGreaterThan(dayMs);
    expect(listed[1].ageMs).toBeLessThan(dayMs);
  });

  it("still reports a pending whose markers are unreadable, so nothing lingers unseen", () => {
    const dir = seed({
      "acme.env.pending": "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\n",
    });

    const listed = listPendings(dir);

    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("acme");
    expect(listed[0].mode).toBe("unknown");
    expect(listed[0].ageMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores real profiles and returns [] for a missing directory", () => {
    const dir = seed({ "acme.env": "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\n" });

    expect(listPendings(dir)).toEqual([]);
    expect(listPendings(join(dir, "nope"))).toEqual([]);
  });
});
