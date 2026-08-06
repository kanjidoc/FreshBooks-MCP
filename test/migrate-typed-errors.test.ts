import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileWriteError, writeNewProfile } from "../src/migrate";
import { parseProfileConfig, type ProfileConfig } from "../src/profiles";

/**
 * The profile-write guards must carry machine-readable codes so the headless
 * verbs can map them onto exit codes — WITHOUT changing a single byte of the
 * messages, which `scripts/setup.ts` shows to the user verbatim and the
 * existing suite matches on (`test/migrate.test.ts` /already exists/i and
 * /refresh token/i). Every message here is asserted by exact equality, so a
 * reworded guard fails loudly rather than silently breaking a caller.
 */

const SRC: ProfileConfig = { accessToken: "at", refreshToken: "rt", accountId: "ACC", businessId: "9" };

function freshProfilesDir(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "profiles");
}

/** Run `fn`, return what it threw. Fails the test if it did not throw. */
function thrownBy(fn: () => unknown): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProfileWriteError codes on writeNewProfile's guards", () => {
  it("NAME_TAKEN: typed code, message byte-identical to today's", () => {
    const dir = freshProfilesDir("fb-pwe-name-");
    writeNewProfile(dir, "acme", SRC);

    // "Acme" normalizes to "acme" -> same file -> refuse, not clobber.
    const err = thrownBy(() => writeNewProfile(dir, "Acme", { ...SRC, refreshToken: "OTHER" }));

    expect(err).toBeInstanceOf(ProfileWriteError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("NAME_TAKEN");
    expect(err.message).toBe(
      "profiles/acme.env already exists — refusing to overwrite. Choose a different name.",
    );
    // and the incumbent login's tokens are untouched
    expect(parseProfileConfig(readFileSync(join(dir, "acme.env"), "utf8"))!.refreshToken).toBe("rt");
  });

  it("DUPLICATE_TOKEN: typed code, message byte-identical to today's, nothing written", () => {
    const dir = freshProfilesDir("fb-pwe-dup-");
    writeNewProfile(dir, "acme", SRC); // refreshToken "rt"

    const err = thrownBy(() =>
      writeNewProfile(dir, "beta", { accessToken: "x", refreshToken: "rt", accountId: "Z", businessId: "1" }),
    );

    expect(err).toBeInstanceOf(ProfileWriteError);
    expect(err.code).toBe("DUPLICATE_TOKEN");
    expect(err.message).toBe(
      "Refresh token already present in profiles/acme.env — refusing to write profiles/beta.env. " +
        "Two profile files sharing one refresh token guarantee a double-rotation lockout.",
    );
    expect(existsSync(join(dir, "beta.env"))).toBe(false);
  });

  it("onSameAccount:'refuse' throws SAME_ACCOUNT BEFORE writing; the default still warns and writes", () => {
    const dir = freshProfilesDir("fb-pwe-same-");
    writeNewProfile(dir, "acme", SRC); // accountId "ACC", refresh "rt"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // same accountId, distinct refresh token
    const dup: ProfileConfig = { accessToken: "x2", refreshToken: "rt2", accountId: "ACC", businessId: "2" };

    const err = thrownBy(() => writeNewProfile(dir, "acme2", dup, { onSameAccount: "refuse" }));
    expect(err).toBeInstanceOf(ProfileWriteError);
    expect(err.code).toBe("SAME_ACCOUNT");
    expect(existsSync(join(dir, "acme2.env"))).toBe(false); // refused BEFORE the write
    expect(warn).not.toHaveBeenCalled(); // refusing replaces the warning, never doubles it

    // default (and explicit "warn") reproduce today's behavior: warn, then write
    const written = writeNewProfile(dir, "acme2", dup);
    expect(existsSync(written)).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(parseProfileConfig(readFileSync(written, "utf8"))).toEqual(dup);
  });

  it("the same-account guard is off by default and still warns when opts is passed explicitly", () => {
    const dir = freshProfilesDir("fb-pwe-warnopt-");
    writeNewProfile(dir, "acme", SRC);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const written = writeNewProfile(
      dir,
      "beta",
      { accessToken: "x2", refreshToken: "rt2", accountId: "ACC", businessId: "2" },
      { onSameAccount: "warn" },
    );
    expect(existsSync(written)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("'refuse' does not fire for a DIFFERENT accountId — the write proceeds", () => {
    const dir = freshProfilesDir("fb-pwe-other-");
    writeNewProfile(dir, "acme", SRC); // accountId "ACC"

    const written = writeNewProfile(
      dir,
      "beta",
      { accessToken: "x2", refreshToken: "rt2", accountId: "OTHER", businessId: "2" },
      { onSameAccount: "refuse" },
    );
    expect(existsSync(written)).toBe(true);
  });

  it("DUPLICATE_TOKEN still outranks the same-account guard under 'refuse'", () => {
    // A file that matches BOTH (same accountId AND the same refresh token) must
    // report the lockout vector, not the softer same-company condition.
    const dir = freshProfilesDir("fb-pwe-both-");
    writeNewProfile(dir, "acme", SRC);

    const err = thrownBy(() =>
      writeNewProfile(dir, "beta", { ...SRC, accessToken: "x2" }, { onSameAccount: "refuse" }),
    );
    expect(err.code).toBe("DUPLICATE_TOKEN");
    expect(existsSync(join(dir, "beta.env"))).toBe(false);
  });
});
