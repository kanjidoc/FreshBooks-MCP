import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, runHeadless, type SetupPaths } from "../scripts/setup-headless";
import {
  buildOAuthClient,
  buildTokenClient,
  discoverMemberships,
  exchangeCode,
  loadPending,
  pendingPath,
  stagePending,
  type Memberships,
} from "../scripts/setup-core";
import { SETUP_FLOW } from "../src/setup-flow";

/**
 * `--reauth` (both forms) and `--discard-pending`.
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` over a throwaway
 * `SetupPaths` rooted in a fresh temp dir, and `scripts/setup-core` is mocked at
 * every point that would reach FreshBooks (`exchangeCode`,
 * `discoverMemberships`, and the two `Client` builders — the second is also
 * where a resume's staged-token renewal goes). No test touches the developer's
 * real `.env` / `profiles/` / Claude configs or the repo's real `.server.lock`,
 * and none makes a network call. The pending, duplicate-guard and
 * profile-replace helpers run FOR REAL against the temp dir: the staging /
 * replacing / shredding sequence is exactly what is under test here.
 *
 * TOKEN HYGIENE: every token in this file is a canary; every test sweeps both
 * captured streams with a sliding window, so a partial echo fails as loudly as
 * a whole one.
 */

/** The pair a fresh `--reauth --callback-url` exchange mints. */
const ACCESS = "ACCESS-CANARY-9d21c4f0-DO-NOT-PRINT-EVER";
const REFRESH = "REFRESH-CANARY-5e70b3a1-DO-NOT-PRINT-EVER";

/** The pair the saved profile already holds — the one re-auth replaces. */
const OLD_ACCESS = "OLD-ACCESS-CANARY-1c9f4b72-DO-NOT-PRINT-EVER";
const OLD_REFRESH = "OLD-REFRESH-CANARY-6a03e5d8-DO-NOT-PRINT-EVER";

const APP_SECRET = "SECRET-CANARY-4f18a6c3-DO-NOT-PRINT-EVER";

/**
 * A JWT-shaped access token whose `exp` decodes to `expSec` — what the resume's
 * staleness check reads (`decodeJwtExp`). `tag` rides inside the base64 payload
 * as well as both bookends, so every 8-character window is distinctive enough
 * for the canary sweep to be meaningful.
 */
function stagedJwt(expSec: number, tag: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSec, canary: tag })).toString("base64url");
  return `HDR-${tag}.${payload}.SIG-${tag}`;
}

const NOW_SEC = Math.floor(Date.now() / 1000);

const STAGED_ACCESS = stagedJwt(NOW_SEC + 3600, "STAGED-FRESH-CANARY-2f47ad");
const STAGED_ACCESS_EXPIRED = stagedJwt(NOW_SEC - 3600, "STAGED-DEAD-CANARY-90bc15");
const STAGED_REFRESH = "STAGED-REFRESH-CANARY-c3e82f-DO-NOT-PRINT-EVER";

const ROTATED_ACCESS = stagedJwt(NOW_SEC + 3600, "ROTATED-CANARY-71ba0e");
const ROTATED_REFRESH = "ROTATED-REFRESH-CANARY-48fd26-DO-NOT-PRINT-EVER";

/** Every secret this file puts on disk; none of them may reach either stream. */
const CANARIES = [
  ACCESS,
  REFRESH,
  OLD_ACCESS,
  OLD_REFRESH,
  APP_SECRET,
  STAGED_ACCESS,
  STAGED_ACCESS_EXPIRED,
  STAGED_REFRESH,
  ROTATED_ACCESS,
  ROTATED_REFRESH,
];

const CALLBACK = "https://localhost/callback?code=code-reauth-1";

const OAUTH_CLIENT = { stub: "oauth-client" } as unknown as ReturnType<typeof buildOAuthClient>;
const TOKEN_CLIENT = { stub: "token-client" } as unknown as ReturnType<typeof buildTokenClient>;

vi.mock("../scripts/setup-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/setup-core")>();
  return {
    ...actual,
    // Everything that would talk to FreshBooks.
    buildOAuthClient: vi.fn(),
    buildTokenClient: vi.fn(),
    exchangeCode: vi.fn(),
    discoverMemberships: vi.fn(),
  };
});

const roots: string[] = [];
let logs: string[];
let errs: string[];

const stdout = () => logs.join("\n");
const stderr = () => errs.join("\n");
const allOutput = () => [...logs, ...errs].join("\n");

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-reauth-"));
  roots.push(rootDir);
  writeFileSync(
    join(rootDir, ".env"),
    "FRESHBOOKS_CLIENT_ID=cid-123\n" +
      `FRESHBOOKS_CLIENT_SECRET=${APP_SECRET}\n` +
      "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n",
  );
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: join(rootDir, "claude_desktop_config.json"),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(rootDir, "dot-claude.json"),
  };
}

/** Seed `profiles/<name>.env` — the saved login a re-auth reconnects. */
function seedProfile(
  paths: SetupPaths,
  name: string,
  accountId: string,
  opts: {
    accessToken?: string;
    refreshToken?: string;
    businessId?: string;
    extraLines?: string;
  } = {},
): string {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeFileSync(
    path,
    (opts.extraLines ?? "") +
      `FRESHBOOKS_ACCESS_TOKEN=${opts.accessToken ?? OLD_ACCESS}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=${opts.refreshToken ?? OLD_REFRESH}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${accountId}\n` +
      `FRESHBOOKS_BUSINESS_ID=${opts.businessId ?? "77"}\n`,
  );
  return path;
}

/** Stage a `--reauth` pending, as an interrupted run would have left it. */
function stageReauth(
  paths: SetupPaths,
  name: string,
  accessToken = STAGED_ACCESS,
  refreshToken = STAGED_REFRESH,
): void {
  stagePending(paths.profilesDir, name, {
    mode: "reauth",
    stagedAt: new Date().toISOString(),
    accessToken,
    refreshToken,
  });
}

/** A `discoverMemberships` result with the given business list. */
function memberships(list: Memberships["list"]): Memberships {
  return { user: { firstName: "Ada", lastName: "L", email: "ada@example.com" }, list };
}

const ACME = { label: "Acme Inc", accountId: "ACC-1", businessId: "9001" };
const BETA = { label: "Beta LLC", accountId: "ACC-2", businessId: "9002" };

/** Assert `output` contains no contiguous 8-char fragment of any canary. */
function expectNoCanaryMaterial(output: string): void {
  const WINDOW = 8;
  for (const canary of CANARIES) {
    for (let i = 0; i + WINDOW <= canary.length; i += 1) {
      expect(output).not.toContain(canary.slice(i, i + WINDOW));
    }
  }
}

/** The single JSON line a `--json` run prints on stdout. */
function envelope(): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

/** Every file currently in the fixture's profiles dir. */
function profileFiles(paths: SetupPaths): string[] {
  return existsSync(paths.profilesDir) ? readdirSync(paths.profilesDir).sort() : [];
}

/** `--reauth --name <name> --callback-url <url> --json`. */
function reauthArgv(name = "main", callbackUrl = CALLBACK): string[] {
  return ["--headless", "--reauth", "--name", name, "--callback-url", callbackUrl, "--json"];
}

/** `--reauth --name <name> [extra…] --json` — a resume, no callback URL. */
function resumeArgv(name = "main", ...extra: string[]): string[] {
  return ["--headless", "--reauth", "--name", name, ...extra, "--json"];
}

/** `--discard-pending [--name <name>] --json`. */
function discardArgv(name?: string): string[] {
  return ["--headless", "--discard-pending", ...(name ? ["--name", name] : []), "--json"];
}

/** A `buildTokenClient` stub whose `refreshAccessToken` a test can drive. */
function tokenClientWithRefresh(refreshAccessToken: ReturnType<typeof vi.fn>): void {
  vi.mocked(buildTokenClient).mockReturnValue({
    refreshAccessToken,
  } as unknown as ReturnType<typeof buildTokenClient>);
}

/** Pretend a server from this project folder is live: our own pid is alive. */
function writeServerLock(paths: SetupPaths): void {
  writeFileSync(join(paths.rootDir, ".server.lock"), JSON.stringify({ pid: process.pid }));
}

const saveStep = SETUP_FLOW.find((s) => s.id === "save-login")!;
const QUARANTINE_FIX = saveStep.troubleshooting.find((t) =>
  t.symptom.includes("quarantined profile mentioned"),
)!.fix;
const EXIT11_FIX = saveStep.troubleshooting.find((t) => t.symptom.includes("exit 11"))!.fix;

/** The spec's live-server sentence (§Surface 2, the `--reauth` row). */
const RESTART_SENTENCE = "restart Claude after re-auth so it picks up the new login.";

beforeEach(() => {
  logs = [];
  errs = [];
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  });

  vi.mocked(buildOAuthClient).mockReturnValue(OAUTH_CLIENT);
  vi.mocked(buildTokenClient).mockReturnValue(TOKEN_CLIENT);
  vi.mocked(exchangeCode).mockResolvedValue({ accessToken: ACCESS, refreshToken: REFRESH });
  vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME]));
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const root = roots.pop()!;
    const locked = join(root, "locked");
    if (existsSync(locked)) chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("--reauth (callback form): the clean path", () => {
  it("replaces only the tokens, keeps the ids, shreds the pending", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "reauth",
      name: "main",
      company: "Acme Inc",
      accountId: "ACC-1",
      businessId: "77",
      profilePath,
    });

    // The token lines are swapped; every other line — including the ids, which
    // a re-auth never rewrites — is byte-identical.
    expect(readFileSync(profilePath, "utf8")).toBe(
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS}\n` +
        `FRESHBOOKS_REFRESH_TOKEN=${REFRESH}\n` +
        "FRESHBOOKS_ACCOUNT_ID=ACC-1\n" +
        "FRESHBOOKS_BUSINESS_ID=77\n",
    );
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);

    expect(vi.mocked(exchangeCode).mock.calls[0][1]).toBe("code-reauth-1");
    expect(buildTokenClient).toHaveBeenCalledWith(
      "cid-123",
      APP_SECRET,
      "https://localhost/callback",
      ACCESS,
      REFRESH,
    );
    expect(discoverMemberships).toHaveBeenCalledWith(TOKEN_CLIENT);
    expectNoCanaryMaterial(allOutput());
  });

  it("passes containment on a login that belongs to several businesses", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-2", { businessId: "9002" });
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(reauthArgv(), paths);

    // A multi-business login is exit 6 for --add-login; for --reauth the stored
    // accountId already names the membership, so there is nothing to ask.
    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.company).toBe("Beta LLC");
    expect(env.accountId).toBe("ACC-2");
    expect(readFileSync(profilePath, "utf8")).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expectNoCanaryMaterial(allOutput());
  });

  it("stages the pending BEFORE discovery, mode-marked reauth", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    let stagedAtDiscovery: ReturnType<typeof loadPending> = null;
    vi.mocked(discoverMemberships).mockImplementation(async () => {
      stagedAtDiscovery = loadPending(paths.profilesDir, "main");
      return memberships([ACME]);
    });

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(stagedAtDiscovery).not.toBeNull();
    expect(stagedAtDiscovery!).toMatchObject({
      mode: "reauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });

  it("preserves comments and the distinct-login marker in the profile file", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1", {
      extraLines: "# freshbooks-distinct-login\n",
    });

    expect(await runHeadless(reauthArgv(), paths)).toBe(EXIT.OK);

    const after = readFileSync(profilePath, "utf8");
    expect(after).toMatch(/^#\s*freshbooks-distinct-login\b/m);
    expect(after).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ACCESS}`);
    expectNoCanaryMaterial(allOutput());
  });

  it("writes human output to stderr only when --json is absent", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("Acme Inc");
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--reauth: the gates that run before the exchange", () => {
  it("exits 2 pointing at --add-login when no login carries that name", async () => {
    const paths = fixture();
    seedProfile(paths, "other", "ACC-9");

    const code = await runHeadless(reauthArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(code).toBe(2);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.verb).toBe("reauth");
    expect(env.fix).toContain("--add-login");
    // The gate is pre-exchange: no code was spent and nothing was staged.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual(["other.env"]);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 2 pointing at --add-login for a name no profile file could carry", async () => {
    const paths = fixture();

    const code = await runHeadless(reauthArgv("Not A Name"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--add-login");
    expect(exchangeCode).not.toHaveBeenCalled();
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 2 when --name is missing altogether", async () => {
    const paths = fixture();

    const code = await runHeadless(
      ["--headless", "--reauth", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--name");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("requires app credentials — exit 7 keyed to the app-credentials step", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    rmSync(paths.baseEnvPath);

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.PRECONDITION);
    expect(code).toBe(7);
    expect(envelope().stepId).toBe("app-credentials");
    expect(exchangeCode).not.toHaveBeenCalled();
    expectNoCanaryMaterial(allOutput());
  });

  it("takes no id-asserting flags — discovery is the wrong-account protection", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "main");

    for (const extra of [
      ["--account-id", "ACC-1"],
      ["--business-id", "9001"],
      ["--distinct-login"],
      ["--confirm-different-user"],
    ]) {
      logs = [];
      errs = [];
      expect(await runHeadless(resumeArgv("main", ...extra), paths)).toBe(EXIT.USAGE);
      expect(envelope().fix).toContain(extra[0]);
      // `--reauth` is not in any Book step's `verbs` list, so this rejection
      // runs on the dispatcher's fallback — which still has to name a step.
      expect(envelope().stepId).toBe("save-login");
    }

    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({ mode: "reauth" });
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--reauth: the exchange", () => {
  it("exits 3 with nothing staged when the pasted address carries no code", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    const before = readFileSync(profilePath, "utf8");

    const code = await runHeadless(reauthArgv("main", "https://localhost/callback"), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(code).toBe(3);
    expect(envelope().stepId).toBe("authorize");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(profileFiles(paths)).toEqual(["main.env"]);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 3 with nothing staged when FreshBooks rejects the code", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    const before = readFileSync(profilePath, "utf8");
    // The shape an axios rejection really has: the request body rides along on
    // `config.data` and carries the app secret and the code.
    vi.mocked(exchangeCode).mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        config: { data: `client_secret=${APP_SECRET}&code=code-reauth-1` },
      }),
    );

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    const env = envelope();
    expect(env.stepId).toBe("authorize");
    expect(env.message).toBe("invalid_grant");
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(profileFiles(paths)).toEqual(["main.env"]);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--reauth: set-containment", () => {
  it("exits 12 and KEEPS the pending when the stored account is absent from memberships", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-9");
    const before = readFileSync(profilePath, "utf8");
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.REAUTH_MISMATCH);
    expect(code).toBe(12);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.verb).toBe("reauth");
    expect(env.stepId).toBe("save-login");
    expect(env.fix).toContain("--discard-pending --name main");
    // The saved login is untouched, and the fresh grant stays resumable.
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "reauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });

  it("lets a fresh authorization overwrite the pending exit 12 left behind", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    vi.mocked(discoverMemberships).mockResolvedValueOnce(memberships([BETA]));

    // The wrong account was signed in: the pair stays staged (exit 12).
    expect(await runHeadless(reauthArgv(), paths)).toBe(EXIT.REAUTH_MISMATCH);
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({ refreshToken: REFRESH });

    // The documented recovery: sign in as the right account and re-auth — the
    // new exchange overwrites the staged pair rather than tripping over it.
    logs = [];
    errs = [];
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
    });

    expect(await runHeadless(reauthArgv(), paths)).toBe(EXIT.OK);
    const after = readFileSync(profilePath, "utf8");
    expect(after).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ROTATED_ACCESS}`);
    expect(after).toContain(`FRESHBOOKS_REFRESH_TOKEN=${ROTATED_REFRESH}`);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("refuses a profile file that carries no token pair, before spending a code", async () => {
    const paths = fixture();
    mkdirSync(paths.profilesDir, { recursive: true });
    const profilePath = join(paths.profilesDir, "main.env");
    writeFileSync(profilePath, "FRESHBOOKS_ACCOUNT_ID=ACC-1\n");

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.FAIL);
    expect(code).toBe(1);
    expect(envelope().fix).toContain("--doctor");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(readFileSync(profilePath, "utf8")).toBe("FRESHBOOKS_ACCOUNT_ID=ACC-1\n");
    expectNoCanaryMaterial(allOutput());
  });

  it("skips the check with a warning when the profile records no account id", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "", { businessId: "" });

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(stderr()).toMatch(/FRESHBOOKS_ACCOUNT_ID|account id/i);
    const after = readFileSync(profilePath, "utf8");
    expect(after).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ACCESS}`);
    expect(after).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expect(after).toMatch(/^FRESHBOOKS_ACCOUNT_ID=$/m);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 11 and keeps the pending when discovery fails", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    const before = readFileSync(profilePath, "utf8");
    vi.mocked(discoverMemberships).mockRejectedValue(
      Object.assign(new Error("Request failed with status code 503"), {
        config: { data: `refresh_token=${REFRESH}` },
      }),
    );

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.DISCOVERY_FAILED);
    expect(code).toBe(11);
    const env = envelope();
    expect(env.stepId).toBe("save-login");
    expect(env.fix).toContain(EXIT11_FIX);
    expect(env.message).toBe("Request failed with status code 503");
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "reauth",
      refreshToken: REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--reauth: the guards around the replace", () => {
  it("exits 5 without writing when another profile already holds the new pair", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    const before = readFileSync(profilePath, "utf8");
    const other = seedProfile(paths, "other", "ACC-9", {
      accessToken: "at-other",
      refreshToken: REFRESH,
    });
    const otherBefore = readFileSync(other, "utf8");

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.DUP_PAIR);
    expect(code).toBe(5);
    expect(envelope().stepId).toBe("save-login");
    // Neither file moved — the guard runs BEFORE the replace.
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(readFileSync(other, "utf8")).toBe(otherBefore);
    expectNoCanaryMaterial(allOutput());
  });

  it("shreds a lingering .rescue file alongside the replace", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    // A rescue left by a server whose token write failed. The replace supersedes
    // it (Security §rescue-file lifecycle, precedence rule).
    writeFileSync(
      `${profilePath}.rescue`,
      `FRESHBOOKS_ACCESS_TOKEN=${OLD_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${OLD_REFRESH}\n`,
    );

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(existsSync(`${profilePath}.rescue`)).toBe(false);
    expect(readFileSync(profilePath, "utf8")).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expectNoCanaryMaterial(allOutput());
  });

  it.skipIf(process.platform === "win32")(
    "keeps the pending and prints no tokens when the profile file cannot be written",
    async () => {
      const paths = fixture();
      const profilePath = seedProfile(paths, "main", "ACC-1");
      const before = readFileSync(profilePath, "utf8");
      stageReauth(paths, "main");
      // The guarded writer needs to create `<file>.bak` and `<file>.tmp` beside
      // the profile, so a read-only profiles dir is what a failed replace is.
      chmodSync(paths.profilesDir, 0o555);

      try {
        const code = await runHeadless(resumeArgv("main"), paths);

        expect(code).toBe(EXIT.FAIL);
        expect(envelope().fix).toContain("--reauth --name main");
        // The old pair still works and the new one is still resumable.
        expect(readFileSync(profilePath, "utf8")).toBe(before);
        expect(loadPending(paths.profilesDir, "main")).toMatchObject({
          mode: "reauth",
          refreshToken: STAGED_REFRESH,
        });
        expectNoCanaryMaterial(allOutput());
      } finally {
        chmodSync(paths.profilesDir, 0o755);
      }
    },
  );

  it("warns about a live server without refusing, and says to restart Claude", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    writeServerLock(paths);

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(stderr()).toContain(RESTART_SENTENCE);
    // Warnings ride stderr even under --json: stdout stays exactly one object.
    expect(logs).toHaveLength(1);
    expect(readFileSync(profilePath, "utf8")).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expectNoCanaryMaterial(allOutput());
  });

  it("says the quarantine persists when the reconnected profile is quarantined", async () => {
    const paths = fixture();
    // Two profiles share one company with distinct tokens and no opt-in marker:
    // discovery quarantines both (src/profiles.ts pass 2).
    const profilePath = seedProfile(paths, "main", "ACC-1");
    seedProfile(paths, "twin", "ACC-1", { accessToken: "at-twin", refreshToken: "rt-twin" });

    const code = await runHeadless(reauthArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(stderr()).toContain(QUARANTINE_FIX);
    expect(readFileSync(profilePath, "utf8")).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expectNoCanaryMaterial(allOutput());
  });

  it("stays silent about quarantine when the profile is not quarantined", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");

    expect(await runHeadless(reauthArgv(), paths)).toBe(EXIT.OK);

    expect(stderr()).not.toContain(QUARANTINE_FIX);
    expect(stderr()).not.toContain(RESTART_SENTENCE);
  });
});

describe("--reauth: the resume grammar", () => {
  it("exits 2 and names what IS staged when the --name has no pending", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "acme");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(code).toBe(2);
    expect(envelope().fix).toContain("acme");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "acme")).not.toBeNull();
    expectNoCanaryMaterial(allOutput());
  });

  it("refuses an add-staged pending with exit 2 naming --add-login", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    stagePending(paths.profilesDir, "main", {
      mode: "add",
      stagedAt: new Date().toISOString(),
      accessToken: STAGED_ACCESS,
      refreshToken: STAGED_REFRESH,
    });

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--add-login --name main");
    // The cross-verb gate is the whole point: the add pair is untouched.
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "add",
      accessToken: STAGED_ACCESS,
      refreshToken: STAGED_REFRESH,
    });
    expect(discoverMemberships).not.toHaveBeenCalled();
    expectNoCanaryMaterial(allOutput());
  });

  it("resumes the staged pair: discovery, containment, replace, shred", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "main");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "reauth",
      name: "main",
      company: "Acme Inc",
      accountId: "ACC-1",
      businessId: "77",
      profilePath,
    });
    const after = readFileSync(profilePath, "utf8");
    expect(after).toContain(`FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}`);
    expect(after).toContain(`FRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}`);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    // No fresh authorization, and a still-fresh staged token is left alone: the
    // ONE token client built is discovery's.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(buildTokenClient).toHaveBeenCalledTimes(1);
    expectNoCanaryMaterial(allOutput());
  });

  it("renews an expired staged access token and re-stages it before discovery", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "main", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    const refreshAccessToken = vi.fn().mockResolvedValue({
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
      accessTokenExpiresAt: new Date(),
    });
    tokenClientWithRefresh(refreshAccessToken);
    let pendingAtDiscovery: ReturnType<typeof loadPending> = null;
    vi.mocked(discoverMemberships).mockImplementation(async () => {
      pendingAtDiscovery = loadPending(paths.profilesDir, "main");
      return memberships([ACME]);
    });

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(pendingAtDiscovery).not.toBeNull();
    expect(pendingAtDiscovery!).toMatchObject({
      mode: "reauth",
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
    });
    const after = readFileSync(profilePath, "utf8");
    expect(after).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ROTATED_ACCESS}`);
    expect(after).toContain(`FRESHBOOKS_REFRESH_TOKEN=${ROTATED_REFRESH}`);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 3 and keeps the staged pair when FreshBooks refuses to renew it", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    const before = readFileSync(profilePath, "utf8");
    stageReauth(paths, "main", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    tokenClientWithRefresh(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("invalid_grant"), {
          config: { data: `refresh_token=${STAGED_REFRESH}&client_secret=${APP_SECRET}` },
        }),
      ),
    );

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    const env = envelope();
    expect(env.message).toBe("invalid_grant");
    expect(env.fix).toContain("--discard-pending --name main");
    expect(env.fix).toContain("--reauth");
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      accessToken: STAGED_ACCESS_EXPIRED,
      refreshToken: STAGED_REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--discard-pending", () => {
  it("shreds the staged pair and reports it, with the no-revoke note", async () => {
    const paths = fixture();
    seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "main");

    const code = await runHeadless(discardArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "discard-pending",
      name: "main",
      discarded: true,
    });
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    // The saved login is untouched — discarding clears the STAGED pair only.
    expect(profileFiles(paths)).toEqual(["main.env"]);
    // Honesty: the grant itself is still live at FreshBooks.
    expect(stderr()).toMatch(/does not revoke/i);
    expectNoCanaryMaterial(allOutput());
  });

  it("clears a damaged pending — the file no resume can read", async () => {
    const paths = fixture();
    mkdirSync(paths.profilesDir, { recursive: true });
    // No mode marker: `loadPending` reads null, but the file still holds a live
    // pair, so discarding it is exactly what it is for.
    writeFileSync(
      pendingPath(paths.profilesDir, "main"),
      `FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}\n`,
    );

    const code = await runHeadless(discardArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope().discarded).toBe(true);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 2, naming what IS staged, when nothing is staged under that name", async () => {
    const paths = fixture();
    stageReauth(paths, "acme");

    const code = await runHeadless(discardArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(code).toBe(2);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.verb).toBe("discard-pending");
    expect(env.fix).toContain("acme");
    expect(loadPending(paths.profilesDir, "acme")).not.toBeNull();
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 2 without --name, and for a name no pending could use", async () => {
    const paths = fixture();

    expect(await runHeadless(discardArgv(), paths)).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--name");

    logs = [];
    expect(await runHeadless(discardArgv("Not A Name"), paths)).toBe(EXIT.USAGE);
    expect(envelope().ok).toBe(false);
  });

  it("takes no flags beyond --name", async () => {
    const paths = fixture();
    stageReauth(paths, "main");

    const code = await runHeadless([...discardArgv("main"), "--account-id", "ACC-1"], paths);

    expect(code).toBe(EXIT.USAGE);
    // The Book maps no step to this verb, so the flag rejection has to fall
    // back — and an empty stepId would strand a driving agent with no part of
    // SETUP.md to return to.
    expect(envelope().stepId).toBe("save-login");
    expect(loadPending(paths.profilesDir, "main")).not.toBeNull();
  });

  it("round-trips with --reauth: discard, then a fresh authorization stages again", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", "ACC-1");
    stageReauth(paths, "main");

    expect(await runHeadless(discardArgv("main"), paths)).toBe(EXIT.OK);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);

    logs = [];
    errs = [];
    expect(await runHeadless(reauthArgv(), paths)).toBe(EXIT.OK);
    expect(readFileSync(profilePath, "utf8")).toContain(`FRESHBOOKS_REFRESH_TOKEN=${REFRESH}`);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });
});
