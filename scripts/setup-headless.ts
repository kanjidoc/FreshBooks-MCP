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

import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as dotenv from "dotenv";
import { resolveDesktopConfigPath } from "../src/config-paths";
import { decodeJwtExp } from "../src/freshbooks-client";
import {
  isMigrated,
  markDistinctLogin,
  MIGRATED_MARKER,
  ProfileWriteError,
} from "../src/migrate";
import {
  discoverProfiles,
  normalizeProfileName,
  parseProfileConfig,
  type ProfileConfig,
} from "../src/profiles";
import { isServerLockFresh, lockPathFor } from "../src/server-lock";
import { EXIT8_DIRECTIVE, EXIT8_QUESTION, SETUP_FLOW } from "../src/setup-flow";
import {
  assertNoForeignDuplicate,
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  discoverMemberships,
  exchangeCode,
  extractCodeFromUrl,
  listPendings,
  loadPending,
  pendingPath,
  replaceProfileTokens,
  saveProfile,
  shredPending,
  stagePending,
  type Memberships,
  type PendingRecord,
} from "./setup-core";
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

/**
 * The Book's own fix text for one troubleshooting row, looked up by a fragment
 * of its symptom.
 *
 * Envelope `fix` strings are normally written here, but where the Book already
 * words a state for a human — a truncated callback address, a failed account
 * lookup — the envelope quotes the Book rather than paraphrasing it, so the CLI
 * and SETUP.md can never say two different things about the same failure (and a
 * later edit to the row flows into the envelope for free). Missing rows throw:
 * a silent fallback would be exactly the drift this exists to prevent, and the
 * dispatcher turns the throw into a safe envelope.
 */
function bookFix(stepId: string, symptomFragment: string): string {
  const row = stepFor(stepId).troubleshooting.find((t) => t.symptom.includes(symptomFragment));
  if (!row) {
    throw new Error(
      `Book step "${stepId}" has no troubleshooting row matching "${symptomFragment}" — ` +
        "src/setup-flow.ts and this file disagree.",
    );
  }
  return row.fix;
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
  "--add-login": [
    "--name",
    "--callback-url",
    "--business-id",
    "--account-id",
    "--distinct-login",
    "--confirm-different-user",
  ],
  // `--account-id` / `--business-id` are deliberately ABSENT here: for a re-auth
  // discovery IS the wrong-account protection (spec exit-11 row), so there is no
  // way to assert ids past it. See `runReauth`'s ruling 1.
  "--reauth": ["--name", "--callback-url"],
  "--discard-pending": ["--name"],
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

/** The shared app credentials, or null when `--init` has not run. */
interface AppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Read the base `.env`'s app credentials. Returns null when either credential is
 * missing — the `app-credentials` precondition every FreshBooks-touching verb
 * shares. The values are returned, never printed: the secret is a credential the
 * emitters must never see.
 */
function readAppCredentials(paths: SetupPaths): AppCredentials | null {
  const env = existsSync(paths.baseEnvPath) ? dotenv.parse(safeRead(paths.baseEnvPath)) : {};
  const clientId = (env.FRESHBOOKS_CLIENT_ID ?? "").trim();
  const clientSecret = (env.FRESHBOOKS_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: (env.FRESHBOOKS_REDIRECT_URI ?? "").trim() || REDIRECT_URI,
  };
}

/** Exit 7 for a verb that needs app credentials it does not have. */
function missingCredentials(emit: Emit, verb: string, paths: SetupPaths): number {
  emitErr(
    emit,
    verb,
    EXIT.PRECONDITION,
    stepFor("app-credentials").id,
    `No app credentials: ${paths.baseEnvPath} is missing or carries no ` +
      "FRESHBOOKS_CLIENT_ID / FRESHBOOKS_CLIENT_SECRET.",
    "Run --init with the Client ID and Client Secret from the FreshBooks Developer Portal first.",
    `${paths.baseEnvPath} does not provide both app credentials.`,
  );
  return EXIT.PRECONDITION;
}

function runAuthUrl(emit: Emit, paths: SetupPaths): number {
  const verb = "auth-url";

  const credentials = readAppCredentials(paths);
  if (!credentials) return missingCredentials(emit, verb, paths);

  try {
    const url = buildAuthUrl(
      buildOAuthClient(credentials.clientId, credentials.clientSecret, credentials.redirectUri),
    );
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
// Verb: --add-login
// ---------------------------------------------------------------------------
//
// The spec's `--add-login` state machine, in the order it draws it:
//
//   name validated (normalize + availability)  → exit 4, NO code consumed
//   exchange(code)                             → exit 3, nothing staged
//   STAGE profiles/<name>.env.pending          ← before anything that can fail
//   discover (users.me on the staged pair)     → exit 11 / 6 / 8, pending KEPT
//   save via writeNewProfile                   → exit 8 (refused), pending KEPT
//   shred pending                              → exit 0
//
// Two orderings carry the whole design and must not be "tidied":
//
//   1. THE NAME GATE PRECEDES THE EXCHANGE. An authorization code is single-use
//      and lives minutes; discovering the name clash after spending it would
//      send the user back through a browser round-trip for a mistake we could
//      see beforehand.
//   2. STAGING PRECEDES DISCOVERY. Everything after the exchange can fail —
//      a multi-business login, an already-connected company, a 503, a crash —
//      and every one of those failures must leave a resumable token pair on
//      disk rather than a burned grant. That is why the pending is written
//      first and shredded only after the profile write is verified.
//
// A RESUME (`--add-login --name N` with no `--callback-url`) picks that machine
// up at the discover stage, on the pair the interrupted run staged. It has its
// own three load-bearing rules, all in `runAddLoginResume` below: it never
// re-runs the availability gate (that would recreate the exit-4 dead loop the
// crash-idempotence rule exists to prevent), it refuses a pending staged by the
// other verb, and it short-circuits to exit 0 before touching the network when
// the pair it holds is already saved.

/** Flags that belong to a resume, not to the `--callback-url` form. */
const RESUME_ONLY_FLAGS = [
  "--business-id",
  "--account-id",
  "--distinct-login",
  "--confirm-different-user",
];

/**
 * How close to expiry a staged access token may be before a resume renews it.
 *
 * A resume's very next act is a `users.me()` call; a token that expires while
 * that request is in flight would surface as a discovery failure (exit 11) on a
 * perfectly good grant.
 */
const STAGED_TOKEN_BUFFER_SECONDS = 60;

/** A flag's trimmed value, or undefined when the flag was not given. */
function flagValue(parsed: ParsedArgs, flag: string): string | undefined {
  const raw = parsed.flags.get(flag);
  return typeof raw === "string" ? raw.trim() : undefined;
}

async function runAddLogin(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): Promise<number> {
  const verb = "add-login";
  const saveStep = stepFor("save-login");
  const nameStep = stepFor("nickname");

  const rawName = parsed.flags.get("--name");
  if (typeof rawName !== "string") {
    return usage(
      emit,
      verb,
      nameStep.id,
      "--add-login needs a nickname for this login.",
      "Re-run with --name <nickname> — lowercase letters and digits, like acme.",
    );
  }

  const callbackUrl = parsed.flags.get("--callback-url");
  if (typeof callbackUrl !== "string") {
    return runAddLoginResume(parsed, emit, paths, rawName);
  }

  // The two forms consume different flags, and a mixed invocation is ambiguous
  // about which one the agent meant — an `--account-id` alongside a callback
  // URL would look like it skipped discovery when it did not.
  for (const flag of RESUME_ONLY_FLAGS) {
    if (parsed.flags.has(flag)) {
      return usage(
        emit,
        verb,
        saveStep.id,
        `${flag} belongs to a resume, not to the --callback-url form.`,
        `Re-run --add-login with --name and --callback-url only, and drop ${flag}.`,
      );
    }
  }
  return runAddLoginFresh(emit, paths, rawName, callbackUrl);
}

/** The `--callback-url` form: name gate → exchange → stage → discover → save. */
async function runAddLoginFresh(
  emit: Emit,
  paths: SetupPaths,
  rawName: string,
  callbackUrl: string,
): Promise<number> {
  const verb = "add-login";
  const saveStep = stepFor("save-login");
  const nameStep = stepFor("nickname");
  const authorizeStep = stepFor("authorize");

  const credentials = readAppCredentials(paths);
  if (!credentials) return missingCredentials(emit, verb, paths);

  // --- The name gate: both halves run BEFORE the code is spent ---
  let name: string;
  try {
    name = normalizeProfileName(rawName);
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.NAME_TAKEN,
      nameStep.id,
      `"${rawName}" is not a usable name for a login.`,
      "Pick a short nickname of lowercase letters and digits, like acme, and re-run --add-login " +
        "with it. No authorization code was spent, so the pasted address is still good.",
      errorMessage(err),
    );
    return EXIT.NAME_TAKEN;
  }

  if (existsSync(join(paths.profilesDir, `${name}.env`))) {
    emitErr(
      emit,
      verb,
      EXIT.NAME_TAKEN,
      nameStep.id,
      `A login named "${name}" is already saved, and this would overwrite its tokens.`,
      "Pick a different nickname — already yours? run --doctor; reconnecting? use --reauth. " +
        "No authorization code was spent.",
      `${join(paths.profilesDir, `${name}.env`)} already exists.`,
    );
    return EXIT.NAME_TAKEN;
  }

  // --- The exchange: the one step that consumes the code ---
  const code = extractCodeFromUrl(callbackUrl);
  if (!code) {
    emitErr(
      emit,
      verb,
      EXIT.CODE_REJECTED,
      authorizeStep.id,
      "The pasted address carries no authorization code.",
      `${bookFix("authorize", "looks incomplete")} Then re-run --add-login with the whole address.`,
      "No code parameter was found in the --callback-url value.",
    );
    return EXIT.CODE_REJECTED;
  }

  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = await exchangeCode(
      buildOAuthClient(credentials.clientId, credentials.clientSecret, credentials.redirectUri),
      code,
    );
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.CODE_REJECTED,
      authorizeStep.id,
      "FreshBooks rejected that authorization code.",
      "Codes are single-use and live only minutes: run --auth-url again, have the user approve " +
        "the connection afresh, and pass the new address straight to --add-login.",
      errorMessage(err),
    );
    return EXIT.CODE_REJECTED;
  }

  // --- Staging: from here on, every exit leaves a resumable pair on disk ---
  try {
    stagePending(paths.profilesDir, name, {
      mode: "add",
      stagedAt: new Date().toISOString(),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    // The grant exists but nothing holds it, so say so plainly rather than let
    // a resume look possible. The pair itself never reaches the output.
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      saveStep.id,
      `The new login could not be staged in ${paths.profilesDir}, so it cannot be saved or resumed.`,
      "Make sure the project's profiles folder exists and is writable, then run --auth-url and " +
        "--add-login again with a fresh address.",
      errorMessage(err),
    );
    return EXIT.FAIL;
  }

  return discoverAndSave(emit, paths, {
    name,
    credentials,
    pair: tokens,
    businessId: undefined,
    confirmedDistinct: false,
  });
}

/**
 * The resume forms — `--add-login --name N` with no `--callback-url`.
 *
 * Order is the contract here, and each step exists because of a specific way
 * the naive order fails:
 *
 *   1. MODE GATE. A pending staged by `--reauth` holds a pair destined for an
 *      EXISTING profile's token lines. Resuming it under `--add-login` would
 *      write a second profile from it (and shred the pending the real resume
 *      needs), so a cross-verb resume is a usage error, never a best effort.
 *   2. THE PRE-DISCOVERY SHORT-CIRCUIT, before the network and before the
 *      staged-token refresh. If `profiles/<name>.env` already carries the
 *      pending's refresh token, the previous run got as far as the verified
 *      write and died before shredding: the work is done. Without this, that
 *      profile's own accountId trips the same-account branch (exit 8) before
 *      the save stage is ever reached, and the promised idempotent exit 0 is
 *      unreachable.
 *   3. THE STAGED-TOKEN REFRESH, whose rotated pair is re-staged IMMEDIATELY.
 *      The staged pair is its own token family; leaving the old pair in the
 *      pending after a rotation would mean the next resume presents a revoked
 *      refresh token and burns the grant.
 *
 * The availability gate is deliberately absent: re-validating a name that the
 * interrupted run already claimed would refuse every resume with exit 4.
 */
async function runAddLoginResume(
  parsed: ParsedArgs,
  emit: Emit,
  paths: SetupPaths,
  rawName: string,
): Promise<number> {
  const verb = "add-login";
  const saveStep = stepFor("save-login");
  const nameStep = stepFor("nickname");

  let name: string;
  try {
    name = normalizeProfileName(rawName);
  } catch {
    // An unusable name cannot have a pending under it, so this is the same
    // "nothing to resume" state as a missing pending — exit 2, not exit 4.
    return usage(
      emit,
      verb,
      nameStep.id,
      `"${rawName}" is not a usable name for a login, so nothing can be staged under it.`,
      "Re-run the resume with the nickname the interrupted run used — lowercase letters and " +
        "digits, like acme.",
    );
  }

  const pending = loadPending(paths.profilesDir, name);
  if (!pending) {
    const staged = listPendings(paths.profilesDir).map((p) => p.name);
    return usage(
      emit,
      verb,
      saveStep.id,
      `Nothing is staged under the name "${name}", so there is no login to resume.`,
      staged.length
        ? `These logins are staged and can be resumed: ${staged.join(", ")}. To start a new ` +
            "login instead, run --auth-url and pass the pasted address to --add-login --name " +
            "<nickname> --callback-url '<the pasted address>'."
        : "Nothing is staged at all: run --auth-url and pass the pasted address to --add-login " +
            `--name ${name} --callback-url '<the pasted address>' — single-quoted, because the ` +
            "address contains ? and =.",
    );
  }

  // (1) The mode gate — see the cross-verb hazard above.
  if (pending.mode !== "add") {
    return usage(
      emit,
      verb,
      saveStep.id,
      `The pair staged under "${name}" was staged by --reauth, not by --add-login.`,
      `Resume it with --reauth --name ${name}, or clear it with --discard-pending --name ${name}.`,
    );
  }

  const distinctLogin = parsed.flags.has("--distinct-login");
  const confirmedDifferentUser = parsed.flags.has("--confirm-different-user");
  if (distinctLogin && !confirmedDifferentUser) {
    return usage(
      emit,
      verb,
      saveStep.id,
      "--distinct-login was passed without --confirm-different-user.",
      `Ask the user the exit-8 question first and obey its directive: ${EXIT8_DIRECTIVE}. Only ` +
        "with an affirmative reply in hand, re-run the resume with both --distinct-login and " +
        "--confirm-different-user.",
    );
  }

  const accountId = flagValue(parsed, "--account-id");
  const businessId = flagValue(parsed, "--business-id");
  if (accountId === "" || businessId === "") {
    return usage(
      emit,
      verb,
      saveStep.id,
      "--account-id / --business-id was given with an empty value.",
      "Drop the flag to re-run discovery, or re-run the resume with the id it should assert.",
    );
  }

  // (2) The pre-discovery short-circuit — before the network AND before the
  // staged-token refresh.
  //
  // The REFRESH token alone decides this: it is the identity of the token
  // family, and a saved profile whose access token has since been rotated by a
  // running server is still the very profile this resume was going to write.
  const profilePath = join(paths.profilesDir, `${name}.env`);
  const saved = existsSync(profilePath) ? parseProfileConfig(safeRead(profilePath)) : null;
  if (saved && saved.refreshToken === pending.refreshToken) {
    shredPending(paths.profilesDir, name);
    emitOk(emit, verb, {
      name,
      accountId: saved.accountId,
      businessId: saved.businessId,
      profilePath,
    });
    return EXIT.OK;
  }

  const credentials = readAppCredentials(paths);
  if (!credentials) return missingCredentials(emit, verb, paths);

  // (3) The staged-token refresh, re-staged before anything else can fail.
  const renewed = await renewStagedPairIfNeeded(emit, paths, {
    verbFlag: "--add-login",
    name,
    mode: "add",
    credentials,
    pair: { accessToken: pending.accessToken, refreshToken: pending.refreshToken },
  });
  if (!renewed.ok) return renewed.code;
  const pair = renewed.pair;

  // `--account-id` skips discovery entirely: the ids are the user's assertion,
  // which is the whole point of the flag (it is the exit-11 escape hatch).
  if (accountId !== undefined) {
    return saveLogin(emit, paths, {
      name,
      config: { ...pair, accountId, businessId: businessId ?? "" },
      company: undefined,
      confirmedDistinct: distinctLogin && confirmedDifferentUser,
    });
  }

  return discoverAndSave(emit, paths, {
    name,
    credentials,
    pair,
    businessId,
    confirmedDistinct: distinctLogin && confirmedDifferentUser,
  });
}

/**
 * Is this staged access token at (or within a minute of) expiry?
 *
 * An UNDECODABLE token answers false. `isTokenFresh`'s server-side rule is the
 * opposite — there, "cannot prove fresh" must mean "refresh" — but the costs are
 * reversed here: a needless refresh rotates the staged family for nothing and
 * can itself fail (exit 3) on a grant that was fine, while proceeding on a token
 * that turns out to be dead costs one discovery failure whose pending is still
 * resumable. Only a decoded, genuinely-near-expiry `exp` justifies the rotation.
 */
function stagedTokenNeedsRefresh(accessToken: string): boolean {
  const exp = decodeJwtExp(accessToken);
  if (exp === null) return false;
  return exp - Math.floor(Date.now() / 1000) < STAGED_TOKEN_BUFFER_SECONDS;
}

/** A token pair in flight — staged, renewed, or about to be written. */
interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** A staging step's outcome: the pair to carry on with, or the exit code emitted. */
type StagedPair = { ok: true; pair: TokenPair } | { ok: false; code: number };

/**
 * Renew a staged access token that is at (or near) expiry, and re-stage the
 * rotated pair IMMEDIATELY — shared by both resuming verbs, because both fail
 * the same way without it.
 *
 * The staged pair is its own token family: FreshBooks rotates the refresh token
 * on every renewal, so leaving the OLD pair in the pending after a rotation
 * would mean the next resume presents a revoked refresh token and burns the
 * grant. Hence the re-stage happens before anything else can fail, and a failed
 * re-stage is reported rather than swallowed — at that point what is on disk is
 * the revoked pair, and only this process holds the live one.
 *
 * `verbFlag` and `mode` are the only differences between the two callers: the
 * fix texts name the verb the user should re-run, and the re-staged pending must
 * keep the mode marker its own resume path checks.
 */
async function renewStagedPairIfNeeded(
  emit: Emit,
  paths: SetupPaths,
  args: {
    verbFlag: string;
    name: string;
    mode: PendingRecord["mode"];
    credentials: AppCredentials;
    pair: TokenPair;
  },
): Promise<StagedPair> {
  const { verbFlag, name, mode, credentials, pair } = args;
  const verb = verbFlag.slice(2);
  if (!stagedTokenNeedsRefresh(pair.accessToken)) return { ok: true, pair };

  let rotated: TokenPair;
  try {
    const result = await buildTokenClient(
      credentials.clientId,
      credentials.clientSecret,
      credentials.redirectUri,
      pair.accessToken,
      pair.refreshToken,
    ).refreshAccessToken();
    if (!result) throw new Error("FreshBooks returned no tokens for the staged refresh token");
    rotated = { accessToken: result.accessToken, refreshToken: result.refreshToken };
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.CODE_REJECTED,
      stepFor("authorize").id,
      "The staged authorization has expired and FreshBooks would not renew it.",
      `Clear it with --discard-pending --name ${name}, then run --auth-url, have the user ` +
        `approve the connection afresh, and pass the new address to ${verbFlag}.`,
      errorMessage(err),
    );
    return { ok: false, code: EXIT.CODE_REJECTED };
  }

  try {
    stagePending(paths.profilesDir, name, {
      mode,
      stagedAt: new Date().toISOString(),
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
    });
  } catch (err) {
    // The rotation already happened, so what is on disk is a revoked pair and
    // every later resume would fail on it. Say so instead of continuing on a
    // pair only this process holds.
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      stepFor("save-login").id,
      `The renewed authorization could not be re-staged in ${paths.profilesDir}, so the staged ` +
        "pair on disk is the revoked one.",
      `Clear it with --discard-pending --name ${name}, then run --auth-url and pass the new ` +
        `address to ${verbFlag}.`,
      errorMessage(err),
    );
    return { ok: false, code: EXIT.FAIL };
  }
  return { ok: true, pair: rotated };
}

/** What the discover-and-save stage needs, whichever form got it there. */
interface DiscoverAndSaveArgs {
  name: string;
  credentials: AppCredentials;
  pair: { accessToken: string; refreshToken: string };
  /** The membership the resume named (`--business-id`), if it named one. */
  businessId: string | undefined;
  confirmedDistinct: boolean;
}

/**
 * The shared tail of both forms: read this login's businesses, decide which one
 * the profile means, and save it. Every exit from here leaves the staged pair on
 * disk except the ones that finish the job (exit 0) or prove it can never
 * finish (exit 5).
 */
async function discoverAndSave(
  emit: Emit,
  paths: SetupPaths,
  args: DiscoverAndSaveArgs,
): Promise<number> {
  const verb = "add-login";
  const saveStep = stepFor("save-login");
  const { credentials, pair } = args;

  let memberships: Memberships;
  try {
    memberships = await discoverMemberships(
      buildTokenClient(
        credentials.clientId,
        credentials.clientSecret,
        credentials.redirectUri,
        pair.accessToken,
        pair.refreshToken,
      ),
    );
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.DISCOVERY_FAILED,
      saveStep.id,
      "This login's account details could not be read from FreshBooks.",
      `${bookFix("save-login", "exit 11")} The login stays staged, so the authorization is not lost.`,
      errorMessage(err),
    );
    return EXIT.DISCOVERY_FAILED;
  }

  let chosen: Memberships["list"][number] | undefined;
  if (args.businessId !== undefined) {
    // The resume answering exit 6 (or correcting a wrong choice): the named
    // membership must actually be one of this login's, or the ids saved would
    // be a guess.
    chosen = memberships.list.find((m) => m.businessId === args.businessId);
    if (!chosen) {
      emitErr(
        emit,
        verb,
        EXIT.USAGE,
        saveStep.id,
        `This login has no business with id ${args.businessId}.`,
        "Re-run the resume with one of the ids in the memberships payload — ask the user using " +
          "the labels only, numbered, never the ids.",
        `--business-id ${args.businessId} matches none of the ${memberships.list.length} ` +
          "memberships this login returned.",
        { memberships: memberships.list },
      );
      return EXIT.USAGE;
    }
  } else if (memberships.list.length > 1) {
    // An EMPTY list is not a failure — it is an accounting-only login, which
    // legitimately carries no businessId. Only more than one membership is a
    // question, and it is the user's to answer, never this CLI's.
    emitErr(
      emit,
      verb,
      EXIT.BUSINESS_CHOICE,
      saveStep.id,
      "This login belongs to more than one business, so which one this profile means is the " +
        "user's choice.",
      "Ask which business this login is for — relay the labels only, numbered, never the IDs — " +
        "then resume this login with that membership's --business-id.",
      `The login returned ${memberships.list.length} business memberships.`,
      { memberships: memberships.list },
    );
    return EXIT.BUSINESS_CHOICE;
  } else {
    // `chosen` is genuinely absent for an accounting-only login (the empty
    // list), which is why every read of it is optional even though TypeScript
    // types the index access as present: blank IDs are a valid profile, and
    // they throw at call time only if a tool actually needs them.
    chosen = memberships.list[0];
  }

  return saveLogin(emit, paths, {
    name: args.name,
    config: {
      ...pair,
      accountId: chosen?.accountId ?? "",
      businessId: chosen?.businessId ?? "",
    },
    company: chosen?.label,
    confirmedDistinct: args.confirmedDistinct,
  });
}

/**
 * The save stage: `writeNewProfile` through `saveProfile`, plus the backstops
 * the spec draws under it.
 *
 * Every branch here is keyed on `ProfileWriteError.code`, never on its message:
 * the codes are the typed contract, the messages are prose that may be reworded.
 *
 * The same-account decision has exactly ONE implementation — `writeNewProfile`'s
 * own scan, selected by `onSameAccount` — rather than a second scan here. That
 * matters beyond de-duplication: `writeNewProfile` skips the file it is about to
 * write, so a resume whose own `profiles/<name>.env` carries the discovered
 * accountId still reaches the NAME_TAKEN rows below (the crash-idempotent and
 * degenerate-state backstops the spec draws under the save stage), which a scan
 * that treated that file as an incumbent would make unreachable.
 */
function saveLogin(
  emit: Emit,
  paths: SetupPaths,
  args: {
    name: string;
    config: ProfileConfig;
    company: string | undefined;
    confirmedDistinct: boolean;
  },
): number {
  const verb = "add-login";
  const saveStep = stepFor("save-login");
  const { name, config, company } = args;
  const profilePath = join(paths.profilesDir, `${name}.env`);

  try {
    // `onSameAccount: "refuse"` on every UNCONFIRMED path: a company that is
    // already connected must reach a human before a second token family for it
    // is written, because un-quarantining a superseded family is a lockout
    // vector. Only the confirmed distinct-login resume passes "warn".
    const written = saveProfile(paths.profilesDir, name, config, {
      onSameAccount: args.confirmedDistinct ? "warn" : "refuse",
    });
    // The quarantine opt-in covers the whole group, and the fresh scan inside
    // `markDistinctLogin` picks up the file just written. It runs BEFORE the
    // shred so a failure here still leaves a resumable pending.
    if (args.confirmedDistinct) markDistinctLogin(paths.profilesDir, config.accountId);
    shredPending(paths.profilesDir, name);
    emitOk(emit, verb, {
      name,
      company,
      accountId: config.accountId,
      businessId: config.businessId,
      profilePath: written,
    });
    return EXIT.OK;
  } catch (err) {
    if (!(err instanceof ProfileWriteError)) {
      // A genuine write failure leaves the pending in place and travels to the
      // dispatcher's envelope (message only, never the object). Keeping the pair
      // staged through an unexplained failure is exactly why it is staged.
      throw err;
    }

    if (err.code === "SAME_ACCOUNT") {
      return sameAccountRefusal(emit, verb, paths, name, config.accountId, company ?? "");
    }

    if (err.code === "NAME_TAKEN") {
      // The crash-between-save-and-shred case, reached here only when the save
      // landed AFTER this run's short-circuit looked (a concurrent resume).
      // Same pair, same file: the work is done — idempotent success.
      const existing = parseProfileConfig(safeRead(profilePath));
      if (existing && existing.refreshToken === config.refreshToken) {
        shredPending(paths.profilesDir, name);
        emitOk(emit, verb, {
          name,
          company,
          accountId: existing.accountId,
          businessId: existing.businessId,
          profilePath,
        });
        return EXIT.OK;
      }
    }

    // Both remaining codes are degenerate states a resume cannot adjudicate, and
    // both discard the staged pair: the live profile keeps its own token family,
    // so what is staged is a freshly minted grant with nowhere to go.
    shredPending(paths.profilesDir, name);
    const symptom =
      err.code === "NAME_TAKEN"
        ? `A login named "${name}" is already saved with a different token pair.`
        : "Another saved login already holds this staged login's refresh token.";
    emitErr(
      emit,
      verb,
      EXIT.DUP_PAIR,
      saveStep.id,
      symptom,
      `Reconnect the saved login with --reauth --name ${
        err.code === "NAME_TAKEN" ? name : "<that login's nickname>"
      }. But if --doctor shows that profile healthy, the save already completed (a server ` +
        "rotation raced the resume) and nothing more is needed: this exit has already discarded " +
        "the staged pair.",
      err.message,
    );
    return EXIT.DUP_PAIR;
  }
}

/**
 * Exit 8 — this FreshBooks company is already connected under another profile.
 *
 * The payload is Book-authored on purpose (the typed `code`, never the writer's
 * message): `confirmQuestion` is the spec's fully drafted question with the two
 * placeholders filled, and `directive` is the MUST-NOT rule that travels with
 * it. The pending is deliberately left staged — all three recovery branches
 * consume it.
 */
function sameAccountRefusal(
  emit: Emit,
  verb: string,
  paths: SetupPaths,
  name: string,
  accountId: string,
  company: string,
): number {
  const saveStep = stepFor("save-login");
  const existingProfile = findProfileWithAccountId(paths.profilesDir, accountId, name);

  if (!existingProfile) {
    // The writer refused on a profile that a fresh scan cannot find: the
    // directory changed underneath us. Report it as the unexpected state it is
    // rather than ask a human a question with a blank in it.
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      saveStep.id,
      "The save was refused as an already-connected company, but no profile carries that " +
        "account any more.",
      "Run --doctor to see the current profiles, then resume or discard this staged login.",
      `No profiles/*.env in ${paths.profilesDir} carries accountId ${accountId}.`,
    );
    return EXIT.FAIL;
  }

  emitErr(
    emit,
    verb,
    EXIT.SAME_ACCOUNT,
    saveStep.id,
    `This FreshBooks company is already connected as "${existingProfile}".`,
    `Relay confirmQuestion to the user word for word, then obey the directive: ${EXIT8_DIRECTIVE}.`,
    `profiles/${name}.env was not written: accountId ${accountId} already belongs to ` +
      `profiles/${existingProfile}.env.`,
    {
      existingProfile,
      // The company label is unknown only on the `--account-id` resume, which
      // asserts ids without a discovery call to name them. The question must
      // still read as a sentence a human can answer, so the placeholder gets a
      // truthful description rather than a blank or an id.
      confirmQuestion: EXIT8_QUESTION.replace(
        "<company>",
        company || "the company on this login",
      ).replace("<existing profile>", existingProfile),
      directive: EXIT8_DIRECTIVE,
    },
  );
  return EXIT.SAME_ACCOUNT;
}

/**
 * The name of the first OTHER saved profile using `accountId`, or null.
 *
 * A FRESH directory scan, never the memoized registry — the same rule
 * `markDistinctLogin` follows, and for the same reason: a snapshot taken before
 * this run would miss a profile written since. Only `*.env` files are read, so
 * a staged `<name>.env.pending` can never name itself as the incumbent.
 *
 * `exclude` is the profile being written, skipped for the same reason
 * `writeNewProfile`'s own scan skips it: it is not the incumbent this collision
 * is about, and reporting it would name the file the caller is trying to create.
 */
function findProfileWithAccountId(
  profilesDir: string,
  accountId: string,
  exclude: string,
): string | null {
  if (!accountId || !existsSync(profilesDir)) return null;
  for (const file of readdirSync(profilesDir).sort()) {
    if (!file.endsWith(".env") || file === `${exclude}.env`) continue;
    const config = parseProfileConfig(safeRead(join(profilesDir, file)));
    if (config?.accountId === accountId) return file.slice(0, -".env".length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verb: --reauth
// ---------------------------------------------------------------------------
//
// Re-auth is `--add-login`'s discipline pointed at a login that already exists
// (spec §Surface 2, the `--reauth` row):
//
//   name must EXIST                            → exit 2, pointing at --add-login
//   exchange(code)                             → exit 3, nothing staged
//   STAGE profiles/<name>.env.pending (reauth) ← before anything that can fail
//   discover (users.me on the staged pair)     → exit 11, pending KEPT
//   SET-CONTAINMENT: the stored accountId is among the memberships
//                                              → exit 12 on a miss, pending KEPT
//   duplicate-token guard vs OTHER profiles    → exit 5
//   replace ONLY the token lines + shred the pending → exit 0
//
// Four rulings separate it from `--add-login` and must not be "tidied":
//
//   1. THERE IS NO DISCOVERY SKIP. `--add-login` offers `--account-id` as its
//      exit-11 escape hatch; for a re-auth discovery IS the wrong-account
//      protection, so the flag is deliberately absent (`VERB_FLAGS`) and a
//      persistent failure is retried later or discarded.
//   2. A LIVE SERVER WARNS, NEVER REFUSES. The dominant trigger for a re-auth is
//      a dead token family, which no running server can revert; racing a live
//      one costs at worst a working login on the OLD family — never a lockout.
//      So the lock produces the spec's restart sentence and the run continues.
//   3. THE IDS ARE NEVER REWRITTEN. Containment proves the login still holds the
//      saved account; it does not license changing which account the profile
//      means. A login that moved accounts is a new profile, not a re-auth.
//   4. THE REPLACE IS THE GUARDED WRITER (`replaceProfileTokens`), which also
//      shreds `<profile>.rescue` as superseded (Security §rescue-file
//      lifecycle's precedence rule). That shred lives inside the core function
//      on purpose — every guarded token write owes it, not just this verb.

async function runReauth(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): Promise<number> {
  const verb = "reauth";
  const saveStep = stepFor("save-login");
  const nameStep = stepFor("nickname");

  const rawName = parsed.flags.get("--name");
  if (typeof rawName !== "string") {
    return usage(
      emit,
      verb,
      nameStep.id,
      "--reauth needs the nickname of the login to reconnect.",
      "Re-run with --name <nickname>; --doctor lists the saved logins by nickname.",
    );
  }

  let name: string;
  try {
    name = normalizeProfileName(rawName);
  } catch {
    // An unusable name cannot belong to a saved profile, so this is the same
    // "nothing to reconnect" state as a missing file: exit 2 pointing at the
    // verb that CREATES logins (spec exit-2 row).
    return noSuchLogin(emit, paths, rawName);
  }

  const profilePath = join(paths.profilesDir, `${name}.env`);
  if (!existsSync(profilePath)) return noSuchLogin(emit, paths, name);

  const stored = parseProfileConfig(safeRead(profilePath));
  if (!stored) {
    // The file is there but carries no token pair, so there is nothing to
    // replace in place — `applyTokensToEnv` would refuse a moment later anyway,
    // and refusing here keeps an authorization code from being spent on it.
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      saveStep.id,
      `The file profiles/${name}.env carries no token pair, so there is nothing to reconnect.`,
      "Run --doctor — it reports the malformed profile. Repair or remove that file, then add " +
        "the login with --add-login.",
      `${profilePath} has no FRESHBOOKS_ACCESS_TOKEN / FRESHBOOKS_REFRESH_TOKEN pair.`,
    );
    return EXIT.FAIL;
  }

  // Ruling 2 — before any network call and before any write, never a refusal.
  warnIfServerIsRunning(paths);

  const credentials = readAppCredentials(paths);
  if (!credentials) return missingCredentials(emit, verb, paths);

  const callbackUrl = parsed.flags.get("--callback-url");
  const staged =
    typeof callbackUrl === "string"
      ? await exchangeAndStageReauth(emit, paths, name, callbackUrl, credentials)
      : await resumeStagedReauth(emit, paths, name, credentials);
  if (!staged.ok) return staged.code;

  return discoverAndReplace(emit, paths, {
    name,
    profilePath,
    stored,
    credentials,
    pair: staged.pair,
  });
}

/** Exit 2 — `--reauth` names a login that is not saved (spec exit-2 row). */
function noSuchLogin(emit: Emit, paths: SetupPaths, name: string): number {
  const saved = savedProfileNames(paths.profilesDir);
  return usage(
    emit,
    "reauth",
    stepFor("nickname").id,
    `No login named "${name}" is saved, so there is nothing to reconnect.`,
    (saved.length
      ? `These logins are saved: ${saved.join(", ")}. Re-run --reauth with one of those names. `
      : "No logins are saved yet. ") +
      "To connect a NEW login, run --auth-url and pass the pasted address to --add-login --name " +
      "<nickname> --callback-url '<the pasted address>'.",
  );
}

/** The nicknames of every saved profile — a fresh scan, never the registry. */
function savedProfileNames(profilesDir: string): string[] {
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir)
    .filter((file) => file.endsWith(".env"))
    .sort()
    .map((file) => file.slice(0, -".env".length));
}

/**
 * The live-server warning (ruling 2). Stderr in BOTH output modes: it is a human
 * warning, and a `--json` run's stdout must stay exactly one object per
 * emission. The restart sentence is the spec's own words.
 */
function warnIfServerIsRunning(paths: SetupPaths): void {
  if (!isServerLockFresh(lockPathFor(paths.rootDir))) return;
  console.error(
    "Warning: a FreshBooks MCP server is running from this project folder. The re-auth is not " +
      "refused for that — the new tokens are written either way — but restart Claude after " +
      "re-auth so it picks up the new login.",
  );
}

/** The `--callback-url` form: exchange the code, stage the pair as `reauth`. */
async function exchangeAndStageReauth(
  emit: Emit,
  paths: SetupPaths,
  name: string,
  callbackUrl: string,
  credentials: AppCredentials,
): Promise<StagedPair> {
  const verb = "reauth";
  const authorizeStep = stepFor("authorize");

  const code = extractCodeFromUrl(callbackUrl);
  if (!code) {
    emitErr(
      emit,
      verb,
      EXIT.CODE_REJECTED,
      authorizeStep.id,
      "The pasted address carries no authorization code.",
      `${bookFix("authorize", "looks incomplete")} Then re-run --reauth with the whole address.`,
      "No code parameter was found in the --callback-url value.",
    );
    return { ok: false, code: EXIT.CODE_REJECTED };
  }

  let tokens: TokenPair;
  try {
    tokens = await exchangeCode(
      buildOAuthClient(credentials.clientId, credentials.clientSecret, credentials.redirectUri),
      code,
    );
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.CODE_REJECTED,
      authorizeStep.id,
      "FreshBooks rejected that authorization code.",
      "Codes are single-use and live only minutes: run --auth-url again, have the user approve " +
        "the connection afresh, and pass the new address straight to --reauth.",
      errorMessage(err),
    );
    return { ok: false, code: EXIT.CODE_REJECTED };
  }

  // From here on every exit leaves a resumable pair on disk — the same ordering
  // rule `--add-login` follows, and for the same reason.
  try {
    stagePending(paths.profilesDir, name, {
      mode: "reauth",
      stagedAt: new Date().toISOString(),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      stepFor("save-login").id,
      `The new authorization could not be staged in ${paths.profilesDir}, so it can neither be ` +
        "installed nor resumed.",
      "Make sure the project's profiles folder exists and is writable, then run --auth-url and " +
        "--reauth again with a fresh address.",
      errorMessage(err),
    );
    return { ok: false, code: EXIT.FAIL };
  }
  return { ok: true, pair: tokens };
}

/**
 * The resume form — `--reauth --name N` with no `--callback-url`.
 *
 * The MODE GATE is the exact mirror of the add-login resume's: a pending staged
 * by `--add-login` holds a pair destined to become a NEW profile. Installing it
 * over an existing login's token lines would overwrite a live family with one
 * that was never meant for it (and shred the pending the real resume needs), so
 * a cross-verb resume is a usage error, never a best effort.
 *
 * There is deliberately no pre-discovery short-circuit here: unlike a save, a
 * replace is idempotent — re-running it writes the same two lines — so the
 * crashed-between-write-and-shred case needs no special branch.
 */
async function resumeStagedReauth(
  emit: Emit,
  paths: SetupPaths,
  name: string,
  credentials: AppCredentials,
): Promise<StagedPair> {
  const verb = "reauth";
  const saveStep = stepFor("save-login");

  const pending = loadPending(paths.profilesDir, name);
  if (!pending) {
    const stagedNames = listPendings(paths.profilesDir).map((p) => p.name);
    return {
      ok: false,
      code: usage(
        emit,
        verb,
        saveStep.id,
        `Nothing is staged under the name "${name}", so there is no re-auth to resume.`,
        stagedNames.length
          ? `These logins are staged and can be resumed: ${stagedNames.join(", ")}. To reconnect ` +
              `"${name}" instead, run --auth-url and pass the pasted address to --reauth --name ` +
              `${name} --callback-url '<the pasted address>'.`
          : "Nothing is staged at all: run --auth-url and pass the pasted address to --reauth " +
              `--name ${name} --callback-url '<the pasted address>' — single-quoted, because ` +
              "the address contains ? and =.",
      ),
    };
  }

  if (pending.mode !== "reauth") {
    return {
      ok: false,
      code: usage(
        emit,
        verb,
        saveStep.id,
        `The pair staged under "${name}" was staged by --add-login, not by --reauth.`,
        `Resume it with --add-login --name ${name}, or clear it with --discard-pending --name ` +
          `${name}.`,
      ),
    };
  }

  return renewStagedPairIfNeeded(emit, paths, {
    verbFlag: "--reauth",
    name,
    mode: "reauth",
    credentials,
    pair: { accessToken: pending.accessToken, refreshToken: pending.refreshToken },
  });
}

/**
 * The shared tail of both forms: read this login's businesses, prove they still
 * include the account this profile means, and swap the token lines in place.
 *
 * Every exit from here keeps the staged pair except the two that end its life:
 * exit 0 (installed) and exit 5 (a pair that can never be installed anywhere).
 */
async function discoverAndReplace(
  emit: Emit,
  paths: SetupPaths,
  args: {
    name: string;
    profilePath: string;
    stored: ProfileConfig;
    credentials: AppCredentials;
    pair: TokenPair;
  },
): Promise<number> {
  const verb = "reauth";
  const saveStep = stepFor("save-login");
  const { name, profilePath, stored, credentials, pair } = args;

  let memberships: Memberships;
  try {
    memberships = await discoverMemberships(
      buildTokenClient(
        credentials.clientId,
        credentials.clientSecret,
        credentials.redirectUri,
        pair.accessToken,
        pair.refreshToken,
      ),
    );
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.DISCOVERY_FAILED,
      saveStep.id,
      "This login's account details could not be read from FreshBooks.",
      `${bookFix("save-login", "exit 11")} Retry with --reauth --name ${name} — the ` +
        "authorization stays staged, so it is not lost. A re-auth deliberately offers no way to " +
        "skip this lookup: it is what proves the new tokens belong to this login. If it keeps " +
        `failing, retry later or clear the staged pair with --discard-pending --name ${name}.`,
      errorMessage(err),
    );
    return EXIT.DISCOVERY_FAILED;
  }

  // --- SET-CONTAINMENT: is the login just authorized still this profile's? ---
  //
  // Containment, not equality: a login may belong to several businesses, and the
  // profile means exactly one of them. A BLANK stored accountId — the legitimate
  // accounting-only profile — has nothing to contain, so the check is skipped
  // with a warning rather than failing a profile that never had an id.
  let company: string | undefined;
  if (!stored.accountId) {
    console.error(
      `Warning: profiles/${name}.env records no FRESHBOOKS_ACCOUNT_ID, so this re-auth cannot ` +
        "check that the authorization is for the same FreshBooks account. Installing the new " +
        "tokens anyway — run --doctor afterwards to confirm the login is the one you meant.",
    );
  } else {
    const match = memberships.list.find((m) => m.accountId === stored.accountId);
    if (!match) {
      emitErr(
        emit,
        verb,
        EXIT.REAUTH_MISMATCH,
        saveStep.id,
        `The authorization just approved is for a different FreshBooks account than the one ` +
          `saved as "${name}", so it was not installed.`,
        `Sign in as the account "${name}" belongs to — a private/incognito window helps when a ` +
          "different account is already signed in — then run --auth-url and --reauth --name " +
          `${name} again; a fresh authorization overwrites the staged one. If this login really ` +
          `is a different account, clear the staged pair with --discard-pending --name ${name} ` +
          "and add it with --add-login instead.",
        `None of the ${memberships.list.length} businesses this authorization returned carries ` +
          `the account id saved in profiles/${name}.env.`,
      );
      return EXIT.REAUTH_MISMATCH;
    }
    company = match.label;
  }

  // The duplicate-token guard `writeNewProfile` runs for a new profile. A
  // re-auth writes in place and never reaches that writer, so the guard is
  // called here — same code, same message (`assertNoForeignDuplicate`).
  try {
    assertNoForeignDuplicate(paths.profilesDir, name, pair.refreshToken);
  } catch (err) {
    if (!(err instanceof ProfileWriteError)) throw err;
    // Exit-5 semantics: the staged pair can never be installed anywhere (another
    // file already holds it, so it is not lost by being discarded), and leaving
    // it would only fail identically on every resume.
    shredPending(paths.profilesDir, name);
    emitErr(
      emit,
      verb,
      EXIT.DUP_PAIR,
      saveStep.id,
      "Another saved login already holds the token pair this authorization minted.",
      "Run --doctor: two profile files sharing one refresh token is the state it reports and " +
        "explains. Once it is resolved, re-run --auth-url and --reauth for this login. This " +
        "exit has already discarded the staged pair.",
      err.message,
    );
    return EXIT.DUP_PAIR;
  }

  try {
    // The guarded writer (ruling 4): applyTokensToEnv + writeAtomic + read-back,
    // touching ONLY the two token lines, and shredding a superseded `.rescue`.
    replaceProfileTokens(profilePath, pair.accessToken, pair.refreshToken);
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      saveStep.id,
      `The new tokens could not be written into profiles/${name}.env.`,
      `Make sure that file is writable, then resume with --reauth --name ${name} — the ` +
        "authorization stays staged. If it keeps failing, run --doctor.",
      errorMessage(err),
    );
    return EXIT.FAIL;
  }

  shredPending(paths.profilesDir, name);
  warnIfQuarantined(paths, name);

  // The ids are the profile's own (ruling 3); `company` is the membership the
  // containment check matched, and is absent when that check was skipped.
  emitOk(emit, verb, {
    name,
    company,
    accountId: stored.accountId,
    businessId: stored.businessId,
    profilePath,
  });
  return EXIT.OK;
}

/**
 * A re-auth on a QUARANTINED profile works — the fresh family is exactly what a
 * quarantined profile needs — but the quarantine itself is about a same-company
 * collision between two files and outlives any token swap. Saying so on success
 * is the difference between "it worked" and "it worked, and the thing you were
 * probably trying to fix is still there" (spec: "the message says so").
 *
 * A fresh scan, never the memoized registry, and never fatal: this runs AFTER a
 * verified write, so a scan failure must not turn a completed re-auth into one
 * that reports failure.
 */
function warnIfQuarantined(paths: SetupPaths, name: string): void {
  const fix = bookFix("save-login", "quarantined profile mentioned");
  let quarantined: boolean;
  try {
    const found = discoverProfiles(paths.profilesDir, paths.baseEnvPath).profiles.get(name);
    quarantined = found?.quarantined === true;
  } catch {
    return;
  }
  if (!quarantined) return;
  console.error(`Note: profiles/${name}.env stays quarantined. ${fix}`);
}

// ---------------------------------------------------------------------------
// Verb: --discard-pending
// ---------------------------------------------------------------------------

/**
 * Shred a staged pair. The exit from every branch that "cannot be resumed after
 * all" — a wrong-account re-auth, an abandoned add — plus the doctor's fix for a
 * stale pending.
 *
 * EXISTENCE, not `loadPending`, decides whether there is something to discard: a
 * pending whose markers are damaged reads as null there while still holding a
 * live token pair on disk, and clearing exactly that file is what this verb is
 * for (`listPendings` reports such files for the same reason).
 */
function runDiscardPending(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): number {
  const verb = "discard-pending";
  const saveStep = stepFor("save-login");
  const nameStep = stepFor("nickname");

  const rawName = parsed.flags.get("--name");
  if (typeof rawName !== "string") {
    return usage(
      emit,
      verb,
      nameStep.id,
      "--discard-pending needs the nickname whose staged pair should be cleared.",
      "Re-run with --name <nickname>; --doctor names the logins that have a staged pair.",
    );
  }

  let name: string;
  try {
    name = normalizeProfileName(rawName);
  } catch {
    return usage(
      emit,
      verb,
      nameStep.id,
      `"${rawName}" is not a usable name for a login, so nothing can be staged under it.`,
      "Re-run --discard-pending with the nickname the interrupted run used — lowercase letters " +
        "and digits, like acme.",
    );
  }

  if (!existsSync(pendingPath(paths.profilesDir, name))) {
    const stagedNames = listPendings(paths.profilesDir).map((p) => p.name);
    return usage(
      emit,
      verb,
      saveStep.id,
      `Nothing is staged under the name "${name}", so there is nothing to discard.`,
      stagedNames.length
        ? `These logins have a staged pair: ${stagedNames.join(", ")}. Re-run --discard-pending ` +
            "with one of those names."
        : "No login has a staged pair, so there is nothing to clear anywhere.",
    );
  }

  try {
    shredPending(paths.profilesDir, name);
  } catch (err) {
    emitErr(
      emit,
      verb,
      EXIT.FAIL,
      saveStep.id,
      `The staged pair under "${name}" could not be deleted, so it still holds a live token pair.`,
      `Delete ${pendingPath(paths.profilesDir, name)} by hand, then continue.`,
      errorMessage(err),
    );
    return EXIT.FAIL;
  }

  // The honesty note (spec verb table). Stderr in both modes: the `--json` shape
  // for this verb is `{name, discarded:true}` and nothing else.
  console.error(
    "Note: this removed the staged token pair from this computer — it does not revoke the grant " +
      "server-side. The authorization the user approved stays live at FreshBooks until it " +
      "expires or is revoked there.",
  );
  emitOk(emit, verb, { name, discarded: true });
  return EXIT.OK;
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
    case "--add-login":
      return runAddLogin(parsed, emit, paths);
    case "--reauth":
      return runReauth(parsed, emit, paths);
    case "--discard-pending":
      return runDiscardPending(parsed, emit, paths);
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
