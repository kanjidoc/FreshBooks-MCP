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
  saveProfile,
  stagePending,
  type Memberships,
} from "../scripts/setup-core";
import { EXIT8_DIRECTIVE, EXIT8_QUESTION, SETUP_FLOW } from "../src/setup-flow";

/**
 * `--add-login` — both the fresh-authorization (`--callback-url`) form and the
 * resume forms (`--name` with no callback URL).
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` over a throwaway
 * `SetupPaths` rooted in a fresh temp dir, and `scripts/setup-core` is mocked at
 * every point that would reach FreshBooks (`exchangeCode`,
 * `discoverMemberships`, and the two `Client` builders — the second of which is
 * also where a resume's staged-token refresh goes). No test touches the
 * developer's real `.env` / `profiles/` / Claude configs, and none makes a
 * network call. The pending-file and profile-write helpers are deliberately NOT
 * stubbed — the staging/shredding sequence is exactly what these tests are
 * asserting, so it runs for real against the temp `profiles/` dir.
 *
 * TOKEN HYGIENE: every token in this file is a canary; every test sweeps both
 * captured streams with a sliding window, so a partial echo fails as loudly as a
 * whole one.
 */

const ACCESS = "ACCESS-CANARY-3f8a1d2e-DO-NOT-PRINT-EVER";
const REFRESH = "REFRESH-CANARY-7b4c9e05-DO-NOT-PRINT-EVER";
const APP_SECRET = "SECRET-CANARY-1a2b3c4d-DO-NOT-PRINT-EVER";

/**
 * A JWT-shaped access token whose `exp` decodes to `expSec` — what the resume's
 * staleness check reads (`decodeJwtExp`). `tag` rides inside the base64 payload
 * as well as both bookends, so every 8-character window of the token is
 * distinctive enough for the canary sweep to be meaningful.
 */
function stagedJwt(expSec: number, tag: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSec, canary: tag })).toString("base64url");
  return `HDR-${tag}.${payload}.SIG-${tag}`;
}

const NOW_SEC = Math.floor(Date.now() / 1000);

/** The pair a resume finds staged: fresh access token, unless a test says otherwise. */
const STAGED_ACCESS = stagedJwt(NOW_SEC + 3600, "STAGED-FRESH-CANARY-4e91b7");
const STAGED_ACCESS_EXPIRED = stagedJwt(NOW_SEC - 3600, "STAGED-DEAD-CANARY-7a35c0");
const STAGED_REFRESH = "STAGED-REFRESH-CANARY-6d02f4-DO-NOT-PRINT-EVER";

/** What FreshBooks hands back when a resume renews an expired staged pair. */
const ROTATED_ACCESS = stagedJwt(NOW_SEC + 3600, "ROTATED-CANARY-8c73e1");
const ROTATED_REFRESH = "ROTATED-REFRESH-CANARY-2b58a9-DO-NOT-PRINT-EVER";

/** Every secret this file puts on disk; none of them may reach either stream. */
const CANARIES = [
  ACCESS,
  REFRESH,
  APP_SECRET,
  STAGED_ACCESS,
  STAGED_ACCESS_EXPIRED,
  STAGED_REFRESH,
  ROTATED_ACCESS,
  ROTATED_REFRESH,
];

/** The distinct-login opt-in marker (`src/migrate.ts`), as it lands in a file. */
const MARKER_RE = /^#\s*freshbooks-distinct-login\b/m;

const CALLBACK = "https://localhost/callback?code=code-abc123";

/** The stub objects the mocked builders hand back in place of a `Client`. */
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
    // Real by default — overridden per-test to simulate a crash mid-save.
    saveProfile: vi.fn(),
  };
});

const realSaveProfile = (
  await vi.importActual<typeof import("../scripts/setup-core")>("../scripts/setup-core")
).saveProfile;

const roots: string[] = [];
let logs: string[];
let errs: string[];

const stdout = () => logs.join("\n");
const stderr = () => errs.join("\n");
const allOutput = () => [...logs, ...errs].join("\n");

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-add-login-"));
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

/** Seed `profiles/<name>.env` with a login carrying the given token pair. */
function seedPair(
  paths: SetupPaths,
  name: string,
  accountId: string,
  accessToken: string,
  refreshToken: string,
  businessId = "77",
): string {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeFileSync(
    path,
    `FRESHBOOKS_ACCESS_TOKEN=${accessToken}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=${refreshToken}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${accountId}\n` +
      `FRESHBOOKS_BUSINESS_ID=${businessId}\n`,
  );
  return path;
}

/** Seed `profiles/<name>.env` with a login of its own. */
function seedProfile(paths: SetupPaths, name: string, accountId: string, tag: string): string {
  return seedPair(paths, name, accountId, `at-${tag}`, `rt-${tag}`);
}

/** Stage an `--add-login` pending, as an interrupted run would have left it. */
function stageAdd(
  paths: SetupPaths,
  name: string,
  accessToken = STAGED_ACCESS,
  refreshToken = STAGED_REFRESH,
): void {
  stagePending(paths.profilesDir, name, {
    mode: "add",
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

/** Every `*.env` / `*.env.pending` file currently in the fixture's profiles dir. */
function profileFiles(paths: SetupPaths): string[] {
  return existsSync(paths.profilesDir) ? readdirSync(paths.profilesDir).sort() : [];
}

/** `--add-login --name <name> --callback-url <url> --json`. */
function addLoginArgv(name = "main", callbackUrl = CALLBACK): string[] {
  return ["--headless", "--add-login", "--name", name, "--callback-url", callbackUrl, "--json"];
}

/** `--add-login --name <name> [extra…] --json` — a resume, no callback URL. */
function resumeArgv(name = "main", ...extra: string[]): string[] {
  return ["--headless", "--add-login", "--name", name, ...extra, "--json"];
}

/** A `buildTokenClient` stub whose `refreshAccessToken` a test can drive. */
function tokenClientWithRefresh(refreshAccessToken: ReturnType<typeof vi.fn>): void {
  vi.mocked(buildTokenClient).mockReturnValue({
    refreshAccessToken,
  } as unknown as ReturnType<typeof buildTokenClient>);
}

const saveStep = SETUP_FLOW.find((s) => s.id === "save-login")!;
const authorizeStep = SETUP_FLOW.find((s) => s.id === "authorize")!;

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
  vi.mocked(saveProfile).mockImplementation(realSaveProfile);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const root = roots.pop()!;
    // A permission fixture may have left a dir read-only; re-open it so the
    // temp tree can actually be removed.
    const locked = join(root, "locked");
    if (existsSync(locked)) chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("--add-login (callback form): the clean path", () => {
  it("saves the login, shreds the pending, and reports it without tokens", async () => {
    const paths = fixture();

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "add-login",
      name: "main",
      company: "Acme Inc",
      accountId: "ACC-1",
      businessId: "9001",
      profilePath: join(paths.profilesDir, "main.env"),
    });

    // The login landed, tokens and all; the staged copy is gone.
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toMatch(new RegExp(`^FRESHBOOKS_ACCESS_TOKEN=${ACCESS}$`, "m"));
    expect(saved).toMatch(new RegExp(`^FRESHBOOKS_REFRESH_TOKEN=${REFRESH}$`, "m"));
    expect(saved).toMatch(/^FRESHBOOKS_ACCOUNT_ID=ACC-1$/m);
    expect(saved).toMatch(/^FRESHBOOKS_BUSINESS_ID=9001$/m);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);

    // The exchange ran once, on the code carried by the pasted address.
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exchangeCode).mock.calls[0][1]).toBe("code-abc123");
    // Discovery ran on a client built from the freshly exchanged pair.
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

  it("saves an accounting-only login that belongs to no business", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([]));

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.accountId).toBe("");
    expect(env.businessId).toBe("");
    expect(env).not.toHaveProperty("company");
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(true);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("stages the pending BEFORE discovery, mode-marked", async () => {
    const paths = fixture();
    let stagedAtDiscovery: ReturnType<typeof loadPending> = null;
    vi.mocked(discoverMemberships).mockImplementation(async () => {
      stagedAtDiscovery = loadPending(paths.profilesDir, "main");
      return memberships([ACME]);
    });

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.OK);
    expect(stagedAtDiscovery).not.toBeNull();
    expect(stagedAtDiscovery!).toMatchObject({
      mode: "add",
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });

  it("writes human output to stderr only when --json is absent", async () => {
    const paths = fixture();

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("Acme Inc");
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the gates that run before the exchange", () => {
  it("refuses a taken name with exit 4 and spends no authorization code", async () => {
    const paths = fixture();
    const existing = seedProfile(paths, "main", "ACC-9", "old");
    const before = readFileSync(existing, "utf8");

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.NAME_TAKEN);
    expect(code).toBe(4);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.verb).toBe("add-login");
    expect(env.stepId).toBe("nickname");
    expect(env.fix).toContain("already yours? run --doctor; reconnecting? use --reauth");
    // The gate is pre-exchange: no code was spent and nothing was staged.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual(["main.env"]);
    expect(readFileSync(existing, "utf8")).toBe(before);
    expectNoCanaryMaterial(allOutput());
  });

  it("refuses an invalid name with exit 4 and spends no authorization code", async () => {
    const paths = fixture();

    const code = await runHeadless(addLoginArgv("Not A Name"), paths);

    expect(code).toBe(EXIT.NAME_TAKEN);
    expect(envelope().stepId).toBe("nickname");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });

  it("requires app credentials — exit 7 keyed to the app-credentials step", async () => {
    const paths = fixture();
    rmSync(paths.baseEnvPath);

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.PRECONDITION);
    expect(code).toBe(7);
    expect(envelope().stepId).toBe("app-credentials");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });

  it("rejects invocations that are neither the callback form nor its flags", async () => {
    const paths = fixture();

    // No --name.
    expect(
      await runHeadless(["--headless", "--add-login", "--callback-url", CALLBACK], paths),
    ).toBe(EXIT.USAGE);
    // No --callback-url: the resume forms are not part of this build — and
    // nothing is staged under this name either, so exit 2 is the answer on
    // both sides of that change.
    expect(await runHeadless(["--headless", "--add-login", "--name", "main"], paths)).toBe(
      EXIT.USAGE,
    );
    // Resume-only flags do not belong on the fresh-authorization form.
    expect(
      await runHeadless([...addLoginArgv(), "--business-id", "9001"], paths),
    ).toBe(EXIT.USAGE);
    expect(
      await runHeadless([...addLoginArgv(), "--distinct-login", "--confirm-different-user"], paths),
    ).toBe(EXIT.USAGE);
    // A flag no verb takes.
    expect(await runHeadless([...addLoginArgv(), "--client-id", "cid"], paths)).toBe(EXIT.USAGE);

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the exchange", () => {
  it("exits 3 with nothing staged when the pasted address carries no code", async () => {
    const paths = fixture();

    const code = await runHeadless(addLoginArgv("main", "https://localhost/callback"), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(code).toBe(3);
    const env = envelope();
    expect(env.stepId).toBe("authorize");
    expect(env.fix).toContain(
      authorizeStep.troubleshooting.find((t) => t.symptom.includes("looks incomplete"))!.fix,
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 3 with nothing staged when FreshBooks rejects the code", async () => {
    const paths = fixture();
    // The shape an axios rejection really has: the request body rides along on
    // `config.data` and carries the app secret and the code.
    vi.mocked(exchangeCode).mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        config: { data: `client_secret=${APP_SECRET}&code=code-abc123` },
      }),
    );

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    const env = envelope();
    expect(env.stepId).toBe("authorize");
    expect(env.message).toBe("invalid_grant");
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the branches that keep the staged pair", () => {
  it("exits 11 and keeps the pending when discovery fails", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockRejectedValue(
      Object.assign(new Error("Request failed with status code 503"), {
        config: { data: `refresh_token=${REFRESH}` },
      }),
    );

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.DISCOVERY_FAILED);
    expect(code).toBe(11);
    const env = envelope();
    expect(env.stepId).toBe("save-login");
    expect(env.fix).toContain(
      saveStep.troubleshooting.find((t) => t.symptom.includes("exit 11"))!.fix,
    );
    expect(env.message).toBe("Request failed with status code 503");

    // The pair survives, so a resume can retry without a fresh authorization.
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "add",
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 6 with the membership labels when the login has several businesses", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.BUSINESS_CHOICE);
    expect(code).toBe(6);
    const env = envelope();
    expect(env.stepId).toBe("save-login");
    expect(env.memberships).toEqual([ACME, BETA]);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({ mode: "add" });
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 8 with the Book's question when the company is already connected", async () => {
    const paths = fixture();
    seedProfile(paths, "acme", "ACC-1", "incumbent");

    const code = await runHeadless(addLoginArgv("acme2"), paths);

    expect(code).toBe(EXIT.SAME_ACCOUNT);
    expect(code).toBe(8);
    const env = envelope();
    expect(env.stepId).toBe("save-login");
    expect(env.existingProfile).toBe("acme");
    expect(env.confirmQuestion).toBe(
      EXIT8_QUESTION.replace("<company>", "Acme Inc").replace("<existing profile>", "acme"),
    );
    expect(env.directive).toBe(EXIT8_DIRECTIVE);
    // Nothing was written; the staged pair waits for the human's answer.
    expect(existsSync(join(paths.profilesDir, "acme2.env"))).toBe(false);
    expect(loadPending(paths.profilesDir, "acme2")).toMatchObject({
      mode: "add",
      refreshToken: REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });

  it("passes onSameAccount: refuse — the save never writes without confirmation", async () => {
    const paths = fixture();
    seedProfile(paths, "acme", "ACC-1", "incumbent");

    await runHeadless(addLoginArgv("acme2"), paths);

    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveProfile).mock.calls[0][3]).toEqual({ onSameAccount: "refuse" });
  });

  it("keeps the pending when the save crashes", async () => {
    const paths = fixture();
    vi.mocked(saveProfile).mockImplementation(() => {
      throw new Error("EIO: the disk gave up mid-write");
    });

    const code = await runHeadless(addLoginArgv(), paths);

    expect(code).toBe(EXIT.FAIL);
    expect(envelope().stepId).toBe("save-login");
    expect(envelope().message).toBe("EIO: the disk gave up mid-write");
    // The whole point of staging: the freshly minted pair is still on disk.
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "add",
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it.skipIf(process.platform === "win32")(
    "fails without printing the pair when the staged file cannot be written",
    async () => {
      const paths = fixture();
      const locked = join(paths.rootDir, "locked");
      mkdirSync(locked);
      paths.profilesDir = join(locked, "profiles");
      chmodSync(locked, 0o555);

      const code = await runHeadless(addLoginArgv(), paths);

      expect(code).toBe(EXIT.FAIL);
      expect(envelope().ok).toBe(false);
      expect(envelope().stepId).toBe("save-login");
      expect(discoverMemberships).not.toHaveBeenCalled();
      expectNoCanaryMaterial(allOutput());
    },
  );
});

// ---------------------------------------------------------------------------
// The resume forms
// ---------------------------------------------------------------------------

describe("--add-login: the resume grammar", () => {
  it("exits 2 and names what IS staged when the --name has no pending", async () => {
    const paths = fixture();
    stageAdd(paths, "acme");
    stageAdd(paths, "beta");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(code).toBe(2);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.verb).toBe("add-login");
    expect(env.fix).toContain("acme");
    expect(env.fix).toContain("beta");
    // Nothing was consumed and nothing was touched.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "acme")).not.toBeNull();
    expect(loadPending(paths.profilesDir, "beta")).not.toBeNull();
    expectNoCanaryMaterial(allOutput());
  });

  it("does not offer a damaged pending as resumable — it can only be discarded", async () => {
    const paths = fixture();
    stageAdd(paths, "acme");
    // Markers damaged: `listPendings` still reports it (no token-bearing file
    // may linger unseen), but `loadPending` reads it as nothing staged — so
    // listing it under "can be resumed" sends an agent around this same loop.
    mkdirSync(paths.profilesDir, { recursive: true });
    writeFileSync(
      pendingPath(paths.profilesDir, "broken"),
      `FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}\n`,
    );

    expect(await runHeadless(resumeArgv("main"), paths)).toBe(EXIT.USAGE);

    const fix: string = envelope().fix;
    // Only the readable one is offered for resume; the damaged one is named
    // separately, with the one command that can actually deal with it.
    expect(fix).toMatch(/can be resumed: acme\./);
    expect(fix).toContain("--discard-pending");
    expect(fix).toMatch(/broken/);
    expectNoCanaryMaterial(allOutput());
  });

  it("refuses a reauth-staged pending with exit 2 naming --reauth", async () => {
    const paths = fixture();
    stagePending(paths.profilesDir, "main", {
      mode: "reauth",
      stagedAt: new Date().toISOString(),
      accessToken: STAGED_ACCESS,
      refreshToken: STAGED_REFRESH,
    });

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--reauth --name main");
    // The cross-verb gate is the whole point: the reauth pair is untouched.
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "reauth",
      accessToken: STAGED_ACCESS,
      refreshToken: STAGED_REFRESH,
    });
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expectNoCanaryMaterial(allOutput());
  });

  it("rejects --callback-url mixed with any resume-only flag", async () => {
    const paths = fixture();

    for (const extra of [
      ["--business-id", "9001"],
      ["--account-id", "ACC-1"],
      ["--distinct-login"],
      ["--confirm-different-user"],
    ]) {
      logs = [];
      errs = [];
      expect(await runHeadless([...addLoginArgv(), ...extra], paths)).toBe(EXIT.USAGE);
      expect(envelope().fix).toContain(extra[0]);
    }

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(profileFiles(paths)).toEqual([]);
    expectNoCanaryMaterial(allOutput());
  });

  it("requires --confirm-different-user alongside --distinct-login", async () => {
    const paths = fixture();
    stageAdd(paths, "acme2");

    const code = await runHeadless(resumeArgv("acme2", "--distinct-login"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--confirm-different-user");
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "acme2")).not.toBeNull();
    expectNoCanaryMaterial(allOutput());
  });

  it("requires --distinct-login alongside --confirm-different-user (the mirror)", async () => {
    // The pair is one gesture. Silently treating the confirmation alone as
    // "unconfirmed" re-emits exit 8 and reads to a driving agent as though the
    // human's answer was not accepted — so the grammar refuses it by name, the
    // same way the opposite half is refused.
    const paths = fixture();
    stageAdd(paths, "acme2");

    const code = await runHeadless(resumeArgv("acme2", "--confirm-different-user"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("--distinct-login");
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "acme2")).not.toBeNull();
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the pre-discovery short-circuit", () => {
  it("exits 0 with no API call when the profile already holds the staged pair", async () => {
    const paths = fixture();
    const profilePath = seedPair(paths, "main", "ACC-1", STAGED_ACCESS, STAGED_REFRESH);
    const before = readFileSync(profilePath, "utf8");
    stageAdd(paths, "main");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "add-login",
      name: "main",
      accountId: "ACC-1",
      businessId: "77",
      profilePath,
    });
    // The crashed-between-save-and-shred signature: the save already happened,
    // so all that is left is to clear the staged copy.
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(buildTokenClient).not.toHaveBeenCalled();
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expectNoCanaryMaterial(allOutput());
  });

  it("fires BEFORE the staged-token refresh, not after it", async () => {
    const paths = fixture();
    // The staged access token is long dead — but the pair it belongs to is
    // already saved, so nothing may go to FreshBooks at all.
    const profilePath = seedPair(paths, "main", "ACC-1", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    stageAdd(paths, "main", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    const refreshAccessToken = vi.fn();
    tokenClientWithRefresh(refreshAccessToken);

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope().profilePath).toBe(profilePath);
    expect(buildTokenClient).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("does NOT short-circuit when the saved profile holds a different pair", async () => {
    const paths = fixture();
    const existing = seedPair(paths, "main", "ACC-1", "at-someone-else", "rt-someone-else");
    const before = readFileSync(existing, "utf8");
    stageAdd(paths, "main");

    const code = await runHeadless(resumeArgv("main"), paths);

    // The resume runs for real and the save-stage backstop adjudicates it.
    expect(discoverMemberships).toHaveBeenCalledTimes(1);
    expect(code).toBe(EXIT.DUP_PAIR);
    expect(code).toBe(5);
    expect(readFileSync(existing, "utf8")).toBe(before);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: an expired staged access token", () => {
  it("renews it, re-stages the rotated pair BEFORE discovery, and saves that pair", async () => {
    const paths = fixture();
    stageAdd(paths, "main", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
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
    // The rotated pair replaced the staged one before anything could fail with
    // a revoked pair sitting on disk.
    expect(pendingAtDiscovery).not.toBeNull();
    expect(pendingAtDiscovery!).toMatchObject({
      mode: "add",
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
    });
    // Discovery ran on the rotated pair, and the rotated pair is what landed.
    expect(buildTokenClient).toHaveBeenLastCalledWith(
      "cid-123",
      APP_SECRET,
      "https://localhost/callback",
      ROTATED_ACCESS,
      ROTATED_REFRESH,
    );
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain(`FRESHBOOKS_ACCESS_TOKEN=${ROTATED_ACCESS}`);
    expect(saved).toContain(`FRESHBOOKS_REFRESH_TOKEN=${ROTATED_REFRESH}`);
    expect(saved).not.toContain(STAGED_REFRESH);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 3 and keeps the staged pair when FreshBooks refuses to renew it", async () => {
    const paths = fixture();
    stageAdd(paths, "main", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    const refreshAccessToken = vi.fn().mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        config: { data: `refresh_token=${STAGED_REFRESH}&client_secret=${APP_SECRET}` },
      }),
    );
    tokenClientWithRefresh(refreshAccessToken);

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(code).toBe(3);
    const env = envelope();
    expect(env.message).toBe("invalid_grant");
    expect(env.fix).toContain("--discard-pending --name main");
    expect(discoverMemberships).not.toHaveBeenCalled();
    // The dead pair is left for --discard-pending to clear, not silently eaten.
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      accessToken: STAGED_ACCESS_EXPIRED,
      refreshToken: STAGED_REFRESH,
    });
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the bare resume", () => {
  it("re-runs discovery on the staged pair and completes the save — exit 0", async () => {
    const paths = fixture();
    stageAdd(paths, "main");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "add-login",
      name: "main",
      company: "Acme Inc",
      accountId: "ACC-1",
      businessId: "9001",
      profilePath: join(paths.profilesDir, "main.env"),
    });
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain(`FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}`);
    expect(saved).toContain(`FRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}`);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    // No fresh authorization, and a still-fresh staged token is left alone: the
    // ONE token client built is discovery's.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(buildTokenClient).toHaveBeenCalledTimes(1);
    expectNoCanaryMaterial(allOutput());
  });

  it("re-emits exit 11 and keeps the pending when discovery fails again", async () => {
    const paths = fixture();
    stageAdd(paths, "main");
    vi.mocked(discoverMemberships).mockRejectedValue(
      Object.assign(new Error("Request failed with status code 503"), {
        config: { data: `refresh_token=${STAGED_REFRESH}` },
      }),
    );

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.DISCOVERY_FAILED);
    const env = envelope();
    expect(env.stepId).toBe("save-login");
    expect(env.fix).toContain(
      saveStep.troubleshooting.find((t) => t.symptom.includes("exit 11"))!.fix,
    );
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({
      mode: "add",
      refreshToken: STAGED_REFRESH,
    });
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("re-emits exit 6 with the memberships payload", async () => {
    const paths = fixture();
    stageAdd(paths, "main");
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.BUSINESS_CHOICE);
    expect(envelope().memberships).toEqual([ACME, BETA]);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({ mode: "add" });
    expectNoCanaryMaterial(allOutput());
  });

  it("re-emits exit 8 with the Book's exact question and directive", async () => {
    const paths = fixture();
    seedProfile(paths, "acme", "ACC-1", "incumbent");
    stageAdd(paths, "acme2");

    const code = await runHeadless(resumeArgv("acme2"), paths);

    expect(code).toBe(EXIT.SAME_ACCOUNT);
    const env = envelope();
    expect(env.existingProfile).toBe("acme");
    expect(env.confirmQuestion).toBe(
      EXIT8_QUESTION.replace("<company>", "Acme Inc").replace("<existing profile>", "acme"),
    );
    expect(env.directive).toBe(EXIT8_DIRECTIVE);
    expect(existsSync(join(paths.profilesDir, "acme2.env"))).toBe(false);
    expect(loadPending(paths.profilesDir, "acme2")).toMatchObject({ mode: "add" });
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the id-asserting resumes", () => {
  it("--business-id picks that membership out of a multi-business login", async () => {
    const paths = fixture();
    stageAdd(paths, "main");
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(resumeArgv("main", "--business-id", "9002"), paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.company).toBe("Beta LLC");
    expect(env.accountId).toBe("ACC-2");
    expect(env.businessId).toBe("9002");
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toMatch(/^FRESHBOOKS_ACCOUNT_ID=ACC-2$/m);
    expect(saved).toMatch(/^FRESHBOOKS_BUSINESS_ID=9002$/m);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("exits 2 with the memberships when --business-id matches none of them", async () => {
    const paths = fixture();
    stageAdd(paths, "main");
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(resumeArgv("main", "--business-id", "9999"), paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().memberships).toEqual([ACME, BETA]);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(loadPending(paths.profilesDir, "main")).toMatchObject({ mode: "add" });
    expectNoCanaryMaterial(allOutput());
  });

  it("--account-id skips discovery entirely and saves the asserted ids", async () => {
    const paths = fixture();
    stageAdd(paths, "main");

    const code = await runHeadless(
      resumeArgv("main", "--account-id", "ACC-7", "--business-id", "4242"),
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(discoverMemberships).not.toHaveBeenCalled();
    expect(buildTokenClient).not.toHaveBeenCalled();
    const env = envelope();
    expect(env.accountId).toBe("ACC-7");
    expect(env.businessId).toBe("4242");
    expect(env).not.toHaveProperty("company");
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain(`FRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}`);
    expect(saved).toMatch(/^FRESHBOOKS_ACCOUNT_ID=ACC-7$/m);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the confirmed distinct-login resume", () => {
  it("saves in warn mode and marks the whole shared-company group", async () => {
    const paths = fixture();
    const incumbent = seedProfile(paths, "acme", "ACC-1", "incumbent");
    stageAdd(paths, "acme2");

    const code = await runHeadless(
      resumeArgv("acme2", "--distinct-login", "--confirm-different-user"),
      paths,
    );

    expect(code).toBe(EXIT.OK);
    // The discover-stage refusal is bypassed; the save-stage guard still runs,
    // in "warn" — which is what makes branch 1 of exit 8 reachable at all.
    expect(vi.mocked(saveProfile).mock.calls[0][3]).toEqual({ onSameAccount: "warn" });
    expect(readFileSync(incumbent, "utf8")).toMatch(MARKER_RE);
    expect(readFileSync(join(paths.profilesDir, "acme2.env"), "utf8")).toMatch(MARKER_RE);
    expect(existsSync(pendingPath(paths.profilesDir, "acme2"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("composes with --business-id", async () => {
    const paths = fixture();
    seedProfile(paths, "beta", "ACC-2", "incumbent");
    stageAdd(paths, "beta2");
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(
      resumeArgv("beta2", "--distinct-login", "--confirm-different-user", "--business-id", "9002"),
      paths,
    );

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.accountId).toBe("ACC-2");
    expect(env.businessId).toBe("9002");
    expect(readFileSync(join(paths.profilesDir, "beta2.env"), "utf8")).toMatch(MARKER_RE);
    expectNoCanaryMaterial(allOutput());
  });
});

describe("--add-login: the save-stage backstop", () => {
  it("exits 5 and shreds the pending when another profile holds the staged token", async () => {
    const paths = fixture();
    const other = seedPair(paths, "other", "ACC-9", "at-other", STAGED_REFRESH);
    const before = readFileSync(other, "utf8");
    stageAdd(paths, "main");

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.DUP_PAIR);
    expect(code).toBe(5);
    // The fix names the login that actually holds the token, not a placeholder
    // the agent would have to resolve by reading every profile file.
    expect(envelope().fix).toContain("--reauth --name other");
    expect(envelope().fix).not.toContain("<that login's nickname>");
    expect(readFileSync(other, "utf8")).toBe(before);
    expect(existsSync(join(paths.profilesDir, "main.env"))).toBe(false);
    // Exit 5 discards the staged pair: the live profile keeps its own family.
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });

  it("treats a name taken by the SAME pair as an idempotent success", async () => {
    const paths = fixture();
    stageAdd(paths, "main");
    // A concurrent resume completes the save while this one is mid-discovery —
    // the race the short-circuit cannot cover, and the reason the backstop stays.
    vi.mocked(discoverMemberships).mockImplementation(async () => {
      seedPair(paths, "main", "ACC-1", STAGED_ACCESS, STAGED_REFRESH, "9001");
      return memberships([ACME]);
    });

    const code = await runHeadless(resumeArgv("main"), paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.name).toBe("main");
    expect(env.profilePath).toBe(join(paths.profilesDir, "main.env"));
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expectNoCanaryMaterial(allOutput());
  });
});
