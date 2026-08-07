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
  type Memberships,
} from "../scripts/setup-core";
import { EXIT8_DIRECTIVE, EXIT8_QUESTION, SETUP_FLOW } from "../src/setup-flow";

/**
 * `--add-login`, the fresh-authorization (`--callback-url`) form.
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` over a throwaway
 * `SetupPaths` rooted in a fresh temp dir, and `scripts/setup-core` is mocked at
 * every point that would reach FreshBooks (`exchangeCode`,
 * `discoverMemberships`, and the two `Client` builders). No test touches the
 * developer's real `.env` / `profiles/` / Claude configs, and none makes a
 * network call. The pending-file and profile-write helpers are deliberately NOT
 * stubbed — the staging/shredding sequence is exactly what these tests are
 * asserting, so it runs for real against the temp `profiles/` dir.
 *
 * TOKEN HYGIENE: the exchanged pair is a canary; every test sweeps both captured
 * streams with a sliding window, so a partial echo fails as loudly as a whole
 * one.
 */

const ACCESS = "ACCESS-CANARY-3f8a1d2e-DO-NOT-PRINT-EVER";
const REFRESH = "REFRESH-CANARY-7b4c9e05-DO-NOT-PRINT-EVER";
const APP_SECRET = "SECRET-CANARY-1a2b3c4d-DO-NOT-PRINT-EVER";

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

/** Seed `profiles/<name>.env` with a login of its own. */
function seedProfile(paths: SetupPaths, name: string, accountId: string, tag: string): string {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeFileSync(
    path,
    `FRESHBOOKS_ACCESS_TOKEN=at-${tag}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=rt-${tag}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${accountId}\n` +
      "FRESHBOOKS_BUSINESS_ID=77\n",
  );
  return path;
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
  for (const canary of [ACCESS, REFRESH, APP_SECRET]) {
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
      expect(discoverMemberships).not.toHaveBeenCalled();
      expectNoCanaryMaterial(allOutput());
    },
  );
});
