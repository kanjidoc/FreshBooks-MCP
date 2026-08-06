import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDistinctLogin } from "../src/migrate";
import { discoverProfiles, parseProfileConfig } from "../src/profiles";

/**
 * `markDistinctLogin` is the opt-in that releases a same-accountId quarantine.
 *
 * Discovery quarantines EVERY unmarked member of a same-accountId group
 * (`src/profiles.ts:177-189`), so marking only the newly written file would
 * leave the whole group excluded — the helper must mark the group. It also has
 * to scan the directory FRESH at call time: the memoized `getRegistry()`
 * snapshot predates the file the caller just wrote, which would silently skip
 * it. Everything here is asserted against the files on disk, never a registry.
 */

const MARKER_RE = /^#\s*freshbooks-distinct-login\b/m;

// A profile env body. `a` seeds distinct access/refresh tokens; `acc` is the
// accountId. `extra` prepends marker/comment lines.
const cfg = (a: string, acc: string, extra = "") =>
  `${extra}FRESHBOOKS_ACCESS_TOKEN=at-${a}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=rt-${a}\n` +
  `FRESHBOOKS_ACCOUNT_ID=${acc}\n` +
  `FRESHBOOKS_BUSINESS_ID=1\n`;

const roots: string[] = [];

/** A profiles dir seeded with `files`; removed in afterEach. */
function seed(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fb-mdl-"));
  roots.push(root);
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/**
 * The canonical fixture: three files share accountId A1 (gamma is already
 * marked), `other.env` is a different company, and `stray.env.pending` is a
 * decoy whose name does not end in `.env`.
 */
function seedGroup(): string {
  return seed({
    "alpha.env": cfg("alpha", "A1"),
    "beta.env": cfg("beta", "A1"),
    "gamma.env": cfg("gamma", "A1", "# freshbooks-distinct-login\n"),
    "other.env": cfg("other", "A2"),
    "stray.env.pending": cfg("stray", "A1"),
  });
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("markDistinctLogin", () => {
  it("marks every unmarked member of the accountId group and nothing else", () => {
    const dir = seedGroup();

    const marked = markDistinctLogin(dir, "A1");

    expect(marked.sort()).toEqual(["alpha.env", "beta.env"]); // gamma was pre-marked
    for (const f of ["alpha.env", "beta.env", "gamma.env"]) {
      expect(read(dir, f)).toMatch(MARKER_RE);
    }
    expect(read(dir, "other.env")).not.toMatch(/distinct-login/);
    expect(read(dir, "stray.env.pending")).not.toMatch(/distinct-login/);
  });

  it("marked files still parse and keep their tokens; discovery un-quarantines the group", () => {
    const dir = seedGroup();

    markDistinctLogin(dir, "A1");

    for (const f of ["alpha.env", "beta.env"]) {
      expect(parseProfileConfig(read(dir, f))).toEqual({
        accessToken: `at-${f.slice(0, -".env".length)}`,
        refreshToken: `rt-${f.slice(0, -".env".length)}`,
        accountId: "A1",
        businessId: "1",
      });
    }

    const res = discoverProfiles(dir, join(dir, "unused-base.env"));
    expect([...res.profiles.keys()].sort()).toEqual(["alpha", "beta", "gamma", "other"]);
    for (const p of res.profiles.values()) expect(p.quarantined).toBe(false);
  });

  it("is idempotent", () => {
    const dir = seedGroup();

    markDistinctLogin(dir, "A1");
    const before = ["alpha.env", "beta.env", "gamma.env"].map((f) => read(dir, f));

    expect(markDistinctLogin(dir, "A1")).toEqual([]);
    expect(["alpha.env", "beta.env", "gamma.env"].map((f) => read(dir, f))).toEqual(before);
  });

  it("scans the directory fresh, so a file written after discovery is still marked", () => {
    const dir = seedGroup();
    // Whatever any caller discovered earlier, this file exists NOW.
    discoverProfiles(dir, join(dir, "unused-base.env"));
    writeFileSync(join(dir, "delta.env"), cfg("delta", "A1"));

    expect(markDistinctLogin(dir, "A1").sort()).toEqual(["alpha.env", "beta.env", "delta.env"]);
    expect(read(dir, "delta.env")).toMatch(MARKER_RE);
  });

  it("puts the marker on its own line when the file has no trailing newline", () => {
    const dir = seed({ "alpha.env": cfg("alpha", "A1").trimEnd() });

    expect(markDistinctLogin(dir, "A1")).toEqual(["alpha.env"]);

    const body = read(dir, "alpha.env");
    expect(body).toMatch(MARKER_RE);
    expect(parseProfileConfig(body)!.businessId).toBe("1"); // not glued onto the last line
  });

  it("ignores unparseable files and never matches an empty accountId", () => {
    const dir = seed({
      "alpha.env": "FRESHBOOKS_ACCOUNT_ID=A1\n", // no tokens -> not a profile
      "beta.env": cfg("beta", ""), // accounting-only login, no accountId
    });

    expect(markDistinctLogin(dir, "")).toEqual([]);
    expect(read(dir, "alpha.env")).not.toMatch(/distinct-login/);
    expect(read(dir, "beta.env")).not.toMatch(/distinct-login/);
  });

  it("returns [] when the profiles directory does not exist", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "fb-mdl-none-")), "profiles");
    roots.push(dir);
    expect(markDistinctLogin(dir, "A1")).toEqual([]);
  });
});
