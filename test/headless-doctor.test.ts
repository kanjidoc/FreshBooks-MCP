import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  parseNodeMajor,
  runDoctor,
  runHeadless,
  selectCommandPath,
  type DoctorCheck,
  type SetupPaths,
} from "../scripts/setup-headless";
import { stagePending } from "../scripts/setup-core";
import { MIGRATED_MARKER } from "../src/migrate";
import { SETUP_FLOW } from "../src/setup-flow";

/**
 * `--doctor`.
 *
 * SAFETY: every run drives `runHeadless(argv, paths)` / `runDoctor(paths)` over
 * a throwaway `SetupPaths` rooted in a fresh temp dir — the developer's real
 * `.env`, `profiles/`, `.mcp.json`, `~/.claude.json`, Claude Desktop config and
 * `.server.lock` are never read or written. The doctor makes no network call at
 * all, so nothing here is stubbed: every check runs for real against the temp
 * tree, which is the whole point.
 *
 * TOKEN HYGIENE: every token, app secret and rescue pair on disk in this file is
 * a canary, and `afterEach` sweeps BOTH captured streams with the 8-character
 * sliding window after every single test — so a doctor line that echoed any
 * fragment of a credential it read fails the test that produced it.
 */

// --- Canaries: everything this file writes to disk that must never be printed --

const APP_SECRET = "SECRET-CANARY-2b71f4e9-DO-NOT-PRINT-EVER";
const REFRESH_MAIN = "REFRESH-MAIN-CANARY-84c0e1d7-DO-NOT-PRINT-EVER";
const REFRESH_ACME = "REFRESH-ACME-CANARY-1fa93c62-DO-NOT-PRINT-EVER";
const REFRESH_RESCUE = "REFRESH-RESCUE-CANARY-7d40b8ae-DO-NOT-PRINT-EVER";
const REFRESH_PENDING = "REFRESH-PENDING-CANARY-93e15caf-DO-NOT-PRINT-EVER";
const REFRESH_LEGACY = "REFRESH-LEGACY-CANARY-6b28d05f-DO-NOT-PRINT-EVER";
const FOREIGN_CANARY = "FOREIGN-KEY-CANARY-0e7c31b9-DO-NOT-PRINT-EVER";

const NOW_SEC = Math.floor(Date.now() / 1000);

/**
 * A JWT-shaped access token whose `exp` decodes to `expSec` — what
 * `inspectTokenHealth` reads. `tag` rides inside the base64 payload as well as
 * both bookends, so every 8-character window is distinctive enough for the
 * canary sweep to be meaningful.
 */
function jwt(expSec: number, tag: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSec, canary: tag })).toString("base64url");
  return `HDR-${tag}.${payload}.SIG-${tag}`;
}

const ACCESS_FRESH = jwt(NOW_SEC + 3600, "ACCESS-FRESH-CANARY-4d81ba");
const ACCESS_EXPIRING = jwt(NOW_SEC + 120, "ACCESS-SOON-CANARY-3fe907");
const ACCESS_EXPIRED = jwt(NOW_SEC - 3600, "ACCESS-DEAD-CANARY-c62f18");
const ACCESS_OPAQUE = "ACCESS-OPAQUE-CANARY-a90e7b31-DO-NOT-PRINT-EVER";
/** Sub-minute either side of now — where the coarse formatter says "just now". */
const ACCESS_JUST_EXPIRED = jwt(NOW_SEC - 5, "ACCESS-JUST-DEAD-CANARY-1f7c22");
const ACCESS_JUST_ALIVE = jwt(NOW_SEC + 5, "ACCESS-JUST-ALIVE-CANARY-2b8d41");
const ACCESS_RESCUE = jwt(NOW_SEC + 3600, "ACCESS-RESCUE-CANARY-70bd25");
const ACCESS_PENDING = jwt(NOW_SEC + 3600, "ACCESS-PENDING-CANARY-51ac9e");
const ACCESS_LEGACY = jwt(NOW_SEC + 3600, "ACCESS-LEGACY-CANARY-b3d740");

const CANARIES = [
  APP_SECRET,
  REFRESH_MAIN,
  REFRESH_ACME,
  REFRESH_RESCUE,
  REFRESH_PENDING,
  REFRESH_LEGACY,
  FOREIGN_CANARY,
  ACCESS_FRESH,
  ACCESS_EXPIRING,
  ACCESS_EXPIRED,
  ACCESS_OPAQUE,
  ACCESS_JUST_EXPIRED,
  ACCESS_JUST_ALIVE,
  ACCESS_RESCUE,
  ACCESS_PENDING,
  ACCESS_LEGACY,
];

// --- The Book strings the doctor must quote rather than paraphrase ------------

const verifyStep = SETUP_FLOW.find((s) => s.id === "verify")!;
const migrateStep = SETUP_FLOW.find((s) => s.id === "migrate-legacy")!;
const buildStep = SETUP_FLOW.find((s) => s.id === "build")!;
const npmInstallStep = SETUP_FLOW.find((s) => s.id === "npm-install")!;
const saveLoginStep = SETUP_FLOW.find((s) => s.id === "save-login")!;

/** The sandbox hypothesis — `verify`'s missing-config row, verbatim. */
const SANDBOX_FIX = verifyStep.troubleshooting.find((t) =>
  t.symptom.includes("config entry missing"),
)!.fix;

/** The two-cause command warning — `verify`'s non-absolute-command row, verbatim. */
const TWO_CAUSE_FIX = verifyStep.troubleshooting.find((t) =>
  t.symptom.includes("command isn't an absolute path"),
)!.fix;

const QUARANTINE_FIX = saveLoginStep.troubleshooting.find((t) =>
  t.symptom.includes("quarantined profile mentioned"),
)!.fix;

// --- Streams -----------------------------------------------------------------

const roots: string[] = [];
let logs: string[];
let errs: string[];

const stdout = () => logs.join("\n");
const stderr = () => errs.join("\n");
const allOutput = () => [...logs, ...errs].join("\n");

/** Assert `output` contains no contiguous 8-char fragment of `secret`. */
function expectNoSecretMaterial(output: string, secret: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + WINDOW));
  }
}

// --- Fixtures ----------------------------------------------------------------

/** Write a credential-bearing file the way the real writers do: 0600. */
function writeSecret(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface FixtureOpts {
  /** `dist/index.js` exists (the build check). Default true. */
  built?: boolean;
  /** `node_modules/` exists (the npm-install check). Default true. */
  installed?: boolean;
  /** Contents of the base `.env`. Default: the app credentials, no tokens. */
  baseEnv?: string;
}

const APP_CREDENTIALS =
  "FRESHBOOKS_CLIENT_ID=cid-123\n" +
  `FRESHBOOKS_CLIENT_SECRET=${APP_SECRET}\n` +
  "FRESHBOOKS_REDIRECT_URI=https://localhost/callback\n";

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(opts: FixtureOpts = {}): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-doctor-"));
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
  /** Raw extra lines (e.g. the distinct-login marker). */
  extra?: string;
}

/** Seed `profiles/<name>.env`, 0600, the way the guarded writer leaves it. */
function seedProfile(paths: SetupPaths, name: string, opts: ProfileOpts = {}): string {
  mkdirSync(paths.profilesDir, { recursive: true });
  const path = join(paths.profilesDir, `${name}.env`);
  writeSecret(
    path,
    `FRESHBOOKS_ACCESS_TOKEN=${opts.accessToken ?? ACCESS_FRESH}\n` +
      `FRESHBOOKS_REFRESH_TOKEN=${opts.refreshToken ?? REFRESH_MAIN}\n` +
      `FRESHBOOKS_ACCOUNT_ID=${opts.accountId ?? "AC1"}\n` +
      `FRESHBOOKS_BUSINESS_ID=${opts.businessId ?? "9001"}\n` +
      (opts.extra ?? ""),
  );
  return path;
}

/** A launcher entry Claude could actually start: absolute command, real args[0]. */
function resolvableEntry(paths: SetupPaths): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(paths.rootDir, "dist", "index.js")] };
}

/** Write one config file holding a freshbooks entry (plus a foreign neighbour). */
function seedConfig(
  configPath: string,
  entry: { command: string; args: string[] } | null,
): void {
  const servers: Record<string, unknown> = {
    other: {
      command: "/opt/other/bin/other-server",
      args: ["--serve"],
      env: { OTHER_API_KEY: FOREIGN_CANARY },
    },
  };
  if (entry) servers.freshbooks = entry;
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

/** The all-green install: built, installed, credentialed, one login, one config. */
function healthy(): SetupPaths {
  const paths = fixture();
  seedProfile(paths, "main");
  seedConfig(paths.desktopConfigPath, resolvableEntry(paths));
  return paths;
}

/** Age a file on disk by `ms` — the staleness clocks read mtime. */
function ageFile(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Runners -----------------------------------------------------------------

/** Every JSON object a `--json` run printed, one per stdout line. */
function envelope(): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

/** Run the verb through the real dispatcher and parse its one JSON object. */
async function doctorJson(paths: SetupPaths): Promise<{ code: number; env: any }> {
  const code = await runHeadless(["--headless", "--doctor", "--json"], paths);
  return { code, env: envelope() };
}

function byId(checks: DoctorCheck[], id: string): DoctorCheck {
  const hit = checks.find((c) => c.id === id);
  expect(hit, `no check with id "${id}" in [${checks.map((c) => c.id).join(", ")}]`).toBeTruthy();
  return hit!;
}

function ids(checks: DoctorCheck[]): string[] {
  return checks.map((c) => c.id);
}

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
  // The blanket hygiene sweep: no test in this file may print any fragment of
  // any credential it put on disk, on either stream, pass or fail.
  const output = allOutput();
  for (const canary of CANARIES) expectNoSecretMaterial(output, canary);

  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------

describe("parseNodeMajor", () => {
  it("reads the major from both spellings and refuses nonsense", () => {
    expect(parseNodeMajor("18.20.4")).toBe(18);
    expect(parseNodeMajor("v20.11.1")).toBe(20);
    expect(parseNodeMajor("22")).toBe(22);
    expect(parseNodeMajor("not-a-version")).toBeNull();
    expect(parseNodeMajor("")).toBeNull();
  });
});

describe("--doctor: the healthy install", () => {
  it("passes every check and exits 0", async () => {
    const paths = healthy();

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    expect(env.ok).toBe(true);
    expect(Object.keys(env).sort()).toEqual(["checks", "ok", "verb"]);
    expect(env.verb).toBe("doctor");

    const failing = (env.checks as DoctorCheck[]).filter((c) => c.status !== "pass");
    expect(failing).toEqual([]);
    // Every check the spec's `--doctor` row enumerates is present.
    expect(ids(env.checks)).toEqual([
      "node-version",
      "node-modules",
      "build",
      "app-credentials",
      "client-secret-tmp",
      "legacy-env",
      "profiles",
      "profile:main",
      "staged-pendings",
      "rescue-files",
      "file-permissions",
      "config",
    ]);
  });

  it("keys every check to a real Book step and fills the whole shape", async () => {
    const paths = healthy();
    const bookIds = SETUP_FLOW.map((s) => s.id);

    const report = runDoctor(paths);

    expect(report.ok).toBe(true);
    for (const check of report.checks) {
      expect(bookIds).toContain(check.stepId);
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
      expect(typeof check.fix).toBe("string");
    }
    expect(byId(report.checks, "node-version").stepId).toBe("node-install");
    expect(byId(report.checks, "node-modules").stepId).toBe("npm-install");
    expect(byId(report.checks, "build").stepId).toBe("build");
    expect(byId(report.checks, "app-credentials").stepId).toBe("app-credentials");
    expect(byId(report.checks, "legacy-env").stepId).toBe("migrate-legacy");
    expect(byId(report.checks, "profiles").stepId).toBe("save-login");
    expect(byId(report.checks, "config").stepId).toBe("install-config");
  });

  it("writes the human report to stderr and nothing to stdout", async () => {
    const paths = healthy();

    const code = await runHeadless(["--headless", "--doctor"], paths);

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("pass");
    expect(stderr()).toContain("profile:main");
    // The Book's verify humanScript promises "Every line should say pass".
    expect(stderr()).not.toContain("fail");
  });

  it("rejects flags --doctor does not take", async () => {
    const paths = healthy();

    expect(await runHeadless(["--headless", "--doctor", "--name", "main"], paths)).toBe(EXIT.USAGE);
    expect(stdout()).toBe("");
  });
});

describe("--doctor: bootstrap checks", () => {
  it("fails a missing build with the Book's own fix", async () => {
    const paths = fixture({ built: false });
    seedProfile(paths, "main");

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    expect(code).toBe(1);
    expect(env.ok).toBe(false);
    const check = byId(env.checks, "build");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("build");
    expect(check.fix).toBe(buildStep.troubleshooting[0].fix);
  });

  it("fails a missing node_modules with the Book's own fix", async () => {
    const paths = fixture({ installed: false });
    seedProfile(paths, "main");

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "node-modules");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("npm-install");
    expect(check.fix).toBe(npmInstallStep.troubleshooting[0].fix);
  });

  it("passes the node check on this runtime", async () => {
    const { env } = await doctorJson(healthy());

    const check = byId(env.checks, "node-version");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(process.versions.node);
  });

  it("fails a node older than 18 without naming a Book fix it does not have", () => {
    const check = byId(runDoctor(healthy(), "16.20.2").checks, "node-version");

    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("node-install");
    expect(check.detail).toContain("16.20.2");
    expect(check.fix).toContain("nodejs.org");
  });
});

describe("--doctor: the base .env", () => {
  it("fails when the base .env is missing", async () => {
    const paths = fixture({ baseEnv: "" });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "app-credentials");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(paths.baseEnvPath);
    expect(check.fix).toContain("--init");
  });

  it("names the missing KEY and never the values it did read", async () => {
    const paths = fixture({ baseEnv: `FRESHBOOKS_CLIENT_SECRET=${APP_SECRET}\n` });

    const { env } = await doctorJson(paths);

    const check = byId(env.checks, "app-credentials");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("FRESHBOOKS_CLIENT_ID");
    expect(check.detail).not.toContain("FRESHBOOKS_CLIENT_SECRET=");
    expectNoSecretMaterial(JSON.stringify(env), APP_SECRET);
  });

  it("warns about a lingering .client-secret.tmp without reading it", async () => {
    const paths = healthy();
    writeFileSync(join(paths.rootDir, ".client-secret.tmp"), `${APP_SECRET}\n`);

    const { code, env } = await doctorJson(paths);

    // A warn is advisory: it must not turn a working install into exit 1.
    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "client-secret-tmp");
    expect(check.status).toBe("warn");
    expect(check.stepId).toBe("app-credentials");
    expect(check.detail).toContain(".client-secret.tmp");
    expect(check.fix).toContain("Delete");
  });
});

describe("--doctor: the unmigrated legacy .env", () => {
  const LEGACY_ENV =
    APP_CREDENTIALS +
    `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_LEGACY}\n` +
    `FRESHBOOKS_REFRESH_TOKEN=${REFRESH_LEGACY}\n`;

  it("RUNS in the state every other verb refuses, and reports it as a check", async () => {
    const paths = fixture({ baseEnv: LEGACY_ENV });
    seedConfig(paths.desktopConfigPath, resolvableEntry(paths));

    const { code, env } = await doctorJson(paths);

    // Not exit 9: the doctor is the verb the exit-9 refusal tells the agent to
    // resume with, and it writes nothing, so refusing it would make the state
    // undiagnosable.
    expect(code).toBe(EXIT.FAIL);
    expect(code).not.toBe(EXIT.UNMIGRATED);
    const check = byId(env.checks, "legacy-env");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("migrate-legacy");
    expect(check.fix).toBe(migrateStep.agentGuidance);
  });

  it("passes once the migrated marker is present", async () => {
    const paths = healthy();
    writeSecret(paths.baseEnvPath, `${APP_CREDENTIALS}${MIGRATED_MARKER}=1\n`);

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    expect(byId(env.checks, "legacy-env").status).toBe("pass");
  });
});

describe("--doctor: profiles", () => {
  it("fails with the save-login step when no login is configured", async () => {
    const paths = fixture();
    seedConfig(paths.desktopConfigPath, resolvableEntry(paths));

    const { code, env } = await doctorJson(paths);

    // Never exit 2 — that is this CLI's usage code, and zero profiles is a
    // failing check, not a bad invocation.
    expect(code).toBe(EXIT.FAIL);
    expect(code).not.toBe(EXIT.USAGE);
    const check = byId(env.checks, "profiles");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("save-login");
    expect(check.fix).toContain("--add-login");
  });

  it("warns on an access token inside the refresh window", async () => {
    const paths = healthy();
    seedProfile(paths, "main", { accessToken: ACCESS_EXPIRING });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "profile:main");
    expect(check.status).toBe("warn");
    expect(check.stepId).toBe("save-login");
    expect(check.fix).toContain("refresh-tokens");
  });

  it("warns on an already-expired access token", async () => {
    const paths = healthy();
    seedProfile(paths, "main", { accessToken: ACCESS_EXPIRED });

    const { env } = await doctorJson(paths);

    const check = byId(env.checks, "profile:main");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("expired");
  });

  it("says when a token expired seconds ago without saying 'just now ago'", async () => {
    const paths = healthy();
    // Sub-minute either side of now is where the coarse duration formatter
    // answers with an instant ("just now"), which cannot take "… ago" or "in …".
    seedProfile(paths, "main", { accessToken: ACCESS_JUST_EXPIRED });
    seedProfile(paths, "acme", {
      accessToken: ACCESS_JUST_ALIVE,
      refreshToken: REFRESH_ACME,
      accountId: "AC2",
    });

    const checks = runDoctor(paths).checks;

    expect(byId(checks, "profile:main").detail).toContain("expired just now");
    expect(byId(checks, "profile:main").detail).not.toContain("just now ago");
    expect(byId(checks, "profile:acme").detail).not.toContain("in just now");
  });

  it("warns when the access token carries no readable expiry", async () => {
    const paths = healthy();
    seedProfile(paths, "main", { accessToken: ACCESS_OPAQUE });

    const check = byId(runDoctor(paths).checks, "profile:main");

    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/expiry/i);
  });

  it("fails a malformed profile file and names it", async () => {
    const paths = healthy();
    mkdirSync(paths.profilesDir, { recursive: true });
    // Parse-fail: an editor backup / half-written file with no token pair.
    writeSecret(join(paths.profilesDir, "broken.env"), "FRESHBOOKS_ACCOUNT_ID=AC9\n");

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "profile-file:broken.env");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("save-login");
    expect(check.detail).toContain("broken.env");
    expect(check.fix).toContain("--add-login");
    // The malformed file is not counted as a login.
    expect(ids(env.checks)).not.toContain("profile:broken");
  });

  it("fails two files that share one refresh token, and explains why", async () => {
    const paths = healthy();
    // Named to sort AFTER main.env: discovery keeps the first file it sees and
    // excludes the later one, so this is the copy the doctor should name.
    seedProfile(paths, "zcopy", { refreshToken: REFRESH_MAIN, accountId: "AC1" });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    expect(byId(env.checks, "profile:main").status).toBe("pass");
    const check = byId(env.checks, "profile-file:zcopy.env");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("main.env");
    expect(check.detail).toContain("lockout");
  });

  it("fails a quarantined profile with the Book's fix and names the collision", async () => {
    const paths = healthy();
    seedProfile(paths, "acme", { refreshToken: REFRESH_ACME, accountId: "AC1" });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "profile:acme");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("main.env");
    expect(check.fix).toContain(QUARANTINE_FIX);
    expect(check.fix).toContain("# freshbooks-distinct-login");
  });
});

describe("--doctor: staged pendings", () => {
  it("passes a fresh pending and prints its bare resume command", async () => {
    const paths = healthy();
    stagePending(paths.profilesDir, "acme", {
      mode: "add",
      stagedAt: new Date().toISOString(),
      accessToken: ACCESS_PENDING,
      refreshToken: REFRESH_PENDING,
    });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "staged-pending:acme");
    expect(check.status).toBe("pass");
    expect(check.stepId).toBe("save-login");
    expect(check.fix).toContain("--add-login --name acme");
    expect(check.fix).toContain("--discard-pending --name acme");
  });

  it("warns past 24 h — mode add resumes with --add-login", async () => {
    const paths = healthy();
    stagePending(paths.profilesDir, "acme", {
      mode: "add",
      stagedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      accessToken: ACCESS_PENDING,
      refreshToken: REFRESH_PENDING,
    });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "staged-pending:acme");
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("--add-login --name acme");
    expect(check.fix).not.toContain("--reauth");
  });

  it("warns past 24 h — mode reauth resumes with --reauth", async () => {
    const paths = healthy();
    stagePending(paths.profilesDir, "main", {
      mode: "reauth",
      stagedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      accessToken: ACCESS_PENDING,
      refreshToken: REFRESH_PENDING,
    });

    const { env } = await doctorJson(paths);

    const check = byId(env.checks, "staged-pending:main");
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("--reauth --name main");
    expect(check.fix).not.toContain("--add-login");
  });

  it("warns on a damaged pending however young it is — 'pass' contradicts 'clear it'", async () => {
    const paths = healthy();
    writeSecret(
      join(paths.profilesDir, "acme.env.pending"),
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_PENDING}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_PENDING}\n`,
    );

    const check = byId(runDoctor(paths).checks, "staged-pending:acme");

    // Staged seconds ago, so the staleness clock says nothing — but the only
    // advice available is "clear it", and a passing check that tells you to
    // clear something is a check the reader is entitled to ignore.
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("--discard-pending --name acme");
  });

  it("offers only the discard when the mode marker is unreadable", async () => {
    const paths = healthy();
    // A pending whose markers were damaged still holds a live pair on disk.
    writeSecret(
      join(paths.profilesDir, "acme.env.pending"),
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_PENDING}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_PENDING}\n`,
    );
    ageFile(join(paths.profilesDir, "acme.env.pending"), 30 * 60 * 60 * 1000);

    const { env } = await doctorJson(paths);

    const check = byId(env.checks, "staged-pending:acme");
    expect(check.status).toBe("warn");
    expect(check.fix).toContain("--discard-pending --name acme");
    expect(check.fix).not.toContain("--add-login");
    expect(check.fix).not.toContain("--reauth");
  });

  it("says so plainly when nothing is staged", async () => {
    const check = byId(runDoctor(healthy()).checks, "staged-pendings");

    expect(check.status).toBe("pass");
    expect(check.fix).toBe("");
  });
});

describe("--doctor: lingering rescue files", () => {
  it("fails ANY rescue file, with the force command and the self-heal note", async () => {
    const paths = healthy();
    writeSecret(
      join(paths.profilesDir, "main.env.rescue"),
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_RESCUE}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_RESCUE}\n`,
    );

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "rescue-file:main.env.rescue");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("save-login");
    expect(check.fix).toContain("npm run refresh-tokens -- --profile main");
    // The self-heal note: forcing can no-op while the file pair is JWT-fresh.
    expect(check.fix).toContain("10 minutes");
    expect(check.fix).toMatch(/adopt/i);
  });

  it("finds the legacy profile's rescue at the repo root too", async () => {
    const paths = healthy();
    writeSecret(
      `${paths.baseEnvPath}.rescue`,
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_RESCUE}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_RESCUE}\n`,
    );

    const report = runDoctor(paths);

    const check = byId(report.checks, "rescue-file:.env.rescue");
    expect(check.status).toBe("fail");
    expect(check.fix).toContain("--profile default");
  });

  it("reports the age of the rescue file", async () => {
    const paths = healthy();
    const rescue = join(paths.profilesDir, "main.env.rescue");
    writeSecret(rescue, `FRESHBOOKS_REFRESH_TOKEN=${REFRESH_RESCUE}\n`);
    ageFile(rescue, 3 * DAY_MS);

    const check = byId(runDoctor(paths).checks, "rescue-file:main.env.rescue");

    expect(check.detail).toMatch(/\b3 d\b|\b3 days?\b/);
  });

  it("passes when there is none", async () => {
    const check = byId(runDoctor(healthy()).checks, "rescue-files");

    expect(check.status).toBe("pass");
  });

  it.skipIf(process.platform === "win32")(
    "keeps the base .env's rescue when profiles/ cannot be scanned",
    async () => {
      const paths = healthy();
      writeSecret(
        `${paths.baseEnvPath}.rescue`,
        `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_RESCUE}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_RESCUE}\n`,
      );
      chmodSync(paths.profilesDir, 0o000);

      try {
        const report = runDoctor(paths);

        // The unreadable directory is reported — and so is the rescue already
        // found outside it. Dropping the latter hides a live token pair.
        expect(byId(report.checks, "rescue-files").status).toBe("warn");
        expect(byId(report.checks, "rescue-file:.env.rescue").status).toBe("fail");
      } finally {
        chmodSync(paths.profilesDir, 0o755);
      }
    },
  );
});

describe("--doctor: file permissions", () => {
  it.skipIf(process.platform === "win32")("warns on a world-readable token file", async () => {
    const paths = healthy();
    chmodSync(join(paths.profilesDir, "main.env"), 0o644);

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "file-permissions");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("main.env");
    expect(check.fix).toContain("chmod 600");
  });

  it.skipIf(process.platform === "win32")("passes when every credential file is 0600", async () => {
    const check = byId(runDoctor(healthy()).checks, "file-permissions");

    expect(check.status).toBe("pass");
  });
});

describe("--doctor: config entries", () => {
  it("fails when no location carries a resolvable entry, quoting the sandbox hypothesis", async () => {
    const paths = healthy();
    rmSync(paths.desktopConfigPath, { force: true });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "config");
    expect(check.status).toBe("fail");
    expect(check.stepId).toBe("install-config");
    expect(check.fix).toContain(SANDBOX_FIX);
    // Every location is named with its path, so the agent knows where to look.
    for (const path of [paths.desktopConfigPath, paths.mcpJsonPath, paths.claudeJsonPath]) {
      expect(check.detail).toContain(path);
    }
  });

  it("passes when only the project .mcp.json carries the entry", async () => {
    const paths = healthy();
    rmSync(paths.desktopConfigPath, { force: true });
    seedConfig(paths.mcpJsonPath, resolvableEntry(paths));

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    expect(byId(env.checks, "config").status).toBe("pass");
  });

  it("reads ~/.claude.json best-effort and accepts an entry there", async () => {
    const paths = healthy();
    rmSync(paths.desktopConfigPath, { force: true });
    seedConfig(paths.claudeJsonPath, resolvableEntry(paths));

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.OK);
    expect(byId(env.checks, "config").status).toBe("pass");
  });

  it("survives an unparseable config without quoting a byte of it", async () => {
    const paths = healthy();
    // The syntax error sits right beside a neighbouring connector's key — the
    // window V8 quotes in its parse error would carry it.
    writeFileSync(
      paths.mcpJsonPath,
      `{"mcpServers":{"other":{"env":{"OTHER_API_KEY":"${FOREIGN_CANARY}",bad}}}}`,
    );

    const { code, env } = await doctorJson(paths);

    // The desktop entry still resolves, so the run is a pass overall.
    expect(code).toBe(EXIT.OK);
    expect(byId(env.checks, "config").detail).toMatch(/could not be (read|parsed)/);
    expectNoSecretMaterial(JSON.stringify(env), FOREIGN_CANARY);
  });

  it("warns on a non-absolute command with the Book's two-cause text", async () => {
    const paths = healthy();
    seedConfig(paths.desktopConfigPath, {
      command: "node",
      args: [join(paths.rootDir, "dist", "index.js")],
    });

    const { code, env } = await doctorJson(paths);

    // A bare `node` still resolves — the rung-2 fallback must not fail.
    expect(code).toBe(EXIT.OK);
    const check = byId(env.checks, "config-command:desktop");
    expect(check.status).toBe("warn");
    expect(check.stepId).toBe("install-config");
    expect(check.fix).toBe(TWO_CAUSE_FIX);
    // "the doctor's line says which": the line names one of the two causes.
    expect(check.detail).toContain(
      selectCommandPath({}).caveat ? "deliberate fallback" : "legacy entry",
    );
  });

  it("fails an absolute command that is not on this computer", async () => {
    const paths = healthy();
    seedConfig(paths.desktopConfigPath, {
      command: "/definitely/not/here/bin/node",
      args: [join(paths.rootDir, "dist", "index.js")],
    });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "config-command:desktop");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("/definitely/not/here/bin/node");
    expect(check.fix).toContain("--command-path");
  });

  it("fails an entry whose dist path does not exist", async () => {
    const paths = healthy();
    seedConfig(paths.desktopConfigPath, {
      command: process.execPath,
      args: [join(paths.rootDir, "elsewhere", "dist", "index.js")],
    });

    const { code, env } = await doctorJson(paths);

    expect(code).toBe(EXIT.FAIL);
    const check = byId(env.checks, "config-args:desktop");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("elsewhere");
    // An entry that points nowhere is also not a resolvable entry.
    expect(byId(env.checks, "config").status).toBe("fail");
  });

  it("never echoes a neighbouring connector's credentials", async () => {
    const paths = healthy();
    seedConfig(paths.claudeJsonPath, resolvableEntry(paths));

    const { env } = await doctorJson(paths);

    expectNoSecretMaterial(JSON.stringify(env), FOREIGN_CANARY);
    expectNoSecretMaterial(allOutput(), FOREIGN_CANARY);
  });
});

describe("--doctor: token hygiene across the whole matrix", () => {
  it("prints no fragment of any credential on the worst fixture there is", async () => {
    // Everything wrong at once: legacy tokens, a rescue, a stale pending, a
    // malformed profile, a same-account collision, a lingering secret file.
    const paths = fixture({
      baseEnv:
        APP_CREDENTIALS +
        `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_LEGACY}\n` +
        `FRESHBOOKS_REFRESH_TOKEN=${REFRESH_LEGACY}\n`,
      built: false,
    });
    seedProfile(paths, "main");
    seedProfile(paths, "acme", { refreshToken: REFRESH_ACME, accountId: "AC1" });
    writeSecret(join(paths.profilesDir, "broken.env"), "FRESHBOOKS_ACCOUNT_ID=AC9\n");
    writeSecret(
      join(paths.profilesDir, "main.env.rescue"),
      `FRESHBOOKS_ACCESS_TOKEN=${ACCESS_RESCUE}\nFRESHBOOKS_REFRESH_TOKEN=${REFRESH_RESCUE}\n`,
    );
    stagePending(paths.profilesDir, "acme", {
      mode: "reauth",
      stagedAt: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
      accessToken: ACCESS_PENDING,
      refreshToken: REFRESH_PENDING,
    });
    writeFileSync(join(paths.rootDir, ".client-secret.tmp"), `${APP_SECRET}\n`);
    seedConfig(paths.mcpJsonPath, { command: "node", args: ["/gone/dist/index.js"] });

    // BOTH modes: the human block and the JSON envelope are separate renders.
    const humanCode = await runHeadless(["--headless", "--doctor"], paths);
    const jsonCode = await runHeadless(["--headless", "--doctor", "--json"], paths);

    expect(humanCode).toBe(EXIT.FAIL);
    expect(jsonCode).toBe(EXIT.FAIL);
    expect(stderr()).toContain("fail");
    // The sweep in afterEach covers both streams; assert here too so this test
    // fails on its own terms rather than only in teardown.
    for (const canary of CANARIES) expectNoSecretMaterial(allOutput(), canary);
  });
});
