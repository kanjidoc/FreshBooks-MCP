/**
 * FreshBooks MCP — the headless (agent) surface.
 *
 *   npx ts-node scripts/setup.ts --headless <verb> [--json]
 *
 * One verb per invocation, driven by an agent that is walking a human through
 * SETUP.md. Every verb is a thin shell around `scripts/setup-core.ts` (which
 * owns the FreshBooks and filesystem work) plus this module's two emitters, so
 * the wizard and the agent path run the same logic and differ only in I/O.
 *
 * FOUR INVARIANTS, all load-bearing:
 *
 *  1. PATHS ARE INJECTED. Every file a verb touches is resolved through the
 *     `SetupPaths` context, defaulted by `defaultPaths()` and overridable by a
 *     caller. That is what lets the test suite drive the real dispatcher over a
 *     temp directory instead of the developer's `.env` / `profiles/` / Claude
 *     configs.
 *  2. OUTPUT IS AN ALLOWLIST. `emitOk`/`emitErr` are the ONLY output surface,
 *     and each projects its fields onto a fixed key list (spec §"--json
 *     shapes"). A caught error object, an axios response, or a stray token
 *     handed to an emitter is dropped rather than printed — an axios error
 *     carries `config.data` (client_secret, code, refresh_token) and an
 *     `Authorization` header, so "just serialize the error" is a credential
 *     leak, not a debugging convenience.
 *  3. HUMAN → STDERR, `--json` → STDOUT (`scripts/refresh-tokens.ts:15-16`),
 *     and never both: a `--json` run's stdout is exactly one JSON object per
 *     emission, so an agent can parse it without stripping prose.
 *  4. NO PROCESS SPAWNING. This module deliberately imports no child-process
 *     API: `--auth-url` prints a URL and never opens a browser (the Book's
 *     `authorize` step: "never open a browser yourself"), and a test asserts
 *     the absence structurally.
 *
 * Exit codes are the spec's table (§"Exit codes"), exported as `EXIT`.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as dotenv from "dotenv";
import { resolveDesktopConfigPath } from "../src/config-paths";
import { isMigrated, MIGRATED_MARKER } from "../src/migrate";
import { SETUP_FLOW } from "../src/setup-flow";
import { buildAuthUrl, buildOAuthClient } from "./setup-core";
// The wizard owns these three; importing them here (rather than re-deriving
// them) keeps ONE definition of what a base `.env` contains. This is a module
// cycle — `scripts/setup.ts` imports `runHeadless` from this file — and it is
// safe because nothing here is evaluated at module load: both sides only reach
// across inside function bodies, long after both modules have finished loading.
import { buildBaseEnvVars, serializeEnv, REDIRECT_URI } from "./setup";

// ---------------------------------------------------------------------------
// Paths — the injectable test seam
// ---------------------------------------------------------------------------

/**
 * Every file any headless verb reads or writes. Passed to `runHeadless` so a
 * test can point the whole surface at a temp directory; production callers take
 * `defaultPaths()`.
 */
export interface SetupPaths {
  /** The project folder — the repo root. */
  rootDir: string;
  /** The shared app credentials file (never tokens). */
  baseEnvPath: string;
  /** Where `profiles/<name>.env` (and staged pendings) live. */
  profilesDir: string;
  /** Claude Desktop's `claude_desktop_config.json` for this OS. */
  desktopConfigPath: string;
  /** The project-scoped Claude Code config. */
  mcpJsonPath: string;
  /** Claude Code's user-scope config — the doctor's user-scope check. */
  claudeJsonPath: string;
}

/** The real files: the repo this script lives in, and the current user's Claude configs. */
export function defaultPaths(): SetupPaths {
  const rootDir = resolve(__dirname, "..");
  return {
    rootDir,
    baseEnvPath: join(rootDir, ".env"),
    profilesDir: join(rootDir, "profiles"),
    desktopConfigPath: resolveDesktopConfigPath(),
    mcpJsonPath: join(rootDir, ".mcp.json"),
    claudeJsonPath: join(homedir(), ".claude.json"),
  };
}

// ---------------------------------------------------------------------------
// Exit codes and emitters
// ---------------------------------------------------------------------------

/** The spec's exit-code table. Every verb returns one of these. */
export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  CODE_REJECTED: 3,
  NAME_TAKEN: 4,
  DUP_PAIR: 5,
  BUSINESS_CHOICE: 6,
  PRECONDITION: 7,
  SAME_ACCOUNT: 8,
  UNMIGRATED: 9,
  INSTALL_FAILED: 10,
  DISCOVERY_FAILED: 11,
  REAUTH_MISMATCH: 12,
} as const;

/** Output mode for one run: `--json` is a per-verb flag, as in `refresh-tokens`. */
export interface Emit {
  json: boolean;
}

/**
 * Every field any verb may report on success (spec §"--json shapes", union of
 * the per-verb shapes). ADDING A VERB MEANS ADDING ITS FIELDS HERE — deliberate
 * friction: this list, not the call site, is what guarantees a token can never
 * reach stdout by being passed to an emitter under a plausible-looking name.
 */
const SUCCESS_FIELDS = [
  "envPath", // init
  "url", // auth-url
  "name", // add-login / reauth / discard-pending
  "company",
  "accountId",
  "businessId",
  "profilePath",
  "discarded",
  "target", // install / print-config
  "path",
  "mtime",
  "command",
  "args",
  "configBlock",
  "checks", // doctor
] as const;

/**
 * The optional error-payload fields (spec §"--json shapes": exit-6
 * `memberships`, exit-8 `{existingProfile, confirmQuestion, directive}`,
 * exit-10 `{configBlock, path}`, plus `statusCode`). The fixed envelope keys
 * (`ok`/`verb`/`exitCode`/`stepId`/`symptom`/`fix`/`message`) are always
 * present and are not listed here.
 */
const ERROR_EXTRA_FIELDS = [
  "statusCode",
  "memberships",
  "existingProfile",
  "confirmQuestion",
  "directive",
  "configBlock",
  "path",
] as const;

/**
 * Keep only allowlisted keys, and only values that are plain JSON data.
 *
 * The `Error` rejection is the second half of the projection's job: a call site
 * that passes a caught error (or anything carrying one) under an allowlisted
 * key would otherwise serialize `config.data` — the client secret, the
 * authorization code, the refresh token — straight onto stdout.
 */
function project(
  fields: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = fields[key];
    if (value === undefined || !isPlainJson(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Strings, numbers, booleans, and arrays/objects built only from those. */
function isPlainJson(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (value instanceof Error) return false;
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (type === "object") {
    // Plain objects only — a class instance (an SDK error, an axios response,
    // a Client) is never data we are willing to serialize.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isPlainJson);
  }
  return false;
}

/** Render one field for the human channel: strings raw, everything else as JSON. */
function renderValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * A verb succeeded. `--json` → one object on stdout; otherwise a short
 * human-readable block on stderr.
 */
export function emitOk(e: Emit, verb: string, fields: Record<string, unknown>): void {
  const projected = project(fields, SUCCESS_FIELDS);
  if (e.json) {
    console.log(JSON.stringify({ ok: true, verb, ...projected }));
    return;
  }
  console.error(`${verb}: OK`);
  for (const [key, value] of Object.entries(projected)) {
    console.error(`  ${key}: ${renderValue(value)}`);
  }
}

/**
 * A verb failed. The envelope is fixed (spec §"--json shapes"): `stepId` keys
 * the failure to a Book step, `symptom`/`fix` are the Book's own words for that
 * state where the Book has them, and `message` is the terse technical detail.
 *
 * NEVER pass an `Error` here — call sites pass `err.message` only. `extra`
 * carries the typed per-exit payloads and is projected onto
 * `ERROR_EXTRA_FIELDS`.
 */
export function emitErr(
  e: Emit,
  verb: string,
  exitCode: number,
  stepId: string,
  symptom: string,
  fix: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const projected = extra ? project(extra, ERROR_EXTRA_FIELDS) : {};
  if (e.json) {
    console.log(
      JSON.stringify({ ok: false, verb, exitCode, stepId, symptom, fix, message, ...projected }),
    );
    return;
  }
  console.error(`${verb}: FAILED (exit ${exitCode})`);
  console.error(`  step: ${stepId}`);
  console.error(`  symptom: ${symptom}`);
  console.error(`  fix: ${fix}`);
  console.error(`  detail: ${message}`);
  for (const [key, value] of Object.entries(projected)) {
    console.error(`  ${key}: ${renderValue(value)}`);
  }
}

// ---------------------------------------------------------------------------
// The Book — step ids and the strings a refusal quotes
// ---------------------------------------------------------------------------

/** The Book step a verb belongs to, for the envelope's `stepId`. */
function stepFor(id: string) {
  const step = SETUP_FLOW.find((s) => s.id === id);
  if (!step) throw new Error(`No Book step "${id}" — src/setup-flow.ts and this file disagree.`);
  return step;
}

/**
 * Which Book step owns a verb, read from the Book's own `verbs` lists rather
 * than a second table here. Verbs the Book does not map (`--reauth`,
 * `--discard-pending`) fall back to the caller-supplied default.
 */
function stepIdForVerb(verbFlag: string, fallback: string): string {
  return SETUP_FLOW.find((s) => s.verbs?.includes(verbFlag))?.id ?? fallback;
}

// ---------------------------------------------------------------------------
// The legacy-`.env` predicate
// ---------------------------------------------------------------------------

/**
 * The `migrate-legacy` state: base `.env` still holds a single login's tokens
 * and has never been migrated.
 *
 * This is the SAME content predicate as `SetupCtx.legacyNeedsMigration`
 * (`src/setup-flow.ts`) — a non-empty `FRESHBOOKS_REFRESH_TOKEN=` line (the
 * wizard's regex, `scripts/setup.ts`'s `maybeMigrateLegacyEnv`) AND no
 * `FRESHBOOKS_MIGRATED` marker. Exported because three surfaces must agree on
 * it byte for byte: this dispatcher (which refuses), `--doctor` (which reports
 * it), and the wizard (which offers the migration). A surface that re-derives
 * the predicate instead of calling this is how the three drift apart.
 *
 * An unreadable `.env` answers `false` — "cannot tell" must not be reported as
 * "unmigrated", and the verb that actually needs the file will fail with its
 * own, accurate error a moment later.
 */
export function legacyEnvNeedsMigration(baseEnvPath: string): boolean {
  if (!existsSync(baseEnvPath)) return false;
  let content: string;
  try {
    content = readFileSync(baseEnvPath, "utf8");
  } catch {
    return false;
  }
  return /^FRESHBOOKS_REFRESH_TOKEN=.+/m.test(content) && !isMigrated(content);
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/**
 * The verbs. `value: true` marks a verb that takes a positional argument
 * (`--install desktop`). Later tasks add handlers; a verb listed here without
 * one is recognized (so the dispatcher-level preconditions still apply to it)
 * and then reported as unimplemented.
 */
// A Map, not an object literal: `"toString" in {}` is true, so an object
// lookup would accept `Object.prototype` keys as verbs.
const VERBS = new Map<string, { value: boolean }>([
  ["--init", { value: false }],
  ["--auth-url", { value: false }],
  ["--add-login", { value: false }],
  ["--reauth", { value: false }],
  ["--install", { value: true }],
  ["--print-config", { value: true }],
  ["--discard-pending", { value: false }],
  ["--doctor", { value: false }],
]);

/** Flags that consume the next token. */
const VALUE_FLAGS = new Set([
  "--client-id",
  "--client-secret",
  "--client-secret-file",
  "--name",
  "--callback-url",
  "--business-id",
  "--account-id",
  "--command-path",
]);

/** Flags that stand alone. `--headless` and `--json` are handled separately. */
const BOOL_FLAGS = new Set([
  "--client-secret-stdin",
  "--distinct-login",
  "--confirm-different-user",
  "--trust-exec-path",
]);

/** Which flags each implemented verb accepts; anything else is a usage error. */
const VERB_FLAGS: Record<string, string[]> = {
  "--init": ["--client-id", "--client-secret", "--client-secret-file", "--client-secret-stdin"],
  "--auth-url": [],
};

interface ParsedArgs {
  verb: string;
  verbValue?: string;
  json: boolean;
  flags: Map<string, string | true>;
}

type ParseResult = { ok: true; parsed: ParsedArgs } | { ok: false; message: string };

/** Is this token part of the CLI's grammar (and therefore never a flag's value)? */
function isKnownToken(token: string): boolean {
  return (
    token === "--headless" ||
    token === "--json" ||
    VERBS.has(token) ||
    VALUE_FLAGS.has(token) ||
    BOOL_FLAGS.has(token)
  );
}

/**
 * Hand-rolled, zero-dependency argv parsing (`scripts/refresh-tokens.ts`
 * precedent). Returns a message instead of exiting so the caller can render it
 * through the envelope.
 */
export function parseHeadlessArgs(argv: string[]): ParseResult {
  const flags = new Map<string, string | true>();
  let verb = "";
  let verbValue: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headless") continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    const verbSpec = VERBS.get(arg);
    if (verbSpec) {
      if (verb) return { ok: false, message: `Only one verb per run (got ${verb} and ${arg}).` };
      verb = arg;
      if (verbSpec.value) {
        const value = argv[i + 1];
        if (value === undefined || isKnownToken(value)) {
          return { ok: false, message: `${arg} requires a target.` };
        }
        verbValue = value;
        i += 1;
      }
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || isKnownToken(value)) {
        return { ok: false, message: `${arg} requires a value.` };
      }
      flags.set(arg, value);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    return { ok: false, message: `Unknown argument: ${arg}` };
  }

  if (!verb) {
    return {
      ok: false,
      message: `Expected exactly one verb: ${[...VERBS.keys()].join(" | ")}.`,
    };
  }
  return { ok: true, parsed: { verb, verbValue, json, flags } };
}

// ---------------------------------------------------------------------------
// Verb: --init
// ---------------------------------------------------------------------------

/** The first line of whatever a secret source handed us, trimmed. */
function firstLine(raw: string): string {
  return raw.split(/\r?\n/, 1)[0].trim();
}

/**
 * Read the agent-written secret file ONCE and delete it immediately — the
 * spec's read-once-then-delete choreography (§Secrets). The delete runs in a
 * `finally`, so it happens whether or not the read succeeded, before the secret
 * is used for anything: the file's on-disk lifetime ends the moment this CLI
 * starts. A delete that fails is fatal and loud — the alternative is a file
 * holding the app secret sitting at default permissions with nobody told.
 */
function readAndShredSecretFile(file: string): {
  secret?: string;
  readError?: string;
  rmError?: string;
} {
  let raw: string | undefined;
  let readError: string | undefined;
  let rmError: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    readError = errorMessage(err);
  } finally {
    try {
      rmSync(file, { force: true });
    } catch (err) {
      rmError = errorMessage(err);
    }
  }
  return { secret: raw === undefined ? undefined : firstLine(raw), readError, rmError };
}

/** One line from stdin (`--client-secret-stdin`), trailing newline trimmed. */
async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return firstLine(Buffer.concat(chunks).toString("utf8"));
}

/** `err.message` and nothing else — never the object (it may carry the request body). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runInit(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): Promise<number> {
  const verb = "init";
  const step = stepFor("app-credentials");

  const clientId = String(parsed.flags.get("--client-id") ?? "").trim();
  if (!clientId) {
    return usage(
      emit,
      verb,
      step.id,
      "No Client ID was given.",
      "Re-run with --client-id <id>, taking the value from the app page in the FreshBooks " +
        "Developer Portal.",
    );
  }

  const sources = ["--client-secret-file", "--client-secret-stdin", "--client-secret"].filter((f) =>
    parsed.flags.has(f),
  );
  if (sources.length !== 1) {
    return usage(
      emit,
      verb,
      step.id,
      `--init takes exactly one secret source; ${sources.length} were given.`,
      "Pass one of --client-secret-file <file> (preferred — the CLI deletes the file itself), " +
        "--client-secret-stdin, or --client-secret <value>.",
    );
  }

  let secret = "";
  if (sources[0] === "--client-secret-file") {
    const file = String(parsed.flags.get("--client-secret-file"));
    const result = readAndShredSecretFile(file);
    if (result.rmError) {
      // Loud, unconditionally, on both output modes: the file still holds the
      // app secret and only the user can remove it now.
      console.error(
        `FATAL: could not delete the client-secret file ${file} (${result.rmError}) — ` +
          "it still holds your app secret. Delete it yourself now.",
      );
      emitErr(
        emit,
        verb,
        EXIT.FAIL,
        step.id,
        "The client-secret file could not be deleted after being read.",
        `Delete ${file} by hand, then re-run --init with a fresh secret file.`,
        result.rmError,
      );
      return EXIT.FAIL;
    }
    if (result.readError !== undefined) {
      return usage(
        emit,
        verb,
        step.id,
        `The --client-secret-file could not be read (${result.readError}).`,
        "Write the Client Secret as the first line of a file this command can read, then re-run " +
          "--init pointing at that file.",
      );
    }
    secret = result.secret ?? "";
  } else if (sources[0] === "--client-secret-stdin") {
    if (process.stdin.isTTY) {
      return usage(
        emit,
        verb,
        step.id,
        "--client-secret-stdin was given but stdin is a terminal, so there is nothing to read.",
        "Pipe the secret into the command, or use --client-secret-file <file> instead.",
      );
    }
    secret = await readSecretFromStdin();
  } else {
    secret = String(parsed.flags.get("--client-secret") ?? "").trim();
    // SECRETS_RULES: "never argv". The value is already in `ps` output and the
    // shell history by the time we run, so all we can do is say so.
    console.error(
      "Warning: --client-secret puts your app secret in the command line, where it is " +
        "visible to `ps` and recorded in shell history. Prefer --client-secret-file <file> " +
        "(the CLI deletes the file itself) or --client-secret-stdin.",
    );
  }

  if (!secret) {
    return usage(
      emit,
      verb,
      step.id,
      `${sources[0]} provided no secret — the first line was empty.`,
      "Reveal the Client Secret on the app page (the eye toggle), copy the whole value, and " +
        "re-run --init with it as the first line of the secret source.",
    );
  }

  const existing = existsSync(paths.baseEnvPath) ? safeRead(paths.baseEnvPath) : "";
  const vars = buildBaseEnvVars(clientId, secret, REDIRECT_URI, isMigrated(existing));

  try {
    // 0600 AT CREATION (Security §Permissions) — a chmod-after would leave a
    // window in which the app secret is world-readable.
    writeFileSync(paths.baseEnvPath, serializeEnv(vars), { mode: 0o600 });
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      step.id,
      "The base .env could not be written.",
      `Make sure ${paths.baseEnvPath} is writable, then re-run --init.`,
      errorMessage(err),
    );
    return EXIT.FAIL;
  }

  // `mode` applies at creation only, so an overwritten pre-existing file keeps
  // its old (possibly looser) permissions without this. Best-effort: a failure
  // here leaves a working install, and `--doctor` reports loose modes.
  try {
    chmodSync(paths.baseEnvPath, 0o600);
  } catch (err) {
    console.error(
      `Warning: could not set ${paths.baseEnvPath} to mode 0600 (${errorMessage(err)}).`,
    );
  }

  emitOk(emit, verb, { envPath: paths.baseEnvPath });
  return EXIT.OK;
}

/** Read a file we have already established exists; unreadable reads as empty. */
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Verb: --auth-url
// ---------------------------------------------------------------------------

function runAuthUrl(emit: Emit, paths: SetupPaths): number {
  const verb = "auth-url";
  const credentialsStep = stepFor("app-credentials");

  const env = existsSync(paths.baseEnvPath) ? dotenv.parse(safeRead(paths.baseEnvPath)) : {};
  const clientId = (env.FRESHBOOKS_CLIENT_ID ?? "").trim();
  const clientSecret = (env.FRESHBOOKS_CLIENT_SECRET ?? "").trim();

  if (!clientId || !clientSecret) {
    emitErr(
      emit,
      verb,
      EXIT.PRECONDITION,
      credentialsStep.id,
      `No app credentials: ${paths.baseEnvPath} is missing or carries no ` +
        "FRESHBOOKS_CLIENT_ID / FRESHBOOKS_CLIENT_SECRET.",
      "Run --init with the Client ID and Client Secret from the FreshBooks Developer Portal first.",
      `${paths.baseEnvPath} does not provide both app credentials.`,
    );
    return EXIT.PRECONDITION;
  }

  const redirectUri = (env.FRESHBOOKS_REDIRECT_URI ?? "").trim() || REDIRECT_URI;

  try {
    const url = buildAuthUrl(buildOAuthClient(clientId, clientSecret, redirectUri));
    emitOk(emit, verb, { url });
    return EXIT.OK;
  } catch (err) {
    const authorizeStep = stepFor("authorize");
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      authorizeStep.id,
      "The authorization URL could not be built.",
      "Re-run --init to rewrite the base .env, then try --auth-url again.",
      errorMessage(err),
    );
    return EXIT.FAIL;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * An invocation error: exit 2, "fix invocation" (spec exit table).
 *
 * `symptom` states what is wrong with the invocation and `fix` how to correct
 * it; `message` repeats the symptom because for a usage error the symptom IS
 * the technical detail — there is no underlying error to report.
 */
function usage(emit: Emit, verb: string, stepId: string, symptom: string, fix: string): number {
  emitErr(emit, verb, EXIT.USAGE, stepId, symptom, fix, symptom);
  return EXIT.USAGE;
}

/**
 * Run one headless verb. Returns the intended process exit code rather than
 * calling `process.exit`, so a caller can set `process.exitCode` and let stdout
 * flush (a `process.exit()` can truncate piped `--json` output), and so tests
 * can drive it directly.
 */
export async function runHeadless(
  argv: string[],
  paths: SetupPaths = defaultPaths(),
): Promise<number> {
  const parseResult = parseHeadlessArgs(argv);
  const emit: Emit = { json: argv.includes("--json") };

  if (!parseResult.ok) {
    // No verb resolved, so no Book step owns this failure: the envelope keeps
    // its fixed shape with an empty `stepId` rather than naming a step at random.
    return usage(
      emit,
      "headless",
      "",
      parseResult.message,
      "Invoke as `npx ts-node scripts/setup.ts --headless <verb> [--json]` with exactly one verb " +
        "and only that verb's flags.",
    );
  }
  const parsed = parseResult.parsed;
  const verbName = parsed.verb.slice(2);

  // --- Dispatcher-level precondition, before ANY verb ---
  //
  // An unmigrated legacy `.env` is the one state in which every verb is unsafe:
  // its tokens are a live login's only copy, `--init` would overwrite them, and
  // any verb that rotated them while the wizard later migrates would burn the
  // family. The Book records migration as human-only (`migrate-legacy`, who:
  // "human"), so the refusal is uniform and the recovery is the wizard.
  if (legacyEnvNeedsMigration(paths.baseEnvPath)) {
    const step = stepFor("migrate-legacy");
    emitErr(
      emit,
      verbName,
      EXIT.UNMIGRATED,
      step.id,
      step.humanScript[0],
      step.agentGuidance,
      `${paths.baseEnvPath} still holds a single-login refresh token and no ` +
        `${MIGRATED_MARKER} marker.`,
    );
    return EXIT.UNMIGRATED;
  }

  const allowedFlags = VERB_FLAGS[parsed.verb];
  if (allowedFlags) {
    for (const flag of parsed.flags.keys()) {
      if (!allowedFlags.includes(flag)) {
        return usage(
          emit,
          verbName,
          stepIdForVerb(parsed.verb, ""),
          `${parsed.verb} does not take ${flag}.`,
          `Re-run ${parsed.verb} without ${flag}.`,
        );
      }
    }
  }

  try {
    return await dispatch(parsed, emit, paths, verbName);
  } catch (err) {
    // Last line of defense. Without it an unexpected throw would escape to
    // `scripts/setup.ts`'s `main().catch()`, which prints the error OBJECT —
    // and an SDK/axios rejection carries `config.data` (client_secret, code,
    // refresh_token). Only `err.message` ever crosses this boundary.
    emitErr(
      emit,
      verbName,
      EXIT.FAIL,
      stepIdForVerb(parsed.verb, ""),
      `${parsed.verb} failed unexpectedly.`,
      "Re-run the verb; if it fails again, run --doctor and follow the failing check's fix.",
      errorMessage(err),
    );
    return EXIT.FAIL;
  }
}

/** Route one parsed invocation to its verb handler. */
async function dispatch(
  parsed: ParsedArgs,
  emit: Emit,
  paths: SetupPaths,
  verbName: string,
): Promise<number> {
  switch (parsed.verb) {
    case "--init":
      return runInit(parsed, emit, paths);
    case "--auth-url":
      return runAuthUrl(emit, paths);
    default:
      // A verb the Book already names but this build does not implement yet
      // (the remaining Phase-2 tasks fill these in).
      emitErr(
        emit,
        verbName,
        EXIT.FAIL,
        stepIdForVerb(parsed.verb, ""),
        `${parsed.verb} is not implemented in this build.`,
        "Use the interactive wizard (`npm run setup`) for this step until the verb ships.",
        `${parsed.verb} has no handler yet.`,
      );
      return EXIT.FAIL;
  }
}
