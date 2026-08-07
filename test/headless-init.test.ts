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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  EXIT,
  defaultPaths,
  emitErr,
  emitOk,
  legacyEnvNeedsMigration,
  runHeadless,
  type SetupPaths,
} from "../scripts/setup-headless";
import { SETUP_FLOW } from "../src/setup-flow";
import { MIGRATED_MARKER } from "../src/migrate";

/**
 * The headless dispatcher, `--init` and `--auth-url`.
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` with a throwaway
 * `SetupPaths` rooted in a fresh temp dir — the developer's real `.env`,
 * `profiles/`, `.mcp.json` and Claude configs are never read or written. No
 * test reaches the FreshBooks API: `--auth-url` only builds a URL string, and
 * no other verb is implemented here.
 *
 * TOKEN HYGIENE: the app secret is a canary string; every test that supplies
 * one sweeps BOTH captured streams with a sliding window, so a partial echo
 * (a prefix, a suffix) fails just as loudly as a whole-value leak.
 */

const CANARY_SECRET = "SECRET-CANARY-9f2b7c4d-DO-NOT-PRINT-EVER";

const roots: string[] = [];
let logs: string[];
let errs: string[];

/** Everything the CLI wrote to stdout (the `--json` channel). */
const stdout = () => logs.join("\n");
/** Everything the CLI wrote to stderr (the human channel). */
const stderr = () => errs.join("\n");
/** Both streams — the surface an agent transcript sees. */
const allOutput = () => [...logs, ...errs].join("\n");

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-headless-"));
  roots.push(rootDir);
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: join(rootDir, "claude_desktop_config.json"),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(rootDir, "dot-claude.json"),
  };
}

/** Write `paths.baseEnvPath` with the given content. */
function seedBaseEnv(paths: SetupPaths, content: string): void {
  writeFileSync(paths.baseEnvPath, content);
}

/** A legacy single-login `.env`: tokens, no FRESHBOOKS_MIGRATED marker. */
const LEGACY_ENV =
  "FRESHBOOKS_CLIENT_ID=cid\n" +
  "FRESHBOOKS_CLIENT_SECRET=old-secret\n" +
  "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n" +
  "FRESHBOOKS_ACCESS_TOKEN=at-legacy\n" +
  "FRESHBOOKS_REFRESH_TOKEN=rt-legacy\n" +
  "FRESHBOOKS_ACCOUNT_ID=ACC1\n";

/** Assert `output` contains no contiguous 8-char fragment of `secret`. */
function expectNoSecretMaterial(output: string, secret: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + WINDOW));
  }
}

/** Write a secret file the CLI is expected to shred. Returns its path. */
function seedSecretFile(dir: string, secret = CANARY_SECRET): string {
  const file = join(dir, ".client-secret.tmp");
  writeFileSync(file, `${secret}\n`);
  return file;
}

/** Swap `process.stdin` for a finite stream; returns the restore function. */
function withStdin(text: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", {
    value: Readable.from([text]),
    configurable: true,
  });
  return () => Object.defineProperty(process, "stdin", original);
}

/** The single JSON line a `--json` run prints on stdout. */
function envelope(): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

const migrateStep = SETUP_FLOW.find((s) => s.id === "migrate-legacy")!;

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const root = roots.pop()!;
    // A permission fixture may have left a dir read-only; re-open it so the
    // temp tree can actually be removed.
    for (const sub of ["locked", "ro"]) {
      const dir = join(root, sub);
      if (existsSync(dir)) chmodSync(dir, 0o755);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the sweep guards itself", () => {
  it("catches a whole secret and a bare fragment", () => {
    expect(() => expectNoSecretMaterial(`x ${CANARY_SECRET} y`, CANARY_SECRET)).toThrow();
    expect(() =>
      expectNoSecretMaterial(`tail: ${CANARY_SECRET.slice(-12)}`, CANARY_SECRET),
    ).toThrow();
  });
});

describe("defaultPaths", () => {
  it("resolves the repo's own files without touching them", () => {
    const paths = defaultPaths();

    expect(existsSync(join(paths.rootDir, "package.json"))).toBe(true);
    expect(paths.baseEnvPath).toBe(join(paths.rootDir, ".env"));
    expect(paths.profilesDir).toBe(join(paths.rootDir, "profiles"));
    expect(paths.mcpJsonPath).toBe(join(paths.rootDir, ".mcp.json"));
    expect(paths.claudeJsonPath).toBe(join(homedir(), ".claude.json"));
    // The Desktop config is OS-dependent; it must at least be absolute and
    // point at Claude's own file, never inside the project.
    expect(paths.desktopConfigPath).toContain("laude");
    expect(paths.desktopConfigPath.startsWith(paths.rootDir)).toBe(false);
  });
});

describe("legacyEnvNeedsMigration", () => {
  it("is true only for a token-bearing base .env with no migrated marker", () => {
    const paths = fixture();

    // Missing file.
    expect(legacyEnvNeedsMigration(paths.baseEnvPath)).toBe(false);

    // App credentials only — a normal post-2.x install.
    seedBaseEnv(paths, "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_CLIENT_SECRET=sec\n");
    expect(legacyEnvNeedsMigration(paths.baseEnvPath)).toBe(false);

    // An empty token value is not a login.
    seedBaseEnv(paths, "FRESHBOOKS_REFRESH_TOKEN=\n");
    expect(legacyEnvNeedsMigration(paths.baseEnvPath)).toBe(false);

    // Tokens, no marker → the legacy state.
    seedBaseEnv(paths, LEGACY_ENV);
    expect(legacyEnvNeedsMigration(paths.baseEnvPath)).toBe(true);

    // Marker present → already migrated, whatever residue remains.
    seedBaseEnv(paths, `${LEGACY_ENV}${MIGRATED_MARKER}=1\n`);
    expect(legacyEnvNeedsMigration(paths.baseEnvPath)).toBe(false);
  });
});

describe("dispatcher: unmigrated legacy .env", () => {
  const invocations: [string, string[]][] = [
    ["--init", ["--init", "--client-id", "cid", "--client-secret", "sec"]],
    ["--auth-url", ["--auth-url"]],
    [
      "--add-login",
      ["--add-login", "--name", "main", "--callback-url", "https://localhost/callback?code=abc"],
    ],
  ];

  for (const [label, argv] of invocations) {
    it(`${label} refuses with exit 9 and the Book's migrate-legacy strings`, async () => {
      const paths = fixture();
      seedBaseEnv(paths, LEGACY_ENV);

      const code = await runHeadless(["--headless", ...argv, "--json"], paths);

      expect(code).toBe(EXIT.UNMIGRATED);
      expect(code).toBe(9);
      const env = envelope();
      expect(env.ok).toBe(false);
      expect(env.exitCode).toBe(9);
      expect(env.stepId).toBe("migrate-legacy");
      expect(env.symptom).toBe(migrateStep.humanScript[0]);
      expect(env.fix).toBe(migrateStep.agentGuidance);
      // The refusal happens BEFORE any write: the legacy file is untouched.
      expect(readFileSync(paths.baseEnvPath, "utf8")).toBe(LEGACY_ENV);
    });
  }

  it("does not fire once the migrated marker is present", async () => {
    const paths = fixture();
    seedBaseEnv(paths, `${LEGACY_ENV}${MIGRATED_MARKER}=1\n`);

    const code = await runHeadless(["--headless", "--auth-url", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(envelope().verb).toBe("auth-url");
  });
});

describe("dispatcher: invocation grammar", () => {
  it("rejects no verb, two verbs, and an unknown argument with exit 2", async () => {
    const paths = fixture();

    expect(await runHeadless(["--headless"], paths)).toBe(EXIT.USAGE);
    expect(await runHeadless(["--headless", "--init", "--auth-url"], paths)).toBe(EXIT.USAGE);
    expect(await runHeadless(["--headless", "--auth-url", "--nope"], paths)).toBe(EXIT.USAGE);
    expect(await runHeadless(["--headless", "--auth-url", "--name"], paths)).toBe(EXIT.USAGE);
    // An Object.prototype key is not a verb.
    expect(await runHeadless(["--headless", "toString"], paths)).toBe(EXIT.USAGE);
  });

  it("rejects a flag the verb does not take", async () => {
    const paths = fixture();
    seedBaseEnv(paths, "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_CLIENT_SECRET=sec\n");

    expect(await runHeadless(["--headless", "--auth-url", "--name", "main"], paths)).toBe(
      EXIT.USAGE,
    );
  });

  it("emits the error envelope on stdout only in --json mode", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--json"], paths);

    expect(code).toBe(EXIT.USAGE);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.exitCode).toBe(2);
    expect(typeof env.stepId).toBe("string");
    expect(stderr()).toBe("");
  });

  it("turns an unexpected throw into an envelope, never a stack or an error object", async () => {
    const paths = fixture();
    // A stdin stream that errors mid-read: the rejection escapes the verb
    // handler and must be caught by the dispatcher's last-line-of-defense.
    const exploding = new Readable({
      read() {
        this.destroy(Object.assign(new Error("stdin exploded"), { config: { data: "LEAK" } }));
      },
    });
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: exploding, configurable: true });

    try {
      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-stdin", "--json"],
        paths,
      );

      expect(code).toBe(EXIT.FAIL);
      const env = envelope();
      expect(env.ok).toBe(false);
      expect(env.message).toBe("stdin exploded");
      expect(allOutput()).not.toContain("LEAK");
      expect(allOutput()).not.toContain("at Object");
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
  });

  it("emits human-readable text on stderr only without --json", async () => {
    const paths = fixture();

    await runHeadless(["--headless"], paths);

    expect(stdout()).toBe("");
    expect(stderr()).not.toBe("");
  });
});

describe("--init", () => {
  it("writes a base .env with only the app credentials and shreds the secret file", async () => {
    const paths = fixture();
    const secretFile = seedSecretFile(paths.rootDir);

    const code = await runHeadless(
      [
        "--headless",
        "--init",
        "--client-id",
        "cid-123",
        "--client-secret-file",
        secretFile,
        "--json",
      ],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(existsSync(secretFile)).toBe(false);

    const content = readFileSync(paths.baseEnvPath, "utf8");
    expect(content).toMatch(/^FRESHBOOKS_CLIENT_ID=cid-123$/m);
    expect(content).toMatch(new RegExp(`^FRESHBOOKS_CLIENT_SECRET=${CANARY_SECRET}$`, "m"));
    expect(content).toMatch(/^FRESHBOOKS_REDIRECT_URI=https:\/\/localhost\/callback$/m);
    expect(content).not.toMatch(new RegExp(`^${MIGRATED_MARKER}=`, "m"));
    for (const marker of [
      "FRESHBOOKS_ACCESS_TOKEN",
      "FRESHBOOKS_REFRESH_TOKEN",
      "FRESHBOOKS_ACCOUNT_ID",
      "FRESHBOOKS_BUSINESS_ID",
    ]) {
      expect(content).not.toMatch(new RegExp(`^${marker}=`, "m"));
    }

    const env = envelope();
    expect(env).toEqual({ ok: true, verb: "init", envPath: paths.baseEnvPath });
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it.skipIf(process.platform === "win32")("creates the base .env mode 0600", async () => {
    const paths = fixture();
    const secretFile = seedSecretFile(paths.rootDir);

    await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
      paths,
    );

    expect(statSync(paths.baseEnvPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")(
    "tightens an existing world-readable base .env to 0600",
    async () => {
      const paths = fixture();
      seedBaseEnv(paths, "FRESHBOOKS_CLIENT_ID=old\n");
      chmodSync(paths.baseEnvPath, 0o644);
      const secretFile = seedSecretFile(paths.rootDir);

      await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
        paths,
      );

      expect(statSync(paths.baseEnvPath).mode & 0o777).toBe(0o600);
    },
  );

  it("preserves the FRESHBOOKS_MIGRATED marker", async () => {
    const paths = fixture();
    seedBaseEnv(paths, `FRESHBOOKS_CLIENT_ID=old\n${MIGRATED_MARKER}=1\n`);
    const secretFile = seedSecretFile(paths.rootDir);

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(readFileSync(paths.baseEnvPath, "utf8")).toMatch(
      new RegExp(`^${MIGRATED_MARKER}=1$`, "m"),
    );
  });

  it("reads the secret from stdin without echoing it", async () => {
    const paths = fixture();
    const restore = withStdin(`${CANARY_SECRET}\nignored second line\n`);

    try {
      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-stdin", "--json"],
        paths,
      );

      expect(code).toBe(EXIT.OK);
      expect(readFileSync(paths.baseEnvPath, "utf8")).toMatch(
        new RegExp(`^FRESHBOOKS_CLIENT_SECRET=${CANARY_SECRET}$`, "m"),
      );
      expect(readFileSync(paths.baseEnvPath, "utf8")).not.toContain("ignored second line");
      expectNoSecretMaterial(allOutput(), CANARY_SECRET);
    } finally {
      restore();
    }
  });

  it("warns about the argv secret source without echoing the value", async () => {
    const paths = fixture();

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret", CANARY_SECRET],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(stderr()).toContain("--client-secret");
    expect(stderr()).toMatch(/--client-secret-file|--client-secret-stdin/);
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it("shreds the secret file even when the base .env write fails", async () => {
    const paths = fixture();
    const secretFile = seedSecretFile(paths.rootDir);
    const locked = join(paths.rootDir, "locked");
    mkdirSync(locked);
    paths.baseEnvPath = join(locked, ".env");
    chmodSync(locked, 0o555);

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.FAIL);
    expect(existsSync(secretFile)).toBe(false);
    expect(existsSync(paths.baseEnvPath)).toBe(false);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.stepId).toBe("app-credentials");
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it.skipIf(process.platform === "win32")(
    "fails loudly, and writes nothing, when the secret file cannot be deleted",
    async () => {
      const paths = fixture();
      const ro = join(paths.rootDir, "ro");
      mkdirSync(ro);
      const secretFile = seedSecretFile(ro);
      chmodSync(ro, 0o555);

      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
        paths,
      );

      expect(code).toBe(EXIT.FAIL);
      expect(existsSync(secretFile)).toBe(true);
      // Loud: the path the user must delete by hand is named on stderr.
      expect(stderr()).toContain(secretFile);
      // The secret was never used: no base .env exists.
      expect(existsSync(paths.baseEnvPath)).toBe(false);
      expectNoSecretMaterial(allOutput(), CANARY_SECRET);
    },
  );

  it("rejects a missing client id, no secret source, and two secret sources", async () => {
    const paths = fixture();
    const secretFile = seedSecretFile(paths.rootDir);

    expect(await runHeadless(["--headless", "--init", "--client-secret", "s"], paths)).toBe(
      EXIT.USAGE,
    );
    expect(await runHeadless(["--headless", "--init", "--client-id", "cid"], paths)).toBe(
      EXIT.USAGE,
    );
    expect(
      await runHeadless(
        [
          "--headless",
          "--init",
          "--client-id",
          "cid",
          "--client-secret",
          "s",
          "--client-secret-file",
          secretFile,
        ],
        paths,
      ),
    ).toBe(EXIT.USAGE);
    // Rejected on grammar alone — nothing was written.
    expect(existsSync(paths.baseEnvPath)).toBe(false);
    // …and the secret file does not outlive the refusal that never read it.
    expect(existsSync(secretFile)).toBe(false);
  });

  it("rejects an unreadable secret file and an empty secret", async () => {
    const paths = fixture();

    expect(
      await runHeadless(
        [
          "--headless",
          "--init",
          "--client-id",
          "cid",
          "--client-secret-file",
          join(paths.rootDir, "nope.tmp"),
        ],
        paths,
      ),
    ).toBe(EXIT.USAGE);

    const blank = seedSecretFile(paths.rootDir, "   ");
    expect(
      await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", blank],
        paths,
      ),
    ).toBe(EXIT.USAGE);
    // Even a useless secret file is shredded.
    expect(existsSync(blank)).toBe(false);
    expect(existsSync(paths.baseEnvPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "tightens a read-only existing base .env BEFORE the new secret lands",
    async () => {
      const paths = fixture();
      seedBaseEnv(paths, "FRESHBOOKS_CLIENT_ID=old\n");
      // 0400: the write itself is impossible until the file has been tightened,
      // so a run that only chmods AFTERWARDS cannot pass this.
      chmodSync(paths.baseEnvPath, 0o400);
      const secretFile = seedSecretFile(paths.rootDir);

      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
        paths,
      );

      expect(code).toBe(EXIT.OK);
      expect(statSync(paths.baseEnvPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(paths.baseEnvPath, "utf8")).toMatch(
        new RegExp(`^FRESHBOOKS_CLIENT_SECRET=${CANARY_SECRET}$`, "m"),
      );
    },
  );
});

/**
 * A `--client-secret-file` is written by an agent at default permissions and is
 * deleted by this CLI — that is the contract SECRETS_RULES sells. A refusal that
 * returns BEFORE the read-once-then-delete choreography would otherwise leave a
 * live app secret on disk with nobody told, and the whole point of these
 * refusals is "come back later", which is exactly how long the file would sit.
 */
describe("a refusal never lets the secret file outlive it", () => {
  it("shreds it on the exit-9 unmigrated refusal", async () => {
    const paths = fixture();
    seedBaseEnv(paths, LEGACY_ENV);
    const secretFile = seedSecretFile(paths.rootDir);

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.UNMIGRATED);
    expect(existsSync(secretFile)).toBe(false);
    expect(envelope().stepId).toBe("migrate-legacy");
    // The legacy tokens are still untouched — shredding is all that changed.
    expect(readFileSync(paths.baseEnvPath, "utf8")).toBe(LEGACY_ENV);
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it("shreds it on a usage error that never reaches the read", async () => {
    const paths = fixture();

    // A verb that does not take the flag.
    const wrongVerb = seedSecretFile(paths.rootDir);
    expect(
      await runHeadless(["--headless", "--auth-url", "--client-secret-file", wrongVerb], paths),
    ).toBe(EXIT.USAGE);
    expect(existsSync(wrongVerb)).toBe(false);

    // An invocation that does not even parse.
    const unparsed = seedSecretFile(paths.rootDir);
    expect(
      await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", unparsed, "--nope"],
        paths,
      ),
    ).toBe(EXIT.USAGE);
    expect(existsSync(unparsed)).toBe(false);

    // `--init` with no client id: the refusal precedes the secret read.
    const noId = seedSecretFile(paths.rootDir);
    expect(
      await runHeadless(["--headless", "--init", "--client-secret-file", noId], paths),
    ).toBe(EXIT.USAGE);
    expect(existsSync(noId)).toBe(false);

    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it.skipIf(process.platform === "win32")(
    "says so loudly when the file cannot be deleted, keeping the refusal's exit code",
    async () => {
      const paths = fixture();
      seedBaseEnv(paths, LEGACY_ENV);
      const ro = join(paths.rootDir, "ro");
      mkdirSync(ro);
      const secretFile = seedSecretFile(ro);
      chmodSync(ro, 0o555);

      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile],
        paths,
      );

      expect(code).toBe(EXIT.UNMIGRATED); // the refusal is still the verdict
      expect(existsSync(secretFile)).toBe(true);
      expect(stderr()).toContain(secretFile);
      expect(stderr()).toMatch(/FATAL/);
      expectNoSecretMaterial(allOutput(), CANARY_SECRET);
    },
  );
});

describe("--auth-url", () => {
  const GOOD_ENV =
    "FRESHBOOKS_CLIENT_ID=cid-123\n" +
    `FRESHBOOKS_CLIENT_SECRET=${CANARY_SECRET}\n` +
    "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n";

  it("prints the authorization URL and nothing else", async () => {
    const paths = fixture();
    seedBaseEnv(paths, GOOD_ENV);

    const code = await runHeadless(["--headless", "--auth-url", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(Object.keys(env).sort()).toEqual(["ok", "url", "verb"]);
    expect(env.ok).toBe(true);
    expect(env.verb).toBe("auth-url");
    expect(env.url).toContain("client_id=cid-123");
    expect(env.url).toContain(`redirect_uri=${encodeURIComponent("https://localhost/callback")}`);
    expect(env.url).toContain("response_type=code");
    // The app secret is never part of an authorization URL.
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it("requires app credentials — exit 7 keyed to the app-credentials step", async () => {
    const paths = fixture();

    const missing = await runHeadless(["--headless", "--auth-url", "--json"], paths);
    expect(missing).toBe(EXIT.PRECONDITION);
    expect(missing).toBe(7);
    let env = envelope();
    expect(env.stepId).toBe("app-credentials");
    expect(env.verb).toBe("auth-url");
    expect(typeof env.symptom).toBe("string");
    expect(typeof env.fix).toBe("string");

    logs = [];
    seedBaseEnv(paths, "FRESHBOOKS_CLIENT_ID=cid-only\n");
    expect(await runHeadless(["--headless", "--auth-url", "--json"], paths)).toBe(
      EXIT.PRECONDITION,
    );
    env = envelope();
    expect(env.stepId).toBe("app-credentials");
  });

  it("cannot open a browser: the module imports no process spawner", () => {
    const source = readFileSync(join(defaultPaths().rootDir, "scripts/setup-headless.ts"), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("openBrowser");
  });
});

describe("emitters project onto the allowlist envelope", () => {
  const emit = { json: true };

  it("emitOk keeps declared success fields and drops anything else", () => {
    emitOk(emit, "add-login", {
      name: "main",
      company: "Acme",
      accountId: "ACC1",
      businessId: "1",
      profilePath: "/tmp/profiles/main.env",
      refreshToken: "rt-LEAK",
      accessToken: "at-LEAK",
    } as Record<string, unknown>);

    const env = envelope();
    expect(env).toEqual({
      ok: true,
      verb: "add-login",
      name: "main",
      company: "Acme",
      accountId: "ACC1",
      businessId: "1",
      profilePath: "/tmp/profiles/main.env",
    });
    expect(allOutput()).not.toContain("LEAK");
  });

  it("emitErr emits the fixed envelope plus allowlisted extras only", () => {
    emitErr(emit, "add-login", 6, "save-login", "sym", "fix it", "detail", {
      memberships: [{ label: "Acme", accountId: "ACC1", businessId: "1" }],
      stack: "Error: boom\n  at leak",
      config: { data: "client_secret=LEAK" },
    } as Record<string, unknown>);

    const env = envelope();
    expect(env).toEqual({
      ok: false,
      verb: "add-login",
      exitCode: 6,
      stepId: "save-login",
      symptom: "sym",
      fix: "fix it",
      message: "detail",
      memberships: [{ label: "Acme", accountId: "ACC1", businessId: "1" }],
    });
    expect(allOutput()).not.toContain("LEAK");
  });

  it("emitErr refuses to serialize an Error object handed to an allowlisted key", () => {
    const err = Object.assign(new Error("invalid_grant"), {
      config: { data: `client_secret=${CANARY_SECRET}` },
    });

    emitErr(emit, "add-login", 3, "save-login", "sym", "fix", "invalid_grant", {
      existingProfile: err as unknown as string,
    });

    const env = envelope();
    expect(env).not.toHaveProperty("existingProfile");
    expectNoSecretMaterial(allOutput(), CANARY_SECRET);
  });

  it("writes human output to stderr and JSON to stdout, never both", () => {
    emitOk({ json: false }, "init", { envPath: "/tmp/.env" });
    expect(stdout()).toBe("");
    expect(stderr()).toContain("/tmp/.env");

    logs = [];
    errs = [];
    emitErr({ json: false }, "init", 1, "app-credentials", "sym", "fix", "detail");
    expect(stdout()).toBe("");
    expect(stderr()).toContain("sym");
    expect(stderr()).toContain("fix");
  });
});
