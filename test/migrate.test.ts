import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATED_MARKER,
  isMigrated,
  buildProfileFileContent,
  stripTokensFromBaseEnv,
  runMigration,
  writeNewProfile,
} from "../src/migrate";
import { parseProfileConfig, type ProfileConfig } from "../src/profiles";
import { lockPathFor, writeLock } from "../src/server-lock";

// A legacy single-login .env: app creds + a complete token/ID set.
const legacy =
  "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_CLIENT_SECRET=sec\nFRESHBOOKS_REDIRECT_URI=u\n" +
  "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=9\n";

const SRC: ProfileConfig = { accessToken: "at", refreshToken: "rt", accountId: "ACC", businessId: "9" };

function freshRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("stripTokensFromBaseEnv removes tokens/ids, keeps app creds, adds marker", () => {
    const out = stripTokensFromBaseEnv(legacy);
    expect(out).toContain("FRESHBOOKS_CLIENT_ID=cid");
    expect(out).toContain("FRESHBOOKS_CLIENT_SECRET=sec");
    expect(out).toContain("FRESHBOOKS_REDIRECT_URI=u");
    expect(out).not.toMatch(/^FRESHBOOKS_ACCESS_TOKEN=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_REFRESH_TOKEN=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_ACCOUNT_ID=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_BUSINESS_ID=/m);
    expect(isMigrated(out)).toBe(true);
  });

  it("(U5) strips ALL occurrences of a DUPLICATED token line via the /gm global flag", () => {
    // A partial prior write or hand-edit can leave the same marker twice. A /m
    // (non-global) regex would strip only the first and let load-env's override:true
    // silently repopulate process.env from the survivor.
    const duped =
      legacy +
      "FRESHBOOKS_ACCESS_TOKEN=at_dupe\nFRESHBOOKS_REFRESH_TOKEN=rt_dupe\n" +
      "FRESHBOOKS_ACCOUNT_ID=ACC_dupe\nFRESHBOOKS_BUSINESS_ID=99\n";
    const out = stripTokensFromBaseEnv(duped);
    expect(out).not.toMatch(/^FRESHBOOKS_ACCESS_TOKEN=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_REFRESH_TOKEN=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_ACCOUNT_ID=/m);
    expect(out).not.toMatch(/^FRESHBOOKS_BUSINESS_ID=/m);
    // and no residual value anywhere
    expect(out).not.toContain("at_dupe");
    expect(out).not.toContain("rt_dupe");
    expect(isMigrated(out)).toBe(true);
  });

  it("stripTokensFromBaseEnv does not add a second marker if one already exists", () => {
    const once = stripTokensFromBaseEnv(legacy);
    const twice = stripTokensFromBaseEnv(once);
    const markerCount = (twice.match(new RegExp(`^${MIGRATED_MARKER}=`, "gm")) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("buildProfileFileContent round-trips through parseProfileConfig", () => {
    expect(parseProfileConfig(buildProfileFileContent(SRC))).toEqual(SRC);
  });
});

describe("runMigration (transactional ordering)", () => {
  it("writes+verifies the profile file BEFORE stripping base .env", () => {
    const root = freshRoot("fb-mig-");
    const base = join(root, ".env");
    writeFileSync(base, legacy);

    const { profilePath } = runMigration({ name: "Acme", rootDir: root });
    expect(profilePath.endsWith("/profiles/acme.env")).toBe(true);

    // profile file is complete & parseable -> the original tokens
    expect(parseProfileConfig(readFileSync(profilePath, "utf8"))).toEqual(SRC);

    // base .env no longer holds tokens, has marker, keeps app creds
    const after = readFileSync(base, "utf8");
    expect(after).toContain("FRESHBOOKS_CLIENT_ID=cid");
    expect(after).not.toMatch(/^FRESHBOOKS_ACCESS_TOKEN=/m);
    expect(after).not.toMatch(/^FRESHBOOKS_REFRESH_TOKEN=/m);
    expect(isMigrated(after)).toBe(true);
  });

  it("does NOT strip base .env when the profile write step fails (strip is strictly after verify)", () => {
    // Force the profile-write to throw via an R2 refresh-token collision in a sibling
    // profile, then assert base .env is untouched -> proves the strip is downstream of
    // a successful+verified profile write.
    const root = freshRoot("fb-migorder-");
    const base = join(root, ".env");
    writeFileSync(base, legacy);
    const dir = join(root, "profiles");
    mkdirSync(dir, { recursive: true });
    // sibling login shares the SAME refresh token "rt" that base .env carries
    writeFileSync(join(dir, "other.env"), buildProfileFileContent({ ...SRC, accountId: "OTHER" }));

    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/refresh token/i);

    // base .env still has its tokens (NOT stripped, NOT marked)
    const after = readFileSync(base, "utf8");
    expect(after).toMatch(/^FRESHBOOKS_REFRESH_TOKEN=rt$/m);
    expect(isMigrated(after)).toBe(false);
    expect(existsSync(join(dir, "acme.env"))).toBe(false);
  });

  it("throws when there is no base .env to migrate", () => {
    const root = freshRoot("fb-mignobase-");
    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/nothing to migrate|no \.env/i);
  });

  it("throws when base .env has no complete token set", () => {
    const root = freshRoot("fb-migpartial-");
    writeFileSync(join(root, ".env"), "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_ACCESS_TOKEN=at\n"); // no refresh
    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/no complete token set|nothing to migrate/i);
  });
});

describe("runMigration idempotency", () => {
  it("re-running after a complete migration throws 'already migrated'", () => {
    const root = freshRoot("fb-mig2-");
    writeFileSync(join(root, ".env"), legacy);
    runMigration({ name: "acme", rootDir: root });
    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/already migrated/i);
  });

  it("refuses when the FRESHBOOKS_MIGRATED marker is already present", () => {
    const root = freshRoot("fb-mig3-");
    writeFileSync(join(root, ".env"), `FRESHBOOKS_CLIENT_ID=cid\n${MIGRATED_MARKER}=1\n`);
    expect(() => runMigration({ name: "x", rootDir: root })).toThrow(/already migrated/i);
  });
});

describe("runMigration (U10) partial-failure resumability", () => {
  it("interrupted-after-profile-write (profile == source, base not yet stripped) -> re-run completes", () => {
    const root = freshRoot("fb-resume-");
    const base = join(root, ".env");
    writeFileSync(base, legacy); // base still carries full tokens, NOT marked
    const dir = join(root, "profiles");
    mkdirSync(dir, { recursive: true });
    // simulate a prior run that wrote the profile but died before stripping base .env
    const profilePath = join(dir, "acme.env");
    writeFileSync(profilePath, buildProfileFileContent(SRC));

    const res = runMigration({ name: "acme", rootDir: root });
    expect(res.profilePath).toBe(profilePath);

    // resume completes the strip+mark; profile is left intact (the source tokens)
    const after = readFileSync(base, "utf8");
    expect(after).not.toMatch(/^FRESHBOOKS_REFRESH_TOKEN=/m);
    expect(isMigrated(after)).toBe(true);
    expect(parseProfileConfig(readFileSync(profilePath, "utf8"))).toEqual(SRC);
  });

  it("profile-exists-but-DIFFERS -> refuses (does not clobber) with manual-recovery wording", () => {
    const root = freshRoot("fb-resumediff-");
    const base = join(root, ".env");
    writeFileSync(base, legacy);
    const dir = join(root, "profiles");
    mkdirSync(dir, { recursive: true });
    const profilePath = join(dir, "acme.env");
    // existing profile has a DIFFERENT token set than base .env
    writeFileSync(profilePath, buildProfileFileContent({ ...SRC, accessToken: "OTHER_AT", refreshToken: "OTHER_RT" }));

    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/different|recover|manual/i);

    // neither file was clobbered
    expect(parseProfileConfig(readFileSync(profilePath, "utf8"))!.refreshToken).toBe("OTHER_RT");
    const after = readFileSync(base, "utf8");
    expect(after).toMatch(/^FRESHBOOKS_REFRESH_TOKEN=rt$/m);
    expect(isMigrated(after)).toBe(false);
  });
});

describe("runMigration (R1) live-server lock guard", () => {
  it("refuses while a live-pid lock is held, but confirmNoServer:true proceeds", () => {
    const root = freshRoot("fb-mig4-");
    writeFileSync(join(root, ".env"), legacy);
    writeLock(lockPathFor(root)); // records THIS live test process's pid

    // confirmNoServer is the ONLY way past a live lock -> without it, refuse
    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/running|live|server/i);

    // with confirmNoServer:true the migration proceeds
    const { profilePath } = runMigration({ name: "acme", rootDir: root, confirmNoServer: true });
    expect(parseProfileConfig(readFileSync(profilePath, "utf8"))).toEqual(SRC);
    expect(isMigrated(readFileSync(join(root, ".env"), "utf8"))).toBe(true);
  });
});

describe("runMigration (U4) shreds the token-bearing backup", () => {
  it("a completed migration leaves NO token-bearing .env.bak and no leftover profile .tmp", () => {
    const root = freshRoot("fb-shred-");
    const base = join(root, ".env");
    writeFileSync(base, legacy);

    const { profilePath } = runMigration({ name: "acme", rootDir: root });

    // the pre-strip backup held the full token set -> must be gone
    expect(existsSync(`${base}.bak`)).toBe(false);
    // and no staged temp file survives for either write
    expect(existsSync(`${base}.tmp`)).toBe(false);
    expect(existsSync(`${profilePath}.tmp`)).toBe(false);
  });
});

describe("writeNewProfile collision guard (Amendments A6/A7)", () => {
  it("refuses to overwrite an existing profile (case-insensitive name)", () => {
    const root = freshRoot("fb-wnp-");
    const dir = join(root, "profiles");
    const p = writeNewProfile(dir, "acme", SRC);
    expect(p.endsWith("/profiles/acme.env")).toBe(true);

    // "Acme" normalizes to "acme" -> same file -> refuse, not clobber.
    expect(() => writeNewProfile(dir, "Acme", { ...SRC, refreshToken: "OTHER" })).toThrow(/already exists/i);
    expect(parseProfileConfig(readFileSync(p, "utf8"))!.refreshToken).toBe("rt"); // unchanged
  });

  it("(R2) HARD-REFUSES a config whose refreshToken matches an existing profile file", () => {
    const root = freshRoot("fb-r2-");
    const dir = join(root, "profiles");
    writeNewProfile(dir, "acme", SRC); // refreshToken "rt"

    // a DIFFERENT name but the SAME refresh token -> double-rotation lockout vector
    expect(() =>
      writeNewProfile(dir, "beta", { accessToken: "x", refreshToken: "rt", accountId: "Z", businessId: "1" }),
    ).toThrow(/refresh token/i);
    expect(existsSync(join(dir, "beta.env"))).toBe(false);
  });

  it("(R2) a duplicate accountId with a DIFFERENT token warns but does NOT refuse", () => {
    const root = freshRoot("fb-r2acc-");
    const dir = join(root, "profiles");
    writeNewProfile(dir, "acme", SRC); // accountId "ACC", refresh "rt"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // same accountId, distinct refresh token (legit accountant / shared-company topology)
    const p = writeNewProfile(dir, "beta", { accessToken: "x2", refreshToken: "rt2", accountId: "ACC", businessId: "2" });
    expect(existsSync(p)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("verifies the written profile by re-reading the token markers", () => {
    const root = freshRoot("fb-wnpverify-");
    const dir = join(root, "profiles");
    const p = writeNewProfile(dir, "gamma", SRC);
    expect(parseProfileConfig(readFileSync(p, "utf8"))).toEqual(SRC);
  });
});
