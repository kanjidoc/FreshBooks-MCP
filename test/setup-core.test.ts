import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoForeignDuplicate,
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  discoverMemberships,
  exchangeCode,
  extractCodeFromUrl,
  replaceProfileTokens,
  saveProfile,
  writeCredentialFile,
} from "../scripts/setup-core";
import { ProfileWriteError } from "../src/migrate";

/**
 * `scripts/setup-core.ts` is the non-interactive half of the setup wizard: every
 * step that talks to FreshBooks or to disk, with no prompting and no console
 * output. PR 1 extracts it behavior-identically so the headless verbs (PR 2) and
 * the re-rendered wizard (PR 3) can drive the same code the wizard drives today.
 *
 * The FreshBooks `Client` is stubbed as a plain object everywhere a network call
 * would happen — these tests never reach the API, and never touch the
 * developer's real `.env` / `profiles/` (every fixture is a fresh temp dir).
 */

const REDIRECT_URI = "https://localhost/callback";

const roots: string[] = [];

/** A throwaway `profiles/` dir seeded with `files`; removed in afterEach. */
function seed(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fb-core-"));
  roots.push(root);
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** A profile env body. `a` seeds the token pair; `acc` is the accountId. */
const cfg = (a: string, acc: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=at-${a}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=rt-${a}\n` +
  `FRESHBOOKS_ACCOUNT_ID=${acc}\n` +
  `FRESHBOOKS_BUSINESS_ID=1\n`;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("buildOAuthClient / buildAuthUrl", () => {
  it("builds a pre-auth client and an auth URL carrying the app's id and redirect", () => {
    const client = buildOAuthClient("cid", "sec", REDIRECT_URI);

    expect(client.clientId).toBe("cid");
    expect(client.clientSecret).toBe("sec");
    expect(client.redirectUri).toBe(REDIRECT_URI);
    expect(client.accessToken).toBeUndefined();

    const url = buildAuthUrl(client);
    expect(url).toContain("client_id=cid");
    expect(url).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
    expect(url).toContain("response_type=code");
  });
});

describe("buildTokenClient", () => {
  it("carries the staged token pair alongside the app credentials", () => {
    const client = buildTokenClient("cid", "sec", REDIRECT_URI, "at-1", "rt-1");

    expect(client.accessToken).toBe("at-1");
    expect(client.refreshToken).toBe("rt-1");
    // The app credentials must survive: `refreshAccessToken()` needs both the
    // secret and the redirect URI (SDK `authorizeCall`).
    expect(client.clientId).toBe("cid");
    expect(client.clientSecret).toBe("sec");
    expect(client.redirectUri).toBe(REDIRECT_URI);
  });
});

describe("extractCodeFromUrl", () => {
  it("reads the code out of a full redirect URL", () => {
    expect(extractCodeFromUrl(`${REDIRECT_URI}?code=abc123`)).toBe("abc123");
  });

  it("passes a bare code through untouched", () => {
    expect(extractCodeFromUrl("abc123")).toBe("abc123");
  });

  it("returns null for a URL with no code and for unparseable input", () => {
    expect(extractCodeFromUrl(`${REDIRECT_URI}?error=access_denied`)).toBeNull();
    expect(extractCodeFromUrl("http://[")).toBeNull();
  });
});

describe("exchangeCode", () => {
  it("returns just the token pair", async () => {
    const client: any = {
      getAccessToken: async (code: string) => ({
        accessToken: `at-for-${code}`,
        refreshToken: `rt-for-${code}`,
        accessTokenExpiresAt: new Date(0),
      }),
    };

    await expect(exchangeCode(client, "xyz")).resolves.toEqual({
      accessToken: "at-for-xyz",
      refreshToken: "rt-for-xyz",
    });
  });

  it("surfaces SDK rejection as a throw with no token in the message", async () => {
    const client: any = {
      getAccessToken: async () => {
        throw Object.assign(new Error("invalid_grant"), {
          config: { data: "client_secret=SHOULDNOTAPPEAR" },
        });
      },
    };

    await expect(exchangeCode(client, "x")).rejects.toThrow("invalid_grant");
    // The rejection is re-thrown as-is; what must never happen is this core
    // function widening the message with the request body it was attached to.
    await expect(exchangeCode(client, "x")).rejects.not.toThrow(/SHOULDNOTAPPEAR/);
  });

  it("throws rather than returning a half-empty pair when the SDK yields nothing", async () => {
    const client: any = { getAccessToken: async () => undefined };
    await expect(exchangeCode(client, "x")).rejects.toThrow(/no tokens/i);
  });
});

describe("discoverMemberships", () => {
  it("maps the membership shape to {label, accountId, businessId}", async () => {
    const authed: any = {
      users: {
        me: async () => ({
          ok: true,
          data: {
            firstName: "A",
            businessMemberships: [
              { business: { name: "Studio", accountId: "acc1", id: 7 } },
              { business: { accountId: "acc2", id: 9 } },
            ],
          },
        }),
      },
    };

    const m = await discoverMemberships(authed);

    expect(m.list).toEqual([
      { label: "Studio", accountId: "acc1", businessId: "7" },
      { label: "(unnamed business)", accountId: "acc2", businessId: "9" },
    ]);
    expect(m.user).toEqual({ firstName: "A", lastName: undefined, email: undefined });
  });

  it("returns an empty list (not a throw) for a login with no businesses", async () => {
    const authed: any = {
      users: {
        me: async () => ({ ok: true, data: { firstName: "A", lastName: "B", email: "a@b.c" } }),
      },
    };

    const m = await discoverMemberships(authed);

    expect(m.list).toEqual([]);
    expect(m.user).toEqual({ firstName: "A", lastName: "B", email: "a@b.c" });
  });

  it("throws when the identity read comes back empty", async () => {
    const authed: any = { users: { me: async () => ({ ok: false }) } };
    await expect(discoverMemberships(authed)).rejects.toThrow(/account details/i);
  });
});

describe("saveProfile", () => {
  it("writes the profile through writeNewProfile and returns its path", () => {
    const dir = seed({});

    const path = saveProfile(dir, "acme", {
      accessToken: "at-acme",
      refreshToken: "rt-acme",
      accountId: "A1",
      businessId: "1",
    });

    expect(path).toBe(join(dir, "acme.env"));
    expect(readFileSync(path, "utf8")).toBe(cfg("acme", "A1"));
  });

  it("propagates the guarded writer's typed refusals, including the opts pass-through", () => {
    const dir = seed({ "acme.env": cfg("acme", "A1") });

    // NAME_TAKEN — the collision guard is writeNewProfile's, unchanged.
    expect(() =>
      saveProfile(dir, "acme", {
        accessToken: "at-other",
        refreshToken: "rt-other",
        accountId: "A2",
        businessId: "1",
      }),
    ).toThrowError(expect.objectContaining({ code: "NAME_TAKEN" }));

    // The 4th argument really reaches writeNewProfile: same accountId, distinct
    // token, `refuse` → SAME_ACCOUNT before any write.
    const sameAccount = {
      accessToken: "at-second",
      refreshToken: "rt-second",
      accountId: "A1",
      businessId: "1",
    };
    expect(() => saveProfile(dir, "second", sameAccount, { onSameAccount: "refuse" })).toThrowError(
      expect.objectContaining({ code: "SAME_ACCOUNT" }),
    );
    expect(existsSync(join(dir, "second.env"))).toBe(false);
  });
});

describe("assertNoForeignDuplicate", () => {
  it("throws DUPLICATE_TOKEN when another profile already holds the refresh token", () => {
    const dir = seed({ "acme.env": cfg("acme", "A1") });

    try {
      assertNoForeignDuplicate(dir, "beta", "rt-acme");
      throw new Error("no throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProfileWriteError);
      expect(err.code).toBe("DUPLICATE_TOKEN");
      expect(err.message).toContain("profiles/acme.env");
    }
  });

  it("ignores the profile's own file — re-auth re-writes its own token", () => {
    const dir = seed({ "acme.env": cfg("acme", "A1") });
    expect(() => assertNoForeignDuplicate(dir, "acme", "rt-acme")).not.toThrow();
  });

  it("ignores non-.env siblings, so a staged pending is invisible to it", () => {
    const dir = seed({ "acme.env.pending": cfg("acme", "A1") });
    expect(() => assertNoForeignDuplicate(dir, "acme", "rt-acme")).not.toThrow();
  });

  it("is a no-op for an unrelated token and for a missing profiles dir", () => {
    const dir = seed({ "acme.env": cfg("acme", "A1") });
    expect(() => assertNoForeignDuplicate(dir, "beta", "rt-beta")).not.toThrow();
    expect(() => assertNoForeignDuplicate(join(dir, "nope"), "beta", "rt-beta")).not.toThrow();
  });
});

describe("replaceProfileTokens", () => {
  it("swaps only the two token lines and verifies the write", () => {
    const dir = seed({
      "acme.env":
        "# freshbooks-distinct-login\n" +
        "FRESHBOOKS_ACCESS_TOKEN=at-old\n" +
        "FRESHBOOKS_REFRESH_TOKEN=rt-old\n" +
        "FRESHBOOKS_ACCOUNT_ID=A1\n" +
        "FRESHBOOKS_BUSINESS_ID=1\n",
    });
    const path = join(dir, "acme.env");

    replaceProfileTokens(path, "at-new", "rt-new");

    expect(readFileSync(path, "utf8")).toBe(
      "# freshbooks-distinct-login\n" +
        "FRESHBOOKS_ACCESS_TOKEN=at-new\n" +
        "FRESHBOOKS_REFRESH_TOKEN=rt-new\n" +
        "FRESHBOOKS_ACCOUNT_ID=A1\n" +
        "FRESHBOOKS_BUSINESS_ID=1\n",
    );
  });

  it("refuses loudly when a token line is absent rather than silently keeping the old one", () => {
    const dir = seed({ "acme.env": "FRESHBOOKS_ACCESS_TOKEN=at-old\nFRESHBOOKS_ACCOUNT_ID=A1\n" });
    const path = join(dir, "acme.env");

    expect(() => replaceProfileTokens(path, "at-new", "rt-new")).toThrow(
      /FRESHBOOKS_REFRESH_TOKEN line not found/,
    );
    // The file keeps its old content — a failed substitution writes nothing.
    expect(readFileSync(path, "utf8")).toBe("FRESHBOOKS_ACCESS_TOKEN=at-old\nFRESHBOOKS_ACCOUNT_ID=A1\n");
  });
});

describe("writeCredentialFile", () => {
  it("writes the content it was given", () => {
    const dir = seed({});
    const path = join(dir, "creds.env");

    writeCredentialFile(path, "FRESHBOOKS_CLIENT_SECRET=s\n");

    expect(readFileSync(path, "utf8")).toBe("FRESHBOOKS_CLIENT_SECRET=s\n");
  });

  it("lets a genuine write failure through to the caller", () => {
    const dir = seed({});

    expect(() => writeCredentialFile(join(dir, "no-such-dir", "creds.env"), "x\n")).toThrow();
  });

  it.skipIf(process.platform === "win32")("creates a new file 0600", () => {
    const dir = seed({});
    const path = join(dir, "creds.env");

    writeCredentialFile(path, "x\n");

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("tightens an existing file BEFORE writing to it", () => {
    const dir = seed({ "creds.env": "old\n" });
    const path = join(dir, "creds.env");
    // 0400 makes the ordering observable: a write that is not preceded by the
    // tighten fails outright (EACCES) rather than landing in a loose file.
    chmodSync(path, 0o400);

    writeCredentialFile(path, "new\n");

    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
