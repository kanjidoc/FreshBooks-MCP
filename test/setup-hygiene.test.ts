import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { EXIT, emitErr, emitOk, runHeadless, type SetupPaths } from "../scripts/setup-headless";
import {
  buildOAuthClient,
  buildTokenClient,
  claudeMcpAddJson,
  discoverMemberships,
  exchangeCode,
  isClaudeCliAvailable,
  pendingPath,
  saveProfile,
  stagePending,
  type Memberships,
} from "../scripts/setup-core";

/**
 * THE TOKEN-HYGIENE SWEEP — every headless verb, success AND failure.
 *
 * The per-verb suites each assert hygiene for the paths they exercise. This one
 * is the cross-cutting net: one fixture family of canary credentials, driven
 * through EVERY verb in BOTH output modes, with a single unconditional sweep of
 * both captured streams after every test. A future edit that reintroduces a
 * credential on any surface fails here even if it was added to a verb whose own
 * suite forgot to look.
 *
 * ZERO SANCTIONED EXCEPTIONS. Project-wide there is exactly one place allowed to
 * print token material — `persistTokens`' last-resort stderr print when even the
 * rescue write fails — and it lives in `src/freshbooks-client.ts`, asserted by
 * `test/rescue-lifecycle.test.ts` test (b). It is NOT on this surface (a
 * structural test below proves the headless modules never reach it), so the
 * sweep in `afterEach` runs for every test in this file with no opt-out: there
 * is no allow-list, no per-test escape, and no assertion here that any token may
 * be printed. The refresh CLIs have their own equivalent net
 * (`test/refresh-tokens-redaction.test.ts`) and are deliberately not repeated.
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` over a throwaway
 * `SetupPaths` rooted in a fresh temp dir — the developer's real `.env`,
 * `profiles/`, `.mcp.json`, `~/.claude.json`, Claude Desktop config and
 * `.server.lock` are never read or written. `scripts/setup-core` is mocked at
 * every point that would reach FreshBooks or spawn the `claude` CLI, so nothing
 * here makes a network call or starts a process.
 */

// ---------------------------------------------------------------------------
// Canaries — every credential these fixtures put on disk or into a stub
// ---------------------------------------------------------------------------

/**
 * A realistic 3-segment base64url JWT with a distinctive canary in the payload
 * AND the signature (the `test/refresh-tokens-redaction.test.ts` fixture shape).
 * `exp` is real, so `decodeJwtExp` / `inspectTokenHealth` / the staged-token
 * staleness check all read these the way they read a live token.
 */
function canaryJwt(expSecondsFromNow: number, tag: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT" });
  const payload = enc({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    leak_canary: `CANARY-${tag}-DO-NOT-PRINT`,
  });
  const signature = Buffer.from(`SIGNATURE-CANARY-${tag}-NEVER-EMIT`).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The shared app secret in the base `.env`. */
const APP_SECRET = "CANARY-APP-SECRET-2f7b1e9c-DO-NOT-PRINT";
/** The single-use authorization code inside a pasted callback address. */
const AUTH_CODE = "CANARY-AUTH-CODE-8d34a05f-DO-NOT-PRINT";
/** A neighbouring MCP connector's API key, sitting in the Claude config. */
const FOREIGN_KEY = "CANARY-FOREIGN-KEY-0e7c31b9-DO-NOT-PRINT";

/** The pair a fresh exchange mints. */
const ACCESS = canaryJwt(3600, "ACCESS-FRESH-4d81ba62");
const REFRESH = "CANARY-REFRESH-FRESH-7b4c9e05-DO-NOT-PRINT";
/** The pair an interrupted run left staged. */
const STAGED_ACCESS = canaryJwt(3600, "STAGED-FRESH-4e91b703");
const STAGED_ACCESS_EXPIRED = canaryJwt(-3600, "STAGED-DEAD-7a35c018");
const STAGED_REFRESH = "CANARY-REFRESH-STAGED-6d02f4a1-DO-NOT-PRINT";
/** The pair FreshBooks hands back when a resume renews an expired staged pair. */
const ROTATED_ACCESS = canaryJwt(3600, "ROTATED-8c73e1d4");
const ROTATED_REFRESH = "CANARY-REFRESH-ROTATED-2b58a9c7-DO-NOT-PRINT";
/** The pair an already-saved profile carries. */
const SAVED_ACCESS = canaryJwt(3600, "SAVED-51ac9e77");
const SAVED_REFRESH = "CANARY-REFRESH-SAVED-93e15caf-DO-NOT-PRINT";
/** The pair a lingering `<file>.rescue` holds. */
const RESCUE_ACCESS = canaryJwt(3600, "RESCUE-70bd25e8");
const RESCUE_REFRESH = "CANARY-REFRESH-RESCUE-7d40b8ae-DO-NOT-PRINT";
/** The pair an unmigrated legacy base `.env` still holds. */
const LEGACY_ACCESS = canaryJwt(3600, "LEGACY-b3d74019");
const LEGACY_REFRESH = "CANARY-REFRESH-LEGACY-6b28d05f-DO-NOT-PRINT";

/** Everything above. No test in this file may print a fragment of any of them. */
const CANARIES = [
  APP_SECRET,
  AUTH_CODE,
  FOREIGN_KEY,
  ACCESS,
  REFRESH,
  STAGED_ACCESS,
  STAGED_ACCESS_EXPIRED,
  STAGED_REFRESH,
  ROTATED_ACCESS,
  ROTATED_REFRESH,
  SAVED_ACCESS,
  SAVED_REFRESH,
  RESCUE_ACCESS,
  RESCUE_REFRESH,
  LEGACY_ACCESS,
  LEGACY_REFRESH,
];

/**
 * Assert `output` contains no contiguous fragment of `secret`. Checked with a
 * sliding 8-character window over the whole value (segments AND dots), so a
 * suffix, a prefix, or one JWT segment trips it just as loudly as a whole-value
 * echo. Copied from `test/refresh-tokens-redaction.test.ts` on purpose: the two
 * nets must agree on what "no token material" means.
 */
function expectNoSecretMaterial(output: string, secret: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + WINDOW));
  }
}

/** The whole canary family, swept out of one string. */
function expectNoCanaryMaterial(output: string): void {
  for (const canary of CANARIES) expectNoSecretMaterial(output, canary);
}

// ---------------------------------------------------------------------------
// The rejection shape that motivates the allowlist
// ---------------------------------------------------------------------------

/**
 * What an axios/SDK rejection actually carries: the REQUEST BODY hangs off
 * `err.config.data` — `client_secret`, the authorization `code`, the
 * `refresh_token` — and the bearer token off `config.headers.Authorization`,
 * with the response body alongside. `err.message` is the only benign part.
 *
 * Anything that serialized this object, or handed it to an emitter under an
 * allowlisted key, would put all four credentials on stdout. Every stubbed
 * failure in this file rejects with one of these rather than a bare `Error`, so
 * the assertions prove the projection drops it rather than that the fixture had
 * nothing to leak.
 */
function rejectionWithCanaryBody(message: string): Error {
  return Object.assign(new Error(message), {
    name: "AxiosError",
    statusCode: "400",
    config: {
      url: "https://api.freshbooks.com/auth/oauth/token",
      data:
        "grant_type=authorization_code&client_id=cid-123" +
        `&client_secret=${APP_SECRET}&code=${AUTH_CODE}&refresh_token=${REFRESH}`,
      headers: { Authorization: `Bearer ${ACCESS}` },
    },
    response: {
      status: 400,
      data: { error: "invalid_grant", access_token: ACCESS, refresh_token: REFRESH },
    },
  });
}

// ---------------------------------------------------------------------------
// Mocks: everything that would reach FreshBooks or spawn a process
// ---------------------------------------------------------------------------

vi.mock("../scripts/setup-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/setup-core")>();
  return {
    ...actual,
    // Network.
    buildOAuthClient: vi.fn(),
    buildTokenClient: vi.fn(),
    exchangeCode: vi.fn(),
    discoverMemberships: vi.fn(),
    // The only two process spawners this surface can reach (`runBuild` is the
    // third in the project, and only the wizard calls it).
    isClaudeCliAvailable: vi.fn(),
    claudeMcpAddJson: vi.fn(),
    // Real by default — overridden once, to simulate an unexpected throw.
    saveProfile: vi.fn(),
  };
});

const core = await vi.importActual<typeof import("../scripts/setup-core")>("../scripts/setup-core");

/** The stub objects the mocked builders hand back in place of a `Client`. */
const OAUTH_CLIENT = { stub: "oauth-client" } as unknown as ReturnType<typeof buildOAuthClient>;
const TOKEN_CLIENT = { stub: "token-client" } as unknown as ReturnType<typeof buildTokenClient>;

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

const roots: string[] = [];
let logs: string[];
let errs: string[];

/** The `--json` channel. */
const stdout = () => logs.join("\n");
/** The human channel. */
const stderr = () => errs.join("\n");
/** Both streams — the surface an agent transcript sees. */
const allOutput = () => [...logs, ...errs].join("\n");

/** The single JSON object a `--json` run printed. */
function envelope(): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_CREDENTIALS =
  "FRESHBOOKS_CLIENT_ID=cid-123\n" +
  `FRESHBOOKS_CLIENT_SECRET=${APP_SECRET}\n` +
  "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n";

/** The legacy single-login state: app credentials PLUS tokens, no marker. */
const LEGACY_ENV =
  APP_CREDENTIALS +
  `FRESHBOOKS_ACCESS_TOKEN=${LEGACY_ACCESS}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=${LEGACY_REFRESH}\n` +
  "FRESHBOOKS_ACCOUNT_ID=AC-LEGACY\n";

/** Write a credential-bearing file the way the real writers do: 0600. */
function writeSecret(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface FixtureOpts {
  /** `dist/index.js` exists (the build precondition). Default true. */
  built?: boolean;
  /** `node_modules/` exists (the doctor's npm-install check). Default true. */
  installed?: boolean;
  /** Base `.env` contents; `""` writes no file at all. */
  baseEnv?: string;
}

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(opts: FixtureOpts = {}): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-hygiene-"));
  roots.push(rootDir);
  if (opts.built !== false) {
    mkdirSync(join(rootDir, "dist"), { recursive: true });
    writeFileSync(join(rootDir, "dist", "index.js"), "// pretend build output\n");
  }
  if (opts.installed !== false) mkdirSync(join(rootDir, "node_modules"), { recursive: true });
  if (opts.baseEnv !== "") writeSecret(join(rootDir, ".env"), opts.baseEnv ?? APP_CREDENTIALS);
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: join(rootDir, "claude_desktop_config.json"),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(rootDir, "dot-claude.json"),
  };
}

interface ProfileOpts {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  businessId?: string;
}

/** Seed `profiles/<name>.env`, 0600, the way the guarded writer leaves it. */
function seedProfile(paths: SetupPaths, name: string, opts: ProfileOpts = {}): string {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeSecret(
    path,
    `FRESHBOOKS_ACCESS_TOKEN=${opts.accessToken ?? SAVED_ACCESS}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=${opts.refreshToken ?? SAVED_REFRESH}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${opts.accountId ?? "AC-1"}\n` +
      `FRESHBOOKS_BUSINESS_ID=${opts.businessId ?? "9001"}\n`,
  );
  return path;
}

/** Stage a pending under `name`, as an interrupted run would have left it. */
function stage(
  paths: SetupPaths,
  name: string,
  mode: "add" | "reauth",
  accessToken = STAGED_ACCESS,
  refreshToken = STAGED_REFRESH,
): void {
  stagePending(paths.profilesDir, name, {
    mode,
    stagedAt: new Date().toISOString(),
    accessToken,
    refreshToken,
  });
}

/** A `discoverMemberships` result with the given business list. */
function memberships(list: Memberships["list"]): Memberships {
  return { user: { firstName: "Ada", lastName: "L", email: "ada@example.com" }, list };
}

const ACME = { label: "Acme Inc", accountId: "AC-1", businessId: "9001" };
const BETA = { label: "Beta LLC", accountId: "AC-2", businessId: "9002" };

/** Write one Claude config holding a freshbooks entry plus a foreign neighbour. */
function seedConfig(configPath: string, entry: { command: string; args: string[] } | null): void {
  const servers: Record<string, unknown> = {
    other: {
      command: "/opt/other/bin/other-server",
      args: ["--serve"],
      env: { OTHER_API_KEY: FOREIGN_KEY },
    },
  };
  if (entry) servers.freshbooks = entry;
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

/** Age a file on disk by `ms` — the staleness clocks read mtime. */
function ageFile(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

/** A pasted callback address carrying the canary authorization code. */
const CALLBACK = `https://localhost/callback?code=${AUTH_CODE}`;

// ---------------------------------------------------------------------------

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
  vi.mocked(isClaudeCliAvailable).mockReturnValue(false);
  vi.mocked(saveProfile).mockImplementation(core.saveProfile);
});

afterEach(() => {
  try {
    // THE SWEEP. Unconditional, every test, both streams, every canary — this
    // is the file's whole contract, and there is deliberately no way for a test
    // to opt out of it.
    expectNoCanaryMaterial(allOutput());
  } finally {
    // A failed sweep must still take the canary-bearing temp trees with it:
    // leaving credential-shaped files in the system temp dir is precisely the
    // outcome this file exists to prevent.
    vi.restoreAllMocks();
    while (roots.length) {
      const root = roots.pop()!;
      // A permission fixture may have left a directory read-only; re-open it so
      // the temp tree can actually be removed.
      const locked = join(root, "locked");
      if (existsSync(locked)) chmodSync(locked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------

describe("the sweep itself", () => {
  it("catches a planted leak, whole or partial", () => {
    // Guards the guard: if `expectNoSecretMaterial` were broken, every test in
    // this file would pass vacuously.
    expect(() => expectNoSecretMaterial(`prefix ${REFRESH} suffix`, REFRESH)).toThrow();
    expect(() => expectNoSecretMaterial(`...${REFRESH.slice(-12)}`, REFRESH)).toThrow();
    expect(() => expectNoSecretMaterial(ACCESS.split(".")[1], ACCESS)).toThrow();
    expect(() => expectNoCanaryMaterial(`leaked: ${APP_SECRET}`)).toThrow();
  });

  it("covers every canary the fixtures can put on disk", () => {
    // A canary nobody sweeps is a hole in the net. Each value is distinct and
    // long enough for an 8-character window to be meaningful.
    expect(new Set(CANARIES).size).toBe(CANARIES.length);
    for (const canary of CANARIES) expect(canary.length).toBeGreaterThan(24);
  });

  it("the sanctioned last-resort print is unreachable from this surface", () => {
    // Project-wide there is exactly one place allowed to print token material —
    // `persistTokens` in `src/freshbooks-client.ts`, asserted by
    // `test/rescue-lifecycle.test.ts` test (b). It is module-PRIVATE, so no
    // headless verb can call it, and what the two headless modules do borrow
    // from that file is three pure functions that print nothing. That is what
    // makes "zero sanctioned exceptions" a structural property of this suite
    // rather than a promise.
    const root = resolve(__dirname, "..");
    const client = readFileSync(join(root, "src", "freshbooks-client.ts"), "utf8");
    expect(client).toMatch(/^function persistTokens\(/m);
    expect(client).not.toMatch(/^export (?:async )?function persistTokens\b/m);
    // Declaring it privately and re-exporting it at the bottom is the same
    // thing with an extra line, so the export-list forms are refused too.
    expect(client, "persistTokens is re-exported").not.toMatch(
      /^export\s*\{[^}]*\bpersistTokens\b/m,
    );
    expect(client, "persistTokens is the default export").not.toMatch(
      /^export\s+default\s+persistTokens\b/m,
    );

    /**
     * The named imports one module takes from `src/freshbooks-client` — ALL of
     * them. A second import statement from the same module is legal TypeScript,
     * so reading only the first would let a later borrow in unseen.
     */
    const borrowed = (source: string): string[] => {
      const statements = [
        ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/src\/freshbooks-client"/g),
      ];
      // Every import of that module must be a named-brace one: a namespace or
      // default import would reach past this list entirely.
      const all = [...source.matchAll(/from\s*"\.\.\/src\/freshbooks-client"/g)];
      expect(statements.length, "a non-named import of src/freshbooks-client").toBe(all.length);
      return statements
        .flatMap((m) => m[1].split(","))
        .map((name) => name.trim())
        .filter(Boolean)
        .sort();
    };

    expect(borrowed(readFileSync(join(root, "scripts", "setup-headless.ts"), "utf8"))).toEqual([
      "decodeJwtExp",
      "inspectTokenHealth",
    ]);
    expect(borrowed(readFileSync(join(root, "scripts", "setup-core.ts"), "utf8"))).toEqual([
      "applyTokensToEnv",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("--init", () => {
  it("succeeds from a secret file in both modes without echoing the secret", async () => {
    const paths = fixture({ baseEnv: "" });
    const secretFile = join(paths.rootDir, ".client-secret.tmp");
    writeSecret(secretFile, `${APP_SECRET}\n`);

    const jsonCode = await runHeadless(
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

    expect(jsonCode).toBe(EXIT.OK);
    expect(envelope()).toEqual({ ok: true, verb: "init", envPath: paths.baseEnvPath });
    // The secret landed in the file and the scratch copy is gone.
    expect(readFileSync(paths.baseEnvPath, "utf8")).toContain(APP_SECRET);
    expect(existsSync(secretFile)).toBe(false);

    // The human render is a separate code path — sweep it too.
    writeSecret(secretFile, `${APP_SECRET}\n`);
    const humanCode = await runHeadless(
      ["--headless", "--init", "--client-id", "cid-123", "--client-secret-file", secretFile],
      paths,
    );
    expect(humanCode).toBe(EXIT.OK);
    expect(stderr()).toContain("init: OK");
  });

  it("keeps the secret off both streams when it arrives on stdin", async () => {
    const paths = fixture({ baseEnv: "" });
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([`${APP_SECRET}\n`]),
      configurable: true,
    });
    try {
      const code = await runHeadless(
        ["--headless", "--init", "--client-id", "cid-123", "--client-secret-stdin", "--json"],
        paths,
      );
      expect(code).toBe(EXIT.OK);
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
    expect(readFileSync(paths.baseEnvPath, "utf8")).toContain(APP_SECRET);
  });

  it("warns about the argv form without repeating the value it is warning about", async () => {
    const paths = fixture({ baseEnv: "" });

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid-123", "--client-secret", APP_SECRET, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(stderr()).toContain("visible to `ps`");
  });

  it("shreds an unread secret file on every pre-read refusal, silently", async () => {
    const paths = fixture({ baseEnv: "" });

    // (a) no --client-id
    const noId = join(paths.rootDir, "a.tmp");
    writeSecret(noId, `${APP_SECRET}\n`);
    expect(await runHeadless(["--headless", "--init", "--client-secret-file", noId], paths)).toBe(
      EXIT.USAGE,
    );
    expect(existsSync(noId)).toBe(false);

    // (b) two secret sources
    const twoSources = join(paths.rootDir, "b.tmp");
    writeSecret(twoSources, `${APP_SECRET}\n`);
    expect(
      await runHeadless(
        [
          "--headless",
          "--init",
          "--client-id",
          "cid",
          "--client-secret-file",
          twoSources,
          "--client-secret",
          APP_SECRET,
        ],
        paths,
      ),
    ).toBe(EXIT.USAGE);
    expect(existsSync(twoSources)).toBe(false);

    // (c) an empty secret file — read, shredded, then refused
    const empty = join(paths.rootDir, "c.tmp");
    writeSecret(empty, "\n");
    expect(
      await runHeadless(
        ["--headless", "--init", "--client-id", "cid", "--client-secret-file", empty, "--json"],
        paths,
      ),
    ).toBe(EXIT.USAGE);
    expect(existsSync(empty)).toBe(false);
  });

  it("reports an unwritable base .env by path, never by content", async () => {
    const paths = fixture({ baseEnv: "" });
    const locked = join(paths.rootDir, "locked");
    mkdirSync(locked);
    paths.baseEnvPath = join(locked, ".env");
    chmodSync(locked, 0o555);

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret", APP_SECRET, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.FAIL);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.stepId).toBe("app-credentials");
  });
});

// ---------------------------------------------------------------------------

describe("--auth-url", () => {
  it("builds the REAL authorization URL, which carries no client secret", async () => {
    // The one verb whose success path is safe to run unstubbed: it makes no
    // network call. Running it for real is what makes this assertion mean
    // something — a stubbed URL could not leak a secret it never saw.
    vi.mocked(buildOAuthClient).mockImplementation(core.buildOAuthClient);
    const paths = fixture();

    const code = await runHeadless(["--headless", "--auth-url", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.url).toContain("client_id=cid-123");
    expect(env.url).not.toContain("client_secret");
  });

  it("refuses with exit 7 and names the file, not its contents", async () => {
    const paths = fixture({ baseEnv: "" });

    const code = await runHeadless(["--headless", "--auth-url", "--json"], paths);

    expect(code).toBe(EXIT.PRECONDITION);
    expect(envelope().symptom).toContain(paths.baseEnvPath);
  });

  it("survives a URL builder that throws a credential-bearing rejection", async () => {
    const paths = fixture();
    vi.mocked(buildOAuthClient).mockImplementation(() => {
      throw rejectionWithCanaryBody("client construction failed");
    });

    const code = await runHeadless(["--headless", "--auth-url", "--json"], paths);

    expect(code).toBe(EXIT.FAIL);
    expect(envelope().message).toBe("client construction failed");
  });
});

// ---------------------------------------------------------------------------

describe("--add-login", () => {
  it("saves a login and prints neither half of the pair", async () => {
    const paths = fixture();

    const jsonCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );
    expect(jsonCode).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "add-login",
      name: "main",
      company: "Acme Inc",
      accountId: "AC-1",
      businessId: "9001",
      profilePath: join(paths.profilesDir, "main.env"),
    });
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain(ACCESS);
    expect(saved).toContain(REFRESH);
  });

  it("human mode leaves stdout empty — nothing can ride the parsed channel", async () => {
    const paths = fixture();

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("add-login: OK");
  });

  // ---- THE CONFIG.DATA CANARY: the reason the allowlist exists ----
  it("exit 3: an exchange rejection carrying config.data reaches NEITHER stream", async () => {
    const paths = fixture();
    vi.mocked(exchangeCode).mockRejectedValue(
      rejectionWithCanaryBody("Request failed with status code 400"),
    );

    const jsonCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(jsonCode).toBe(EXIT.CODE_REJECTED);
    const env = envelope();
    // The envelope is EXACTLY the fixed keys — the rejection contributed its
    // `message` and nothing else. No `config`, no `response`, no `statusCode`
    // (the call site passes `err.message`, never the object).
    expect(Object.keys(env).sort()).toEqual(
      ["exitCode", "fix", "message", "ok", "stepId", "symptom", "verb"].sort(),
    );
    expect(env.message).toBe("Request failed with status code 400");
    expect(JSON.stringify(env)).not.toContain("grant_type");
    expect(JSON.stringify(env)).not.toContain("Bearer");
    expectNoCanaryMaterial(JSON.stringify(env));
    // Nothing was staged: the exchange never produced a pair.
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);

    // The human render is a second, independent projection of the same failure.
    const humanCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );
    expect(humanCode).toBe(EXIT.CODE_REJECTED);
    expect(stderr()).toContain("Request failed with status code 400");
    expect(stderr()).not.toContain("grant_type");
  });

  it("exit 3: a callback address with no code is refused without echoing it", async () => {
    const paths = fixture();

    const code = await runHeadless(
      [
        "--headless",
        "--add-login",
        "--name",
        "main",
        "--callback-url",
        "https://localhost/callback",
        "--json",
      ],
      paths,
    );

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("exit 4: a taken nickname refuses before the code is spent", async () => {
    const paths = fixture();
    seedProfile(paths, "main");

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.NAME_TAKEN);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("exit 5: a duplicate pair names the file, never the token it duplicates", async () => {
    const paths = fixture();
    seedProfile(paths, "other", { accountId: "AC-9", refreshToken: REFRESH });

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.DUP_PAIR);
    const env = envelope();
    expect(env.message).toContain("profiles/other.env");
    expectNoCanaryMaterial(JSON.stringify(env));
  });

  it("exit 6: the memberships payload carries labels and ids, never tokens", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([ACME, BETA]));

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.BUSINESS_CHOICE);
    const env = envelope();
    expect(env.memberships).toEqual([ACME, BETA]);
    expectNoCanaryMaterial(JSON.stringify(env));
    // The staged pair survives for the resume — on disk, not on stdout.
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(true);
  });

  it("exit 8: the confirmation payload quotes the Book, not the pair", async () => {
    const paths = fixture();
    seedProfile(paths, "acme", { accountId: "AC-1", refreshToken: "rt-unrelated-acme" });

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.SAME_ACCOUNT);
    const env = envelope();
    expect(env.existingProfile).toBe("acme");
    expect(env.confirmQuestion).toContain("Acme Inc");
    expectNoCanaryMaterial(JSON.stringify(env));
  });

  it("exit 11: a discovery rejection carrying config.data is reduced to its message", async () => {
    const paths = fixture();
    vi.mocked(discoverMemberships).mockRejectedValue(
      rejectionWithCanaryBody("Request failed with status code 503"),
    );

    const jsonCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(jsonCode).toBe(EXIT.DISCOVERY_FAILED);
    expect(envelope().message).toBe("Request failed with status code 503");
    // The pair is on disk, staged and resumable — and nowhere else.
    expect(readFileSync(pendingPath(paths.profilesDir, "main"), "utf8")).toContain(REFRESH);

    const humanCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );
    expect(humanCode).toBe(EXIT.DISCOVERY_FAILED);
  });

  it("resume: renews an expired staged pair and prints neither the old nor the new one", async () => {
    const paths = fixture();
    stage(paths, "main", "add", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    vi.mocked(buildTokenClient).mockReturnValue({
      refreshAccessToken: vi.fn().mockResolvedValue({
        accessToken: ROTATED_ACCESS,
        refreshToken: ROTATED_REFRESH,
      }),
    } as unknown as ReturnType<typeof buildTokenClient>);

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    const saved = readFileSync(join(paths.profilesDir, "main.env"), "utf8");
    expect(saved).toContain(ROTATED_REFRESH);
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
  });

  it("resume: a rejected renewal exits 3 with its message only", async () => {
    const paths = fixture();
    stage(paths, "main", "add", STAGED_ACCESS_EXPIRED, STAGED_REFRESH);
    vi.mocked(buildTokenClient).mockReturnValue({
      refreshAccessToken: vi
        .fn()
        .mockRejectedValue(rejectionWithCanaryBody("staged grant is dead")),
    } as unknown as ReturnType<typeof buildTokenClient>);

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(envelope().message).toBe("staged grant is dead");
  });

  it("resume: exit 2 lists the staged nicknames, not what they hold", async () => {
    const paths = fixture();
    stage(paths, "acme", "add");

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("acme");
  });

  it("resume: refuses a pending staged by the other verb", async () => {
    const paths = fixture();
    seedProfile(paths, "main");
    stage(paths, "main", "reauth");

    const code = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().symptom).toContain("--reauth");
  });
});

// ---------------------------------------------------------------------------

describe("--reauth", () => {
  it("replaces the token lines in both modes without printing either pair", async () => {
    const paths = fixture();
    const profilePath = seedProfile(paths, "main", { accountId: "AC-1" });

    const jsonCode = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(jsonCode).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "reauth",
      name: "main",
      company: "Acme Inc",
      accountId: "AC-1",
      businessId: "9001",
      profilePath,
    });
    const after = readFileSync(profilePath, "utf8");
    expect(after).toContain(ACCESS);
    expect(after).not.toContain(SAVED_ACCESS);

    const humanPaths = fixture();
    seedProfile(humanPaths, "main", { accountId: "AC-1" });
    const humanCode = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK],
      humanPaths,
    );
    expect(humanCode).toBe(EXIT.OK);
    expect(stderr()).toContain("reauth: OK");
  });

  it("exit 2: an unknown nickname lists the saved names only", async () => {
    const paths = fixture();
    seedProfile(paths, "acme");

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("acme");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("exit 3: an exchange rejection with config.data is reduced to its message", async () => {
    const paths = fixture();
    seedProfile(paths, "main", { accountId: "AC-1" });
    vi.mocked(exchangeCode).mockRejectedValue(rejectionWithCanaryBody("code already used"));

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.CODE_REJECTED);
    expect(envelope().message).toBe("code already used");
  });

  it("exit 12: a wrong-account authorization is refused, pair kept on disk only", async () => {
    const paths = fixture();
    seedProfile(paths, "main", { accountId: "AC-1" });
    vi.mocked(discoverMemberships).mockResolvedValue(memberships([BETA]));

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.REAUTH_MISMATCH);
    expectNoCanaryMaterial(JSON.stringify(envelope()));
    // The staged pair is kept for a retry — on disk, not in the report.
    expect(readFileSync(pendingPath(paths.profilesDir, "main"), "utf8")).toContain(REFRESH);
    // The saved profile still holds its own family, untouched.
    expect(readFileSync(join(paths.profilesDir, "main.env"), "utf8")).toContain(SAVED_REFRESH);
  });

  it("exit 5: a pair another login already holds names the file, not the token", async () => {
    const paths = fixture();
    seedProfile(paths, "main", { accountId: "AC-1" });
    seedProfile(paths, "other", { accountId: "AC-9", refreshToken: REFRESH });

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.DUP_PAIR);
    expect(envelope().message).toContain("profiles/other.env");
  });

  it("exit 11: a discovery rejection with config.data is reduced to its message", async () => {
    const paths = fixture();
    seedProfile(paths, "main", { accountId: "AC-1" });
    vi.mocked(discoverMemberships).mockRejectedValue(rejectionWithCanaryBody("gateway timeout"));

    const code = await runHeadless(
      ["--headless", "--reauth", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.DISCOVERY_FAILED);
    expect(envelope().message).toBe("gateway timeout");
  });

  it("resume: nothing staged exits 2 without naming what is stored", async () => {
    const paths = fixture();
    seedProfile(paths, "main", { accountId: "AC-1" });

    const code = await runHeadless(["--headless", "--reauth", "--name", "main", "--json"], paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().symptom).toContain("Nothing is staged");
  });
});

// ---------------------------------------------------------------------------

describe("--install and --print-config", () => {
  it("merges around a neighbouring connector's key without reading it aloud", async () => {
    const paths = fixture();
    seedConfig(paths.desktopConfigPath, null);

    const code = await runHeadless(
      ["--headless", "--install", "desktop", "--trust-exec-path", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(env.target).toBe("desktop");
    // The neighbour survived the merge — in the file, and only there.
    expect(readFileSync(paths.desktopConfigPath, "utf8")).toContain(FOREIGN_KEY);
    expectNoCanaryMaterial(JSON.stringify(env));
  });

  it("exit 10: an unparseable config is DESCRIBED, never quoted", async () => {
    const paths = fixture();
    // A syntax error sitting two characters after the neighbour's secret: a
    // detail that quoted V8's window of the document would carry it out.
    writeFileSync(
      paths.desktopConfigPath,
      `{"mcpServers":{"other":{"env":{"OTHER_API_KEY":"${FOREIGN_KEY}"}}}},}`,
    );

    const jsonCode = await runHeadless(
      ["--headless", "--install", "desktop", "--trust-exec-path", "--json"],
      paths,
    );

    expect(jsonCode).toBe(EXIT.INSTALL_FAILED);
    const env = envelope();
    expect(env.configBlock).toContain("mcpServers");
    expect(env.path).toBe(paths.desktopConfigPath);
    expectNoCanaryMaterial(JSON.stringify(env));

    const humanCode = await runHeadless(
      ["--headless", "--install", "desktop", "--trust-exec-path"],
      paths,
    );
    expect(humanCode).toBe(EXIT.INSTALL_FAILED);
  });

  it("exit 10: a claude-CLI failure carrying config.data keeps its message only", async () => {
    const paths = fixture();
    vi.mocked(isClaudeCliAvailable).mockReturnValue(true);
    vi.mocked(claudeMcpAddJson).mockImplementation(() => {
      throw rejectionWithCanaryBody("claude mcp add-json exited 1");
    });

    const code = await runHeadless(
      ["--headless", "--install", "code", "--trust-exec-path", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.INSTALL_FAILED);
    expect(envelope().message).toBe("claude mcp add-json exited 1");
  });

  it("exit 7: an unbuilt project refuses before writing anything", async () => {
    const paths = fixture({ built: false });

    const code = await runHeadless(
      ["--headless", "--install", "desktop", "--trust-exec-path", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.PRECONDITION);
    expect(existsSync(paths.desktopConfigPath)).toBe(false);
  });

  it("--print-config emits a credential-free block for every target", async () => {
    const paths = fixture();
    seedConfig(paths.desktopConfigPath, null);

    const code = await runHeadless(
      ["--headless", "--print-config", "both", "--trust-exec-path", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(logs).toHaveLength(2);
    for (const line of logs) {
      const env = JSON.parse(line);
      // The entry is `{command, args}` by design — the deliberate absence of an
      // `env` block is what makes a printed config safe to show a user verbatim.
      expect(JSON.parse(env.configBlock).mcpServers.freshbooks).not.toHaveProperty("env");
      expectNoCanaryMaterial(line);
    }
  });

  it("--print-config refuses a bad target by echoing only the target", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--print-config", "nowhere", "--json"], paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().symptom).toContain("nowhere");
  });
});

// ---------------------------------------------------------------------------

describe("--discard-pending", () => {
  it("clears a staged pair and reports only its name", async () => {
    const paths = fixture();
    stage(paths, "main", "add");

    const code = await runHeadless(
      ["--headless", "--discard-pending", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(envelope()).toEqual({
      ok: true,
      verb: "discard-pending",
      name: "main",
      discarded: true,
    });
    expect(existsSync(pendingPath(paths.profilesDir, "main"))).toBe(false);
    expect(stderr()).toContain("does not revoke the grant");
  });

  it("clears a DAMAGED pending — the file `loadPending` refuses to read", async () => {
    const paths = fixture();
    mkdirSync(paths.profilesDir, { recursive: true });
    // Tokens on disk, markers gone: `listPendings` reports it, `loadPending`
    // will not resume it, and this verb exists precisely to clear it.
    writeSecret(
      pendingPath(paths.profilesDir, "damaged"),
      `FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}\n`,
    );

    const code = await runHeadless(
      ["--headless", "--discard-pending", "--name", "damaged", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.OK);
    expect(existsSync(pendingPath(paths.profilesDir, "damaged"))).toBe(false);
  });

  it("exit 2: nothing staged under that name lists the names that are", async () => {
    const paths = fixture();
    stage(paths, "acme", "reauth");

    const code = await runHeadless(
      ["--headless", "--discard-pending", "--name", "main", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().fix).toContain("acme");
  });
});

// ---------------------------------------------------------------------------

describe("--doctor", () => {
  /**
   * Everything wrong at once: an unmigrated legacy `.env`, an unbuilt and
   * uninstalled project, a lingering `.client-secret.tmp`, a healthy login, a
   * same-account collision, a malformed profile file, a duplicate-token file, a
   * fresh pending, a DAMAGED pending (T12), rescue files in both locations
   * (T12), a loose credential file, and a config entry that cannot start —
   * with a neighbouring connector's key sitting in that same config.
   */
  function worstFixture(): SetupPaths {
    const paths = fixture({ built: false, installed: false, baseEnv: LEGACY_ENV });

    seedProfile(paths, "main", { accountId: "AC-1" });
    seedProfile(paths, "acme", { accountId: "AC-1", refreshToken: "rt-unrelated-acme" });
    seedProfile(paths, "dup", { accountId: "AC-3", refreshToken: SAVED_REFRESH });
    writeSecret(join(paths.profilesDir, "broken.env"), "FRESHBOOKS_ACCOUNT_ID=AC-9\n");
    // A world-readable credential file — the permission check's warn branch.
    writeFileSync(join(paths.profilesDir, "loose.env"), `FRESHBOOKS_REFRESH_TOKEN=${REFRESH}\n`, {
      mode: 0o644,
    });
    chmodSync(join(paths.profilesDir, "loose.env"), 0o644);

    stage(paths, "fresh", "add");
    // T12's damaged pending: tokens on disk, no mode marker, stale.
    const damaged = pendingPath(paths.profilesDir, "damaged");
    writeSecret(
      damaged,
      `FRESHBOOKS_ACCESS_TOKEN=${STAGED_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${STAGED_REFRESH}\n`,
    );
    ageFile(damaged, 40 * 60 * 60 * 1000);

    // T12's rescue files: one beside a profile, one beside the legacy base .env.
    const rescueBody = `FRESHBOOKS_ACCESS_TOKEN=${RESCUE_ACCESS}\nFRESHBOOKS_REFRESH_TOKEN=${RESCUE_REFRESH}\n`;
    writeSecret(join(paths.profilesDir, "main.env.rescue"), rescueBody);
    writeSecret(`${paths.baseEnvPath}.rescue`, rescueBody);

    writeFileSync(join(paths.rootDir, ".client-secret.tmp"), `${APP_SECRET}\n`);
    seedConfig(paths.mcpJsonPath, { command: "node", args: ["/gone/dist/index.js"] });
    return paths;
  }

  it("reports the worst fixture there is, in both modes, printing no credential", async () => {
    const paths = worstFixture();

    const humanCode = await runHeadless(["--headless", "--doctor"], paths);
    const jsonCode = await runHeadless(["--headless", "--doctor", "--json"], paths);

    expect(humanCode).toBe(EXIT.FAIL);
    expect(jsonCode).toBe(EXIT.FAIL);
    expect(stderr()).toContain("ISSUES FOUND");

    const report = JSON.parse(logs[0]);
    const ids: string[] = report.checks.map((c: { id: string }) => c.id);
    // Every T12 fixture is actually being exercised — otherwise this test would
    // sweep an output that never had the chance to leak.
    expect(ids).toContain("legacy-env");
    expect(ids).toContain("client-secret-tmp");
    expect(ids).toContain("staged-pending:damaged");
    expect(ids).toContain("rescue-file:main.env.rescue");
    expect(ids).toContain("rescue-file:.env.rescue");
    expect(ids).toContain("profile-file:broken.env");
    expect(ids).toContain("file-permissions");
    // The damaged pending can only be discarded — its mode is unreadable.
    const damaged = report.checks.find((c: { id: string }) => c.id === "staged-pending:damaged");
    expect(damaged.fix).toContain("--discard-pending --name damaged");

    // Belt and braces: the sweep also runs in afterEach, but a failure here
    // names the test that produced the leak.
    expectNoCanaryMaterial(allOutput());
    expectNoCanaryMaterial(JSON.stringify(report));
  });

  it("runs in the unmigrated state every other verb refuses, without echoing it", async () => {
    const paths = fixture({ baseEnv: LEGACY_ENV });
    seedProfile(paths, "main");

    const code = await runHeadless(["--headless", "--doctor", "--json"], paths);

    expect(code).toBe(EXIT.FAIL);
    const check = JSON.parse(logs[0]).checks.find((c: { id: string }) => c.id === "legacy-env");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(paths.baseEnvPath);
  });

  it("passes a clean install without naming a single credential value", async () => {
    const paths = fixture();
    seedProfile(paths, "main");
    seedConfig(paths.desktopConfigPath, {
      command: process.execPath,
      args: [join(paths.rootDir, "dist", "index.js")],
    });

    const code = await runHeadless(["--headless", "--doctor", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(logs[0]).ok).toBe(true);
  });

  // ---- T6 minor: the readdir → read race inside `listPendings` ----
  it.skipIf(process.platform === "win32")(
    "a pending that vanishes between readdir and read stays inside the envelope",
    async () => {
      const paths = fixture();
      seedProfile(paths, "main");
      seedConfig(paths.desktopConfigPath, {
        command: process.execPath,
        args: [join(paths.rootDir, "dist", "index.js")],
      });
      // A dangling symlink is the race made reproducible: `readdirSync` lists
      // the entry, `readFileSync` on it throws ENOENT — exactly what a pending
      // shredded by a concurrent `--discard-pending` between the two calls does.
      symlinkSync(join(paths.profilesDir, "gone-target"), pendingPath(paths.profilesDir, "ghost"));

      const code = await runHeadless(["--headless", "--doctor", "--json"], paths);

      // No raw ENOENT escaped: the run returned a code, stdout holds exactly one
      // well-formed doctor envelope, and the scan reported itself as a check.
      expect(typeof code).toBe("number");
      const report = envelope();
      expect(report.verb).toBe("doctor");
      const check = report.checks.find((c: { id: string }) => c.id === "staged-pendings");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("could not be listed");
      // The rest of the doctor still ran — one failing scan does not abort it.
      expect(report.checks.map((c: { id: string }) => c.id)).toContain("config");
    },
  );
});

// ---------------------------------------------------------------------------

describe("the dispatcher", () => {
  it("exit 9: the unmigrated refusal never echoes the legacy pair, and shreds the secret file", async () => {
    const paths = fixture({ baseEnv: LEGACY_ENV });
    const secretFile = join(paths.rootDir, ".client-secret.tmp");
    writeSecret(secretFile, `${APP_SECRET}\n`);

    const code = await runHeadless(
      ["--headless", "--init", "--client-id", "cid", "--client-secret-file", secretFile, "--json"],
      paths,
    );

    expect(code).toBe(EXIT.UNMIGRATED);
    expect(existsSync(secretFile)).toBe(false);
    expect(envelope().message).toContain(paths.baseEnvPath);
  });

  it("exit 2: an invocation that never parses still shreds the secret file", async () => {
    const paths = fixture({ baseEnv: "" });
    const secretFile = join(paths.rootDir, ".client-secret.tmp");
    writeSecret(secretFile, `${APP_SECRET}\n`);

    const code = await runHeadless(
      ["--headless", "--init", "--client-secret-file", secretFile, "--nonsense", "--json"],
      paths,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(existsSync(secretFile)).toBe(false);
    expect(envelope().message).toContain("--nonsense");
  });

  it("exit 2: a flag the verb does not take is refused by name only", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--doctor", "--name", "main", "--json"], paths);

    expect(code).toBe(EXIT.USAGE);
    expect(envelope().symptom).toContain("--name");
  });

  it("the catch-all reduces an unexpected credential-bearing throw to its message", async () => {
    const paths = fixture();
    // A non-`ProfileWriteError` escaping the save stage: `saveLogin` rethrows it
    // and `runHeadless`'s last line of defense is what turns it into an
    // envelope. Without that catch it would reach `main().catch()`, which prints
    // the OBJECT — `config.data` and all.
    vi.mocked(saveProfile).mockImplementation(() => {
      throw rejectionWithCanaryBody("disk exploded");
    });

    const jsonCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK, "--json"],
      paths,
    );

    expect(jsonCode).toBe(EXIT.FAIL);
    const env = envelope();
    expect(env.message).toBe("disk exploded");
    expect(Object.keys(env).sort()).toEqual(
      ["exitCode", "fix", "message", "ok", "stepId", "symptom", "verb"].sort(),
    );
    expectNoCanaryMaterial(JSON.stringify(env));

    const humanCode = await runHeadless(
      ["--headless", "--add-login", "--name", "main", "--callback-url", CALLBACK],
      paths,
    );
    expect(humanCode).toBe(EXIT.FAIL);
  });
});

// ---------------------------------------------------------------------------

describe("the emitters' projection", () => {
  it("drops an Error handed to an emitter under an allowlisted key", async () => {
    const err = rejectionWithCanaryBody("Request failed with status code 400");

    // Both emitters, both modes, at the top level AND nested one deep — the
    // projection's job is to refuse the value, not to trust the call site.
    emitOk({ json: true }, "add-login", {
      name: "main",
      profilePath: err as unknown as string,
      configBlock: { nested: err },
    });
    emitErr({ json: true }, "add-login", EXIT.CODE_REJECTED, "authorize", "s", "f", "m", {
      path: err as unknown as string,
      configBlock: { nested: err },
      memberships: [{ label: "Acme", accountId: "AC-1", businessId: "9001" }],
    });
    emitOk({ json: false }, "add-login", { name: "main", profilePath: err as unknown as string });

    const [ok, bad] = logs.map((line) => JSON.parse(line));
    expect(ok).toEqual({ ok: true, verb: "add-login", name: "main" });
    expect(bad).not.toHaveProperty("path");
    expect(bad).not.toHaveProperty("configBlock");
    expect(bad.memberships).toHaveLength(1);
    expect(stderr()).not.toContain("profilePath");
  });

  it("drops a value under a key that is not on the allowlist at all", async () => {
    emitOk({ json: true }, "add-login", {
      name: "main",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      client_secret: APP_SECRET,
    });

    expect(JSON.parse(logs[0])).toEqual({ ok: true, verb: "add-login", name: "main" });
  });
});
