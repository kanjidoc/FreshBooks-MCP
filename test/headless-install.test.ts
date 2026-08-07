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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  NODE_PROBE_PATHS,
  runHeadless,
  selectCommandPath,
  type SetupPaths,
} from "../scripts/setup-headless";
import { claudeMcpAddJson, isClaudeCliAvailable } from "../scripts/setup-core";
import { SETUP_FLOW } from "../src/setup-flow";

/**
 * `--install` and `--print-config`.
 *
 * SAFETY, in three layers:
 *  1. Every run drives `runHeadless(argv, paths)` over a throwaway `SetupPaths`
 *     rooted in a fresh temp dir — the developer's real `.env`, `profiles/`,
 *     `.mcp.json`, `~/.claude.json` and Claude Desktop config are never read or
 *     written. The Desktop config path in every fixture lives INSIDE the temp
 *     dir.
 *  2. The `claude` CLI is never executed: `isClaudeCliAvailable` and
 *     `claudeMcpAddJson` are stubbed for the whole file and default to
 *     "no CLI installed", so a test that forgets to set them takes the
 *     `.mcp.json` branch rather than spawning anything.
 *  3. No test reaches FreshBooks — neither verb makes a network call.
 *
 * TOKEN HYGIENE: the foreign config entry these tests merge around carries a
 * canary API key in its `env` block, swept out of both streams with the sliding
 * window. A config merge that echoed a neighbouring connector's credentials
 * would be exactly the leak the spec's disclosure rule exists to prevent.
 */

/** Reads recorded by the `node:fs` wrapper below — the print-config read spy. */
const { readCalls } = vi.hoisted(() => ({ readCalls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      readCalls.push(String(path));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

vi.mock("../scripts/setup-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/setup-core")>();
  return {
    ...actual,
    // The ONLY two functions in the project that spawn a process.
    isClaudeCliAvailable: vi.fn(),
    claudeMcpAddJson: vi.fn(),
  };
});

/** A neighbouring connector's secret — it must survive the merge, unprinted. */
const FOREIGN_CANARY = "FOREIGN-KEY-CANARY-5c1e93a7-DO-NOT-PRINT-EVER";

const roots: string[] = [];
let logs: string[];
let errs: string[];

const stdout = () => logs.join("\n");
const stderr = () => errs.join("\n");
const allOutput = () => [...logs, ...errs].join("\n");

/** A throwaway SetupPaths whose every member lives inside one temp dir. */
function fixture(opts: { built?: boolean } = {}): SetupPaths {
  const rootDir = mkdtempSync(join(tmpdir(), "fb-install-"));
  roots.push(rootDir);
  if (opts.built !== false) {
    mkdirSync(join(rootDir, "dist"), { recursive: true });
    writeFileSync(join(rootDir, "dist", "index.js"), "// pretend build output\n");
  }
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: join(rootDir, "claude_desktop_config.json"),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(rootDir, "dot-claude.json"),
  };
}

/** An existing Claude config with a foreign connector the merge must preserve. */
function foreignConfig(): string {
  return (
    JSON.stringify(
      {
        globalShortcut: "Cmd+Space",
        mcpServers: {
          other: {
            command: "/opt/other/bin/other-server",
            args: ["--serve"],
            env: { OTHER_API_KEY: FOREIGN_CANARY },
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Every JSON object a `--json` run printed, one per stdout line. */
function envelopes(): any[] {
  return logs.map((line) => JSON.parse(line));
}

/** The single JSON line a one-target `--json` run prints. */
function envelope(): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

/** Assert `output` contains no contiguous 8-char fragment of `secret`. */
function expectNoSecretMaterial(output: string, secret: string): void {
  const WINDOW = 8;
  for (let i = 0; i + WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + WINDOW));
  }
}

const buildStep = SETUP_FLOW.find((s) => s.id === "build")!;

beforeEach(() => {
  logs = [];
  errs = [];
  readCalls.length = 0;
  // The two CLI stubs live for the whole file, so their call history has to be
  // cleared per test — `not.toHaveBeenCalled()` would otherwise see the
  // previous test's spawn.
  vi.clearAllMocks();
  vi.mocked(isClaudeCliAvailable).mockReturnValue(false);
  vi.mocked(claudeMcpAddJson).mockImplementation(() => undefined);
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
    const locked = join(root, "locked");
    if (existsSync(locked)) chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("selectCommandPath", () => {
  const noneExist = () => false;

  it("probes the standard host locations in the spec's order", () => {
    expect(NODE_PROBE_PATHS).toEqual([
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]);

    const seen: string[] = [];
    const only = (hit: string) => (path: string) => {
      seen.push(path);
      return path === hit;
    };

    expect(selectCommandPath({}, only("/opt/homebrew/bin/node")).command).toBe(
      "/opt/homebrew/bin/node",
    );
    // The first hit wins — the later candidates are never even probed.
    expect(seen).toEqual(["/opt/homebrew/bin/node"]);

    expect(selectCommandPath({}, only("/usr/local/bin/node")).command).toBe("/usr/local/bin/node");
    expect(selectCommandPath({}, only("/usr/bin/node")).command).toBe("/usr/bin/node");
  });

  it("falls back to the bare command with a stated caveat", () => {
    const selection = selectCommandPath({}, noneExist);

    expect(selection.command).toBe("node");
    expect(selection.caveat).toBeTruthy();
    expect(selection.caveat).toContain("PATH");
    expect(selection.caveat).toContain("--command-path");
  });

  it("uses process.execPath only when the caller vouches for the shell", () => {
    // Default: a possibly-sandboxed process must never trust its own execPath.
    expect(selectCommandPath({}, noneExist).command).not.toBe(process.execPath);
    expect(selectCommandPath({ trustExecPath: true }, noneExist)).toEqual({
      command: process.execPath,
    });
  });

  it("lets an explicit override win over everything, with no caveat", () => {
    expect(
      selectCommandPath({ override: "/custom/node", trustExecPath: true }, () => true),
    ).toEqual({ command: "/custom/node" });
  });
});

describe("--print-config", () => {
  it("emits exactly {target, path, configBlock} for the desktop target", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--print-config", "desktop", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    const env = envelope();
    expect(Object.keys(env).sort()).toEqual(["configBlock", "ok", "path", "target", "verb"]);
    expect(env.ok).toBe(true);
    expect(env.verb).toBe("print-config");
    expect(env.target).toBe("desktop");
    expect(env.path).toBe(paths.desktopConfigPath);

    const block = JSON.parse(env.configBlock);
    expect(block.mcpServers.freshbooks.args).toEqual([join(paths.rootDir, "dist", "index.js")]);
    expect(block.mcpServers.freshbooks.command).toBe(selectCommandPath({}).command);
    expect(block.mcpServers.freshbooks).not.toHaveProperty("env");
  });

  it("never reads the existing config — the structural read-only claim", async () => {
    const paths = fixture();
    // Every config file exists and is full of material a reader would want.
    writeFileSync(paths.desktopConfigPath, foreignConfig());
    writeFileSync(paths.mcpJsonPath, foreignConfig());
    writeFileSync(paths.claudeJsonPath, foreignConfig());
    writeFileSync(paths.baseEnvPath, "FRESHBOOKS_CLIENT_ID=cid\n");
    readCalls.length = 0;

    const code = await runHeadless(["--headless", "--print-config", "both", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    // Scoped to the config files: the dispatcher's exit-9 precondition
    // legitimately reads the base .env, and that read is not what is at issue.
    for (const configPath of [paths.desktopConfigPath, paths.mcpJsonPath, paths.claudeJsonPath]) {
      expect(readCalls).not.toContain(configPath);
    }
    // Nothing on disk changed either.
    expect(readFileSync(paths.desktopConfigPath, "utf8")).toBe(foreignConfig());
    expectNoSecretMaterial(allOutput(), FOREIGN_CANARY);
  });

  it("emits one object per target, one per line, for `both`", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--print-config", "both", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(logs).toHaveLength(2);
    const [desktop, codeTarget] = envelopes();
    expect(desktop.target).toBe("desktop");
    expect(desktop.path).toBe(paths.desktopConfigPath);
    expect(codeTarget.target).toBe("code");
    // The by-hand route for Claude Code is the project-scoped file.
    expect(codeTarget.path).toBe(paths.mcpJsonPath);
  });

  it("works before the build exists — the degraded path may run at any time", async () => {
    const paths = fixture({ built: false });

    expect(
      await runHeadless(["--headless", "--print-config", "mcp-json", "--json"], paths),
    ).toBe(EXIT.OK);
    expect(envelope().path).toBe(paths.mcpJsonPath);
  });

  it("honours --command-path and rejects a relative one", async () => {
    const paths = fixture();

    const code = await runHeadless(
      ["--headless", "--print-config", "desktop", "--command-path", "/custom/bin/node", "--json"],
      paths,
    );
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(envelope().configBlock).mcpServers.freshbooks.command).toBe(
      "/custom/bin/node",
    );

    logs = [];
    expect(
      await runHeadless(
        ["--headless", "--print-config", "desktop", "--command-path", "bin/node", "--json"],
        paths,
      ),
    ).toBe(EXIT.USAGE);
  });

  it("rejects a missing or unknown target with exit 2", async () => {
    const paths = fixture();

    expect(await runHeadless(["--headless", "--print-config"], paths)).toBe(EXIT.USAGE);
    expect(await runHeadless(["--headless", "--print-config", "everything"], paths)).toBe(
      EXIT.USAGE,
    );
    expect(await runHeadless(["--headless", "--install", "Desktop"], paths)).toBe(EXIT.USAGE);
  });
});

describe("--install desktop", () => {
  it("merges into an existing config, preserving every foreign entry", async () => {
    const paths = fixture();
    writeFileSync(paths.desktopConfigPath, foreignConfig());
    const before = JSON.parse(foreignConfig());

    const code = await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    const after = JSON.parse(readFileSync(paths.desktopConfigPath, "utf8"));
    // Byte-identical foreign entry: same keys, same order, same values.
    expect(JSON.stringify(after.mcpServers.other)).toBe(JSON.stringify(before.mcpServers.other));
    expect(after.globalShortcut).toBe("Cmd+Space");
    expect(after.mcpServers.freshbooks).toEqual({
      command: selectCommandPath({}).command,
      args: [join(paths.rootDir, "dist", "index.js")],
    });

    const env = envelope();
    expect(Object.keys(env).sort()).toEqual([
      "args",
      "command",
      "mtime",
      "ok",
      "path",
      "target",
      "verb",
    ]);
    expect(env.target).toBe("desktop");
    expect(env.path).toBe(paths.desktopConfigPath);
    expect(env.mtime).toBe(statSync(paths.desktopConfigPath).mtimeMs);
    expect(env.command).toBe(selectCommandPath({}).command);
    expect(env.args).toEqual([join(paths.rootDir, "dist", "index.js")]);
    // A neighbouring connector's key is never echoed back.
    expectNoSecretMaterial(allOutput(), FOREIGN_CANARY);
  });

  it("creates the config (and its folder) when none exists", async () => {
    const paths = fixture();
    paths.desktopConfigPath = join(paths.rootDir, "Application Support", "Claude", "cfg.json");

    const code = await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    const written = JSON.parse(readFileSync(paths.desktopConfigPath, "utf8"));
    expect(Object.keys(written)).toEqual(["mcpServers"]);
    expect(written.mcpServers.freshbooks.args).toEqual([join(paths.rootDir, "dist", "index.js")]);
  });

  it("refuses invalid existing JSON with exit 10 and leaves the file untouched", async () => {
    const paths = fixture();
    const broken = '{ "mcpServers": { "other": ';
    writeFileSync(paths.desktopConfigPath, broken);

    const code = await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

    expect(code).toBe(EXIT.INSTALL_FAILED);
    expect(code).toBe(10);
    expect(readFileSync(paths.desktopConfigPath, "utf8")).toBe(broken);

    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.exitCode).toBe(10);
    expect(env.stepId).toBe("install-config");
    expect(env.path).toBe(paths.desktopConfigPath);
    // The payload IS the degraded path's raw material.
    expect(JSON.parse(env.configBlock).mcpServers.freshbooks.args).toEqual([
      join(paths.rootDir, "dist", "index.js"),
    ]);
    expect(typeof env.symptom).toBe("string");
    expect(typeof env.fix).toBe("string");
  });

  it.skipIf(process.platform === "win32")(
    "reports an unwritable config as exit 10 with the same payload",
    async () => {
      const paths = fixture();
      const locked = join(paths.rootDir, "locked");
      mkdirSync(locked);
      paths.desktopConfigPath = join(locked, "claude_desktop_config.json");
      chmodSync(locked, 0o555);

      const code = await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

      expect(code).toBe(EXIT.INSTALL_FAILED);
      expect(existsSync(paths.desktopConfigPath)).toBe(false);
      const env = envelope();
      expect(env.path).toBe(paths.desktopConfigPath);
      expect(typeof env.configBlock).toBe("string");
    },
  );

  it("refuses to install before the build, keyed to the Book's build step", async () => {
    const paths = fixture({ built: false });

    const code = await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

    expect(code).toBe(EXIT.PRECONDITION);
    expect(code).toBe(7);
    const env = envelope();
    expect(env.stepId).toBe("build");
    expect(env.fix).toBe(buildStep.troubleshooting[0].fix);
    expect(existsSync(paths.desktopConfigPath)).toBe(false);
  });

  it("uses the selected command in the written entry", async () => {
    const paths = fixture();

    await runHeadless(
      ["--headless", "--install", "desktop", "--command-path", "/custom/bin/node", "--json"],
      paths,
    );

    expect(JSON.parse(readFileSync(paths.desktopConfigPath, "utf8")).mcpServers.freshbooks.command)
      .toBe("/custom/bin/node");
    expect(envelope().command).toBe("/custom/bin/node");
  });
});

describe("--install mcp-json", () => {
  it("writes only the project .mcp.json", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--install", "mcp-json", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(existsSync(paths.desktopConfigPath)).toBe(false);
    expect(existsSync(paths.claudeJsonPath)).toBe(false);
    expect(vi.mocked(claudeMcpAddJson)).not.toHaveBeenCalled();
    const env = envelope();
    expect(env.target).toBe("mcp-json");
    expect(env.path).toBe(paths.mcpJsonPath);
    expect(JSON.parse(readFileSync(paths.mcpJsonPath, "utf8")).mcpServers.freshbooks.args).toEqual(
      [join(paths.rootDir, "dist", "index.js")],
    );
  });

  it("preserves a foreign server already in .mcp.json", async () => {
    const paths = fixture();
    writeFileSync(paths.mcpJsonPath, foreignConfig());

    expect(await runHeadless(["--headless", "--install", "mcp-json", "--json"], paths)).toBe(
      EXIT.OK,
    );

    const after = JSON.parse(readFileSync(paths.mcpJsonPath, "utf8"));
    expect(JSON.stringify(after.mcpServers.other)).toBe(
      JSON.stringify(JSON.parse(foreignConfig()).mcpServers.other),
    );
    expect(after.mcpServers.freshbooks).toBeTruthy();
    expectNoSecretMaterial(allOutput(), FOREIGN_CANARY);
  });
});

describe("--install code", () => {
  it("registers through the claude CLI when it is installed", async () => {
    const paths = fixture();
    vi.mocked(isClaudeCliAvailable).mockReturnValue(true);
    writeFileSync(paths.claudeJsonPath, "{}\n");

    const code = await runHeadless(["--headless", "--install", "code", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(vi.mocked(claudeMcpAddJson).mock.calls[0]).toEqual([
      paths.rootDir,
      selectCommandPath({}).command,
    ]);
    // The CLI branch owns the write — no project file is created behind its back.
    expect(existsSync(paths.mcpJsonPath)).toBe(false);

    const env = envelope();
    expect(env.target).toBe("code");
    expect(env.path).toBe(paths.claudeJsonPath);
    expect(env.mtime).toBe(statSync(paths.claudeJsonPath).mtimeMs);
  });

  it("writes .mcp.json and the open-this-folder script when the CLI is absent", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--install", "code", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(vi.mocked(claudeMcpAddJson)).not.toHaveBeenCalled();
    expect(existsSync(paths.mcpJsonPath)).toBe(true);
    const env = envelope();
    expect(env.target).toBe("code");
    expect(env.path).toBe(paths.mcpJsonPath);
    // The script line is human-channel in both modes — it is not part of the
    // `--json` shape.
    expect(stderr()).toContain("open this folder");
    expect(stderr()).toContain("freshbooks");
  });

  it("turns a failing claude CLI into exit 10 with by-hand raw material", async () => {
    const paths = fixture();
    vi.mocked(isClaudeCliAvailable).mockReturnValue(true);
    vi.mocked(claudeMcpAddJson).mockImplementation(() => {
      throw new Error("claude exited 1");
    });

    const code = await runHeadless(["--headless", "--install", "code", "--json"], paths);

    expect(code).toBe(EXIT.INSTALL_FAILED);
    expect(existsSync(paths.mcpJsonPath)).toBe(false);
    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.exitCode).toBe(10);
    expect(env.stepId).toBe("install-config");
    expect(env.message).toBe("claude exited 1");
    expect(env.path).toBe(paths.mcpJsonPath);
    expect(JSON.parse(env.configBlock).mcpServers.freshbooks).toBeTruthy();
  });
});

describe("--install both", () => {
  it("emits one JSON object per target, one per line", async () => {
    const paths = fixture();

    const code = await runHeadless(["--headless", "--install", "both", "--json"], paths);

    expect(code).toBe(EXIT.OK);
    expect(logs).toHaveLength(2);
    const [desktop, codeTarget] = envelopes();
    expect(desktop).toMatchObject({ ok: true, verb: "install", target: "desktop" });
    expect(codeTarget).toMatchObject({ ok: true, verb: "install", target: "code" });
    expect(existsSync(paths.desktopConfigPath)).toBe(true);
    expect(existsSync(paths.mcpJsonPath)).toBe(true);
  });

  it("reports each target independently and exits 10 when one fails", async () => {
    const paths = fixture();
    writeFileSync(paths.desktopConfigPath, "{ not json");

    const code = await runHeadless(["--headless", "--install", "both", "--json"], paths);

    expect(code).toBe(EXIT.INSTALL_FAILED);
    const [desktop, codeTarget] = envelopes();
    expect(desktop.ok).toBe(false);
    expect(desktop.exitCode).toBe(10);
    expect(desktop.target).toBeUndefined();
    expect(desktop.path).toBe(paths.desktopConfigPath);
    // The second target still ran.
    expect(codeTarget).toMatchObject({ ok: true, target: "code" });
    expect(existsSync(paths.mcpJsonPath)).toBe(true);
  });
});

describe("command selection reaches both verbs", () => {
  it("states the bare-command caveat on the human channel when it applies", async () => {
    const paths = fixture();
    const selection = selectCommandPath({});

    await runHeadless(["--headless", "--install", "desktop", "--json"], paths);

    if (selection.caveat) {
      expect(stderr()).toContain(selection.caveat);
    } else {
      expect(stderr()).toBe("");
    }
    // Either way the emitted command is exactly what the selector chose.
    expect(envelope().command).toBe(selection.command);
  });

  it("--trust-exec-path opts into process.execPath", async () => {
    const paths = fixture();

    await runHeadless(
      ["--headless", "--print-config", "desktop", "--trust-exec-path", "--json"],
      paths,
    );

    expect(JSON.parse(envelope().configBlock).mcpServers.freshbooks.command).toBe(
      process.execPath,
    );
  });

  it("rejects flags the verbs do not take", async () => {
    const paths = fixture();

    expect(
      await runHeadless(["--headless", "--install", "desktop", "--name", "main"], paths),
    ).toBe(EXIT.USAGE);
    expect(stdout()).toBe("");
  });
});
