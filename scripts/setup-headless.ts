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
 *  2. OUTPUT IS AN ALLOWLIST. `emitOk`/`emitErr`/`emitDoctor` are the ONLY
 *     structured output surface, and each projects its fields onto a fixed key
 *     list (spec §"--json shapes"). A caught error object, an axios response,
 *     or a stray token handed to an emitter is dropped rather than printed —
 *     an axios error
 *     carries `config.data` (client_secret, code, refresh_token) and an
 *     `Authorization` header, so "just serialize the error" is a credential
 *     leak, not a debugging convenience.
 *  3. HUMAN → STDERR, `--json` → STDOUT (`scripts/refresh-tokens.ts:15-16`),
 *     and never both: a `--json` run's stdout is exactly one JSON object per
 *     emission, so an agent can parse it without stripping prose.
 *  4. NO PROCESS SPAWNING. This module deliberately imports no child-process
 *     API: `--auth-url` prints a URL and never opens a browser (the Book's
 *     `authorize` step: "never open a browser yourself"), and a test asserts
 *     the absence structurally. The one verb that must reach an external
 *     program — `--install code`, which registers through the `claude` CLI —
 *     goes through `setup-core`'s `isClaudeCliAvailable`/`claudeMcpAddJson`
 *     seam, so the spawn stays in one reviewable place and a test can stub it
 *     rather than execute a real CLI.
 *
 * Exit codes are the spec's table (§"Exit codes"), exported as `EXIT`.
 */

import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import * as dotenv from "dotenv";
import { resolveDesktopConfigPath } from "../src/config-paths";
import { decodeJwtExp, inspectTokenHealth } from "../src/freshbooks-client";
import { buildClaudeServerConfig } from "../src/mcp-config";
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
  PROFILE_NAME_RE,
  type DiscoveryResult,
  type ProfileConfig,
  type ProfileState,
} from "../src/profiles";
import { isServerLockFresh, lockPathFor } from "../src/server-lock";
import {
  EXIT8_DIRECTIVE,
  EXIT8_QUESTION,
  SETUP_FLOW,
  type SetupCtx,
} from "../src/setup-flow";
import {
  assertNoForeignDuplicate,
  buildAuthUrl,
  buildOAuthClient,
  buildTokenClient,
  claudeMcpAddJson,
  discoverMemberships,
  exchangeCode,
  extractCodeFromUrl,
  installDesktop,
  installMcpJson,
  isClaudeCliAvailable,
  listPendings,
  loadPending,
  pendingPath,
  replaceProfileTokens,
  saveProfile,
  shredPending,
  stagePending,
  writeCredentialFile,
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
 * The doctor's report — the one emission whose `ok` is DATA rather than the
 * run's success (spec §"--json shapes": `doctor: {ok, checks:[…]}`). A doctor
 * that found problems still ran correctly, so it is neither an `emitOk` (which
 * hardcodes `ok: true`) nor an `emitErr` (whose single `stepId`/`symptom`/`fix`
 * envelope cannot carry a list of checks).
 *
 * It goes through the SAME `project` allowlist as the other two emitters — the
 * check objects are plain data by construction, and the projection is what keeps
 * that true if a future check ever tried to carry something richer.
 */
export function emitDoctor(e: Emit, report: DoctorReport): void {
  const projected = project({ checks: report.checks }, SUCCESS_FIELDS);
  if (e.json) {
    console.log(JSON.stringify({ ok: report.ok, verb: "doctor", ...projected }));
    return;
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of report.checks) counts[c.status] += 1;
  // Only non-empty buckets are named: the Book's `verify` step promises "Every
  // line should say pass", and a summary reading "0 fail" on a clean run would
  // put the word on a line that is supposed to be reassuring.
  const tally = [`${counts.pass} pass`];
  if (counts.warn) tally.push(`${counts.warn} warn`);
  if (counts.fail) tally.push(`${counts.fail} fail`);
  console.error(`doctor: ${report.ok ? "OK" : "ISSUES FOUND"} — ${tally.join(", ")}`);

  for (const c of report.checks) {
    console.error(`  ${c.status.padEnd(4)} ${c.id} [${c.stepId}]: ${c.detail}`);
    if (c.fix) console.error(`       fix: ${c.fix}`);
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
 * (`src/setup-flow.ts`) — a non-empty `FRESHBOOKS_REFRESH_TOKEN=` line AND no
 * `FRESHBOOKS_MIGRATED` marker. Exported because three surfaces must agree on
 * it byte for byte: this dispatcher (which refuses), `--doctor` (which reports
 * it), and the wizard, which calls this to fill `ctx.legacyNeedsMigration`
 * before rendering its checklist or offering the migration
 * (`runWizard` in `scripts/setup.ts`). A surface that re-derives the predicate
 * instead of calling this is how the three drift apart.
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
  "--install": ["--command-path", "--trust-exec-path"],
  "--print-config": ["--command-path", "--trust-exec-path"],
  "--discard-pending": ["--name"],
  // The doctor takes no flags: it reports on everything it can see, and a
  // `--name` on it would look like a filter this surface does not offer.
  "--doctor": [],
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
 * The one wording for "the secret file is still on disk and only you can remove
 * it". Shared by the read path and every refusal path so a user who hits either
 * is told the same thing about the same file.
 */
function warnSecretFileSurvived(file: string, detail: string): void {
  console.error(
    `FATAL: could not delete the client-secret file ${file} (${detail}) — ` +
      "it still holds your app secret. Delete it yourself now.",
  );
}

/**
 * The value of `--client-secret-file` as it appears in raw argv.
 *
 * Read from argv rather than the parsed flags because the earliest refusal —
 * an invocation that does not parse at all — has no parsed flags, and that run
 * received the file just the same. The last occurrence wins, mirroring the
 * parser, and a value that is itself part of the grammar is rejected the same
 * way the parser rejects it (so `--client-secret-file --json` deletes nothing).
 */
function secretFileArg(argv: string[]): string | undefined {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    if (argv[i] !== "--client-secret-file") continue;
    const value = argv[i + 1];
    return value !== undefined && !isKnownToken(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Delete a `--client-secret-file` on a path that is REFUSING before the
 * read-once-then-delete choreography could run.
 *
 * SECRETS_RULES promises the CLI deletes the file itself, and every refusal here
 * means "come back later" — which is exactly how long a live app secret would
 * otherwise sit at whatever permissions the agent's shell gave it. The refusal's
 * own exit code still stands: a failed delete is reported loudly rather than
 * turned into a different verdict, because what the user must act on is the
 * refusal AND the leftover file, not one instead of the other.
 */
function shredUnreadSecretFile(file: string | undefined): void {
  if (file === undefined) return;
  try {
    rmSync(file, { force: true });
  } catch (err) {
    warnSecretFileSurvived(file, errorMessage(err));
  }
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

  // Both refusals below happen BEFORE the secret file would be read, so each
  // shreds it itself — the file must not outlive a run that told the caller to
  // fix its invocation and come back.
  const secretFile = parsed.flags.has("--client-secret-file")
    ? String(parsed.flags.get("--client-secret-file"))
    : undefined;

  const clientId = String(parsed.flags.get("--client-id") ?? "").trim();
  if (!clientId) {
    shredUnreadSecretFile(secretFile);
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
    shredUnreadSecretFile(secretFile);
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
      warnSecretFileSurvived(file, result.rmError);
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
    // 0600 AT CREATION, and an existing file tightened BEFORE the new secret
    // lands (Security §Permissions) — both live in `writeCredentialFile` so the
    // wizard's own `.env` write cannot drift from this one.
    writeCredentialFile(paths.baseEnvPath, serializeEnv(vars));
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

  // `writeCredentialFile` already tightened the file, before and at creation.
  // This re-assert exists only to SAY SO when the mode did not stick — a file
  // we do not own, an exotic filesystem — because the secret is on disk by now
  // and silence would be the one thing the user cannot recover from.
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
// Verbs: --install and --print-config
// ---------------------------------------------------------------------------
//
// Both verbs answer the same question — "what entry connects this build to
// Claude, and where does it go?" — and differ only in whether they write it.
// Three rulings hold them together:
//
//   1. ONE COMMAND-SELECTION RULE, shared. `--print-config` is the degraded
//      path's lawful source when a denied permission means `--install` never
//      ran, so a block it emits must name the same `node` the install would
//      have written. Two rules would mean the by-hand file and the automatic
//      one disagree about what launches the server.
//   2. `--print-config` READS NOTHING. The entry is `{command, args}` with a
//      deliberate no-`env` design, so producing it never requires knowing what
//      the user's config already contains — which is what makes the read-only
//      claim structural rather than a promise. (The dispatcher's exit-9
//      precondition does read the base `.env`; that is a different file and a
//      different question.)
//   3. A FAILED WRITE HANDS BACK ITS RAW MATERIAL. Exit 10 carries
//      `{configBlock, path}` precisely so the agent can switch to the by-hand
//      route without re-running anything — and a refusal never overwrites the
//      file it could not parse, because the neighbours in it may be the only
//      copy of another connector's configuration.

/** The install targets (spec verb table). `both` = desktop + code. */
const INSTALL_TARGETS = ["desktop", "code", "mcp-json", "both"] as const;
type InstallTarget = (typeof INSTALL_TARGETS)[number];
/** A target that names exactly one config location — what `both` fans out to. */
type ConcreteTarget = Exclude<InstallTarget, "both">;

/**
 * Where a host `node` normally lives, in probe order (spec §verb table).
 *
 * Probing beats `process.execPath` by default because a sandboxed agent's
 * `execPath` may be an interpreter that only exists inside its sandbox; writing
 * that path into the host's Claude config produces an entry that cannot start.
 * `--trust-exec-path` is how a caller on a real host shell opts out.
 */
export const NODE_PROBE_PATHS: string[] = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/** Said out loud whenever the entry falls back to the bare `node`. */
const BARE_COMMAND_CAVEAT =
  'No absolute node was found at the standard locations, so this entry launches the bare command "node" — ' +
  "it works only if Claude starts with a PATH that includes node. If the server does not appear after a " +
  "restart, re-run --install with --command-path <absolute path to node>.";

/**
 * The open-this-folder script the spec's code branch calls for. Its wording
 * mirrors the wizard's long-standing manual text — which now renders from the
 * Book's `install-config` humanScript — rather than inventing a second way to
 * say the same thing.
 */
const OPEN_THIS_FOLDER_SCRIPT =
  'Claude Code: open this folder as your project in Claude Code and enable the "freshbooks" server when ' +
  "prompted. To make it available in every project instead, install the `claude` command-line tool and " +
  "re-run --install code.";

/** What an agent does with an exit-10 payload (spec §install-config choreography). */
const INSTALL_FAILED_FIX =
  "Re-running --install will not fix this — switch to the degraded path: disclose that the file may hold " +
  "other connectors' access keys, get the file's current contents, merge the configBlock in this payload " +
  "into it without altering any other entry, and hand back the complete file for the user to paste.";

/**
 * Which `node` the written entry should launch.
 *
 * `exists` is an injected seam so the probe order is testable without depending
 * on what happens to be installed on the machine running the tests; production
 * callers take the default.
 */
export function selectCommandPath(
  opts: { trustExecPath?: boolean; override?: string },
  exists: (candidate: string) => boolean = existsSync,
): { command: string; caveat?: string } {
  if (opts.override) return { command: opts.override };
  if (opts.trustExecPath) return { command: process.execPath };
  for (const candidate of NODE_PROBE_PATHS) {
    if (exists(candidate)) return { command: candidate };
  }
  return { command: "node", caveat: BARE_COMMAND_CAVEAT };
}

/** The complete block a human pastes for one target — the by-hand raw material. */
function renderConfigBlock(projectDir: string, command: string): string {
  return JSON.stringify(
    { mcpServers: { freshbooks: buildClaudeServerConfig(projectDir, command) } },
    null,
    2,
  );
}

/**
 * Which file a target's block belongs in.
 *
 * `code` answers with the project-scoped `.mcp.json`, not `~/.claude.json`:
 * Claude Code's user scope is the CLI's to own, so the by-hand route — the only
 * route this path is ever used for — is the project file.
 */
function configPathFor(target: ConcreteTarget, paths: SetupPaths): string {
  return target === "desktop" ? paths.desktopConfigPath : paths.mcpJsonPath;
}

/** `both` is the only target that fans out. */
function expandTarget(target: InstallTarget): ConcreteTarget[] {
  return target === "both" ? ["desktop", "code"] : [target];
}

type TargetArgs =
  | { ok: true; target: InstallTarget; command: string }
  | { ok: false; code: number };

/**
 * The grammar both verbs share: a valid target, and the command selection —
 * whose caveat, when there is one, is stated on the human channel in BOTH
 * output modes (the `--json` shapes for these verbs are fixed, so a caveat
 * cannot ride along inside them).
 */
function resolveTargetAndCommand(parsed: ParsedArgs, emit: Emit, verb: string): TargetArgs {
  const step = stepFor("install-config");

  const target = parsed.verbValue as InstallTarget | undefined;
  if (!target || !(INSTALL_TARGETS as readonly string[]).includes(target)) {
    return {
      ok: false,
      code: usage(
        emit,
        verb,
        step.id,
        `"${target ?? ""}" is not an install target.`,
        `Re-run --${verb} with one of: ${INSTALL_TARGETS.join(" | ")}.`,
      ),
    };
  }

  const override = parsed.flags.get("--command-path");
  if (typeof override === "string" && !isAbsolute(override)) {
    return {
      ok: false,
      code: usage(
        emit,
        verb,
        step.id,
        `--command-path needs an absolute path; "${override}" is relative.`,
        "Re-run with the full path to node (`which node` prints it), or omit --command-path to let " +
          "the standard locations be probed.",
      ),
    };
  }

  const selection = selectCommandPath({
    override: typeof override === "string" ? override : undefined,
    trustExecPath: parsed.flags.get("--trust-exec-path") === true,
  });
  if (selection.caveat) console.error(`Note: ${selection.caveat}`);

  return { ok: true, target, command: selection.command };
}

/** The `args` array the written entry carries — always exactly one dist path. */
function entryArgs(paths: SetupPaths, command: string): string[] {
  return buildClaudeServerConfig(paths.rootDir, command).args;
}

/** Exit 10 plus the payload that lets the agent finish by hand. */
function installFailed(
  emit: Emit,
  paths: SetupPaths,
  command: string,
  configPath: string,
  symptom: string,
  detail: string,
): number {
  emitErr(
    emit,
    "install",
    EXIT.INSTALL_FAILED,
    stepFor("install-config").id,
    symptom,
    INSTALL_FAILED_FIX,
    detail,
    { configBlock: renderConfigBlock(paths.rootDir, command), path: configPath },
  );
  return EXIT.INSTALL_FAILED;
}

/**
 * Claude Code's CLI branch: register at user scope through `claude mcp
 * add-json`.
 *
 * The reported path is the user-scope config the CLI writes — this project
 * never opens it, so the `mtime` is reported only when the file is actually
 * there to stat rather than asserted from a write we did not perform.
 */
function installViaClaudeCli(emit: Emit, paths: SetupPaths, command: string): number {
  try {
    claudeMcpAddJson(paths.rootDir, command);
  } catch (err) {
    return installFailed(
      emit,
      paths,
      command,
      paths.mcpJsonPath,
      "The claude CLI could not register the server at user scope.",
      errorMessage(err),
    );
  }

  const fields: Record<string, unknown> = {
    target: "code",
    path: paths.claudeJsonPath,
    command,
    args: entryArgs(paths, command),
  };
  try {
    fields.mtime = statSync(paths.claudeJsonPath).mtimeMs;
  } catch {
    // The CLI owns that file; report no timestamp rather than a guessed one.
  }
  emitOk(emit, "install", fields);
  return EXIT.OK;
}

/** Install one concrete target, emitting its own object either way. */
function installOne(
  target: ConcreteTarget,
  emit: Emit,
  paths: SetupPaths,
  command: string,
): number {
  // The spec's code decision tree: CLI present → the CLI; else the project file
  // plus the open-this-folder script.
  if (target === "code" && isClaudeCliAvailable()) {
    return installViaClaudeCli(emit, paths, command);
  }

  const outcome =
    target === "desktop" ? installDesktop(paths, command) : installMcpJson(paths, command);

  if (!outcome.ok) {
    const symptom =
      outcome.reason === "invalid-json"
        ? `${outcome.path} is not valid JSON — merging into it would have destroyed the other ` +
          "connectors it lists, so nothing was written."
        : `${outcome.path} could not be written.`;
    return installFailed(emit, paths, command, outcome.path, symptom, outcome.detail);
  }

  if (target === "code") console.error(OPEN_THIS_FOLDER_SCRIPT);

  emitOk(emit, "install", {
    target,
    path: outcome.path,
    mtime: outcome.mtimeMs,
    command,
    args: entryArgs(paths, command),
  });
  return EXIT.OK;
}

/**
 * Write the launcher entry for one or both targets.
 *
 * `both` emits one JSON object per target, one per line (the
 * `refresh-tokens --json` precedent), and each target is judged on its own: a
 * desktop refusal does not stop the code install, and the run's exit code is
 * the failure if either failed.
 */
function runInstall(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): number {
  const verb = "install";
  const args = resolveTargetAndCommand(parsed, emit, verb);
  if (!args.ok) return args.code;

  // The entry names `dist/index.js`; writing one that points at a file which
  // does not exist installs a server that cannot start, and the failure would
  // surface much later as "no FreshBooks tools after restart". The Book's
  // `build` step owns this state, and its own fix text is what we quote.
  const distPath = join(paths.rootDir, "dist", "index.js");
  if (!existsSync(distPath)) {
    emitErr(
      emit,
      verb,
      EXIT.PRECONDITION,
      stepFor("build").id,
      `The server is not built: ${distPath} does not exist, so the entry would point at a missing file.`,
      bookFix("build", "Cannot find module"),
      `${distPath} is missing.`,
    );
    return EXIT.PRECONDITION;
  }

  let result: number = EXIT.OK;
  for (const target of expandTarget(args.target)) {
    const code = installOne(target, emit, paths, args.command);
    if (code !== EXIT.OK) result = code;
  }
  return result;
}

/**
 * Emit the entry a target needs WITHOUT writing anything — and without reading
 * the existing config (ruling 2 above). Deliberately has no build precondition:
 * this is the degraded path's raw material, and an agent may legitimately ask
 * for it at any point, including before the build.
 */
function runPrintConfig(parsed: ParsedArgs, emit: Emit, paths: SetupPaths): number {
  const verb = "print-config";
  const args = resolveTargetAndCommand(parsed, emit, verb);
  if (!args.ok) return args.code;

  for (const target of expandTarget(args.target)) {
    emitOk(emit, verb, {
      target,
      path: configPathFor(target, paths),
      configBlock: renderConfigBlock(paths.rootDir, args.command),
    });
  }
  return EXIT.OK;
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
// Verb: --doctor
// ---------------------------------------------------------------------------
//
// The `verify` step, as a machine. Every check is KEYED TO A BOOK STEP: the
// `stepId` is what tells a driving agent which part of SETUP.md a failure sends
// it back to, and where the Book already words a state for a human the check
// quotes that row rather than paraphrasing it (`bookFix`), so SETUP.md and the
// doctor can never say two different things about the same failure.
//
// Four rulings hold this section together:
//
//   1. IT WRITES NOTHING AND CALLS NOTHING. No network, no token rotation, no
//      file creation — which is what makes it safe to run in any state,
//      including the unmigrated-legacy state every other verb refuses (see the
//      carve-out in `runHeadless`).
//   2. WARN IS ADVISORY; ONLY `fail` MOVES THE EXIT CODE (spec: "0 all-pass /
//      1 issues"). The rung-2 bare-`node` command is the reason: it is
//      EXPECTED there, the Book says so out loud, and a doctor that failed on
//      it would send an agent into the install→doctor→install loop the spec
//      exists to prevent.
//   3. NOTHING IT READS IS ECHOED. Credential files are inspected for PRESENCE
//      and expiry only, never for values; a config file that will not parse is
//      DESCRIBED, never quoted (V8 embeds a ~20-character window of the
//      document in its parse errors, and that file is shared with every other
//      MCP connector the user has installed — `scripts/setup-core.ts`'s
//      `parseFailureDetail` comment has the full account).
//   4. EVERY SCAN IS DEFENSIVE. A doctor that throws while diagnosing is worse
//      than useless, so each group of checks catches its own failure and
//      reports it as a check.

/** How a single check came out. Only `fail` makes the run exit 1. */
export type DoctorStatus = "pass" | "warn" | "fail";

/** One line of the doctor's report (spec §"--json shapes"). */
export interface DoctorCheck {
  /** Stable identifier for this check — what a test or an agent looks up. */
  id: string;
  /** The Book step this check belongs to; always a real `SETUP_FLOW` id. */
  stepId: string;
  status: DoctorStatus;
  /** What was observed. Never a credential value, never a quoted file byte. */
  detail: string;
  /** What to do about it; empty when there is nothing to do. */
  fix: string;
}

export interface DoctorReport {
  /** True when no check failed. Warnings are advisory (ruling 2). */
  ok: boolean;
  checks: DoctorCheck[];
}

/** The oldest a staged pending may be before the doctor calls it stale. */
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

/** The `<file>.rescue` suffix (Security §rescue-file lifecycle). */
const RESCUE_SUFFIX = ".rescue";

/** The Node major this project requires (`package.json` engines). */
const MIN_NODE_MAJOR = 18;

/** How every fix text spells "run a headless verb" — the Book's own form. */
const SETUP_CMD = "npx ts-node scripts/setup.ts --headless";

/**
 * Build one check, validating the Book step id as it goes: `stepFor` throws when
 * this file and `src/setup-flow.ts` disagree about which steps exist, which is
 * the same drift guard the verb envelopes use.
 */
function doctorCheck(
  id: string,
  stepId: string,
  status: DoctorStatus,
  detail: string,
  fix = "",
): DoctorCheck {
  return { id, stepId: stepFor(stepId).id, status, detail, fix };
}

/** The major version number in `18.20.4` / `v20.11.1`, or null if unreadable. */
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/** A coarse, human-readable duration — "just now", "42 m", "30 h", "3 d". */
function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * The ctx the Book's own `check()` / `appliesIf()` functions run against.
 *
 * `legacyNeedsMigration` is computed HERE, by the shared predicate, per
 * `SetupCtx`'s contract: the Book is pure data and cannot ask what a file
 * contains, and a surface that omitted the field would silently decide the
 * migration step does not apply.
 */
function bookCtx(paths: SetupPaths): SetupCtx {
  return {
    projectDir: paths.rootDir,
    redirectUri: REDIRECT_URI,
    exists: existsSync,
    legacyNeedsMigration: legacyEnvNeedsMigration(paths.baseEnvPath),
  };
}

/** Run a Book step's own `check()` and key it to that step. */
function bookStepCheck(
  id: string,
  stepId: string,
  ctx: SetupCtx,
  fixSymptom: string,
): DoctorCheck {
  const step = stepFor(stepId);
  const result = step.check!(ctx);
  return doctorCheck(
    id,
    stepId,
    result.ok ? "pass" : "fail",
    result.detail,
    result.ok ? "" : bookFix(stepId, fixSymptom),
  );
}

/**
 * Is this runtime new enough? Deliberately independent of the Book's
 * `node-install` step, which has no `check()` because its check is the raw
 * `node --version` command a human types.
 */
function nodeVersionCheck(runtimeVersion: string): DoctorCheck {
  const major = parseNodeMajor(runtimeVersion);
  const ok = major !== null && major >= MIN_NODE_MAJOR;
  return doctorCheck(
    "node-version",
    "node-install",
    ok ? "pass" : "fail",
    ok
      ? `Node ${runtimeVersion} (${MIN_NODE_MAJOR} or newer required)`
      : `Node ${runtimeVersion} is older than the required ${MIN_NODE_MAJOR}`,
    ok
      ? ""
      : "Install Node.js 18 or newer from nodejs.org (the big LTS button), then close the " +
          "Terminal window completely and open a new one — it reads the new installation only " +
          "on startup.",
  );
}

/**
 * The base `.env`: present, readable, and carrying both app credentials.
 *
 * Only KEY NAMES ever reach the detail — the whole point of the file is that it
 * holds the client secret.
 */
function appCredentialsCheck(paths: SetupPaths): DoctorCheck {
  const id = "app-credentials";
  const initFix =
    "Run --init with the Client ID and Client Secret from the FreshBooks Developer Portal " +
    "(preferably via --client-secret-file, which the CLI deletes itself).";

  if (!existsSync(paths.baseEnvPath)) {
    return doctorCheck(id, id, "fail", `no base .env at ${paths.baseEnvPath}`, initFix);
  }
  let raw: string;
  try {
    raw = readFileSync(paths.baseEnvPath, "utf8");
  } catch (err) {
    return doctorCheck(
      id,
      id,
      "fail",
      `${paths.baseEnvPath} could not be read (${errorMessage(err)})`,
      `Make sure ${paths.baseEnvPath} is readable, then run --doctor again.`,
    );
  }

  const env = dotenv.parse(raw);
  const missing = ["FRESHBOOKS_CLIENT_ID", "FRESHBOOKS_CLIENT_SECRET"].filter(
    (key) => !(env[key] ?? "").trim(),
  );
  if (missing.length) {
    return doctorCheck(
      id,
      id,
      "fail",
      `${paths.baseEnvPath} carries no ${missing.join(" and no ")}`,
      initFix,
    );
  }
  return doctorCheck(
    id,
    id,
    "pass",
    `${paths.baseEnvPath} carries both app credentials (values not shown)`,
  );
}

/**
 * The agent's scratch file for the client secret (`app-credentials`'
 * choreography). Its lifetime is supposed to end the moment `--init` starts, so
 * one still sitting here means a crash before the read — and it holds the app
 * secret at whatever permissions the agent's file tool used.
 */
function secretTmpCheck(paths: SetupPaths): DoctorCheck {
  const path = join(paths.rootDir, ".client-secret.tmp");
  if (!existsSync(path)) {
    return doctorCheck(
      "client-secret-tmp",
      "app-credentials",
      "pass",
      `no .client-secret.tmp is lingering in ${paths.rootDir}`,
    );
  }
  return doctorCheck(
    "client-secret-tmp",
    "app-credentials",
    "warn",
    `${path} is still on disk — --init deletes it as it reads it, so this one is left over from ` +
      "a run that never got that far",
    "Delete it now: it holds your app secret. It is never read again — --init takes a fresh file.",
  );
}

/** The `migrate-legacy` state, decided by the Book's own `appliesIf`. */
function legacyEnvCheck(paths: SetupPaths, ctx: SetupCtx): DoctorCheck {
  const step = stepFor("migrate-legacy");
  if (!step.appliesIf!(ctx)) {
    return doctorCheck(
      "legacy-env",
      "migrate-legacy",
      "pass",
      `${paths.baseEnvPath} holds no single-login tokens waiting to be migrated`,
    );
  }
  return doctorCheck(
    "legacy-env",
    "migrate-legacy",
    "fail",
    `${paths.baseEnvPath} still holds a single-login refresh token and no ${MIGRATED_MARKER} ` +
      "marker, so every other headless verb refuses to run",
    step.agentGuidance,
  );
}

/** The saved logins: how many, how healthy, and which files were excluded. */
function profileChecks(paths: SetupPaths): DoctorCheck[] {
  let discovery: DiscoveryResult;
  try {
    // A FRESH scan over the injected paths, never the memoized registry: this
    // process may have been started before the profile it is asked about.
    discovery = discoverProfiles(paths.profilesDir, paths.baseEnvPath);
  } catch (err) {
    return [
      doctorCheck(
        "profiles",
        "save-login",
        "fail",
        `the saved logins in ${paths.profilesDir} could not be read (${errorMessage(err)})`,
        `Make sure ${paths.profilesDir} and the files in it are readable, then run --doctor again.`,
      ),
    ];
  }

  const checks: DoctorCheck[] = [];
  const names = [...discovery.profiles.keys()];
  checks.push(
    names.length
      ? doctorCheck(
          "profiles",
          "save-login",
          "pass",
          `${names.length} login${names.length === 1 ? "" : "s"} configured: ${names.join(", ")}`,
        )
      : doctorCheck(
          "profiles",
          "save-login",
          "fail",
          `no FreshBooks login is configured — ${paths.profilesDir} holds no usable profile file`,
          `Connect one: run --auth-url, have the user approve the connection, then ${SETUP_CMD} ` +
            "--add-login --name <nickname> --callback-url '<the pasted address>'.",
        ),
  );

  for (const profile of discovery.profiles.values()) {
    checks.push(profileHealthCheck(profile, discovery));
  }
  // Copies before sorting: `discovery` is this scan's own result, but sorting a
  // structure in place that a caller handed us is a habit worth not forming.
  for (const file of [...discovery.broken].sort()) {
    checks.push(brokenProfileCheck(paths, file));
  }
  for (const file of [...discovery.duplicates].sort()) {
    checks.push(duplicateProfileCheck(paths, file, discovery));
  }
  return checks;
}

/** One saved login: quarantine first, then token presence, then JWT expiry. */
function profileHealthCheck(profile: ProfileState, discovery: DiscoveryResult): DoctorCheck {
  const id = `profile:${profile.name}`;
  const health = inspectTokenHealth(profile);

  if (profile.quarantined) {
    // `collision.file` is the raw on-disk filename and `profile.name` is
    // lowercased, so compare case-insensitively (the `withAccount` precedent).
    const own = basename(profile.filePath).toLowerCase();
    const collision = discovery.collisions.find(
      (c) => c.file.toLowerCase() === own && c.kind === "same-account",
    );
    const other = collision?.collidesWith ?? "another profile file";
    return doctorCheck(
      id,
      "save-login",
      "fail",
      `${profile.filePath} is quarantined: it shares its FreshBooks account with ${other}, and ` +
        "one of the two may be a superseded copy, so this login is refused and never auto-refreshed",
      `${bookFix("save-login", "quarantined profile mentioned")} If ${basename(
        profile.filePath,
      )} really is a separate live login, add the line "# freshbooks-distinct-login" to it; ` +
        "otherwise delete whichever of the two files is the stale copy.",
    );
  }

  if (health.issues.length) {
    return doctorCheck(
      id,
      "save-login",
      "fail",
      `${profile.filePath} — ${health.issues.join(", ")}`,
      `Reconnect this login: ${SETUP_CMD} --reauth --name ${profile.name} --callback-url ` +
        "'<the pasted address>' after running --auth-url.",
    );
  }

  const ids =
    `account ${profile.config.accountId || "(none)"}, ` +
    `business ${profile.config.businessId || "(none)"}`;
  const expiry =
    health.expirySeconds === null
      ? "its access token carries no readable expiry"
      : health.expired
        ? `its access token expired ${formatAge(-health.expirySeconds * 1000)} ago`
        : `its access token expires in ${formatAge(health.expirySeconds * 1000)}`;

  // The "refresh it now" advice is the same on every branch; only the reason
  // differs, and an unreadable expiry is NOT the same story as a near-expiry
  // one (there, the server cannot prove freshness, so it refreshes on principle).
  const why =
    health.expirySeconds === null
      ? "The expiry cannot be read, so the server refreshes this token on principle rather than " +
        "trust it"
      : "Nothing is broken: the server refreshes a token this close to expiry by itself, at " +
        "startup and before each tool call";
  return doctorCheck(
    id,
    "save-login",
    health.needsRefresh ? "warn" : "pass",
    `${profile.filePath} — ${ids}; ${expiry}`,
    health.needsRefresh
      ? `${why}. To refresh it now, run \`npm run refresh-tokens -- --profile ${profile.name}\`.`
      : "",
  );
}

/** A file in `profiles/` that discovery could not turn into a login. */
function brokenProfileCheck(paths: SetupPaths, file: string): DoctorCheck {
  const stem = file.slice(0, -".env".length).toLowerCase();
  const reason = PROFILE_NAME_RE.test(stem)
    ? "it carries no FRESHBOOKS_ACCESS_TOKEN / FRESHBOOKS_REFRESH_TOKEN pair"
    : "its name is not a usable nickname (lowercase letters, digits, '-' and '_')";
  return doctorCheck(
    `profile-file:${file}`,
    "save-login",
    "fail",
    `${join(paths.profilesDir, file)} is not a usable login: ${reason}`,
    `Repair or remove that file, then add the login with ${SETUP_CMD} --add-login --name ` +
      "<nickname> --callback-url '<the pasted address>'.",
  );
}

/** A file discovery excluded as a duplicate — of a token, or of a nickname. */
function duplicateProfileCheck(
  paths: SetupPaths,
  file: string,
  discovery: DiscoveryResult,
): DoctorCheck {
  const path = join(paths.profilesDir, file);
  const collision = discovery.collisions.find(
    (c) => c.file === file && c.kind === "same-token",
  );
  if (collision) {
    return doctorCheck(
      `profile-file:${file}`,
      "save-login",
      "fail",
      `${path} holds the same refresh token as ${collision.collidesWith}, so it is excluded — ` +
        "two files sharing one refresh token guarantee a double-rotation lockout",
      "Delete whichever of the two is the stale copy (they are the same login), then run " +
        "--doctor again.",
    );
  }
  return doctorCheck(
    `profile-file:${file}`,
    "save-login",
    "fail",
    `${path} collides with another file's nickname (nicknames are case-insensitive), so it is ` +
      "excluded",
    "Rename or remove one of the two files, then run --doctor again.",
  );
}

/** Token pairs staged mid-setup, and the exact command that finishes each one. */
function pendingChecks(paths: SetupPaths): DoctorCheck[] {
  let staged: ReturnType<typeof listPendings>;
  try {
    staged = listPendings(paths.profilesDir);
  } catch (err) {
    return [
      doctorCheck(
        "staged-pendings",
        "save-login",
        "warn",
        `the staged logins in ${paths.profilesDir} could not be listed (${errorMessage(err)})`,
        `Make sure ${paths.profilesDir} is readable, then run --doctor again.`,
      ),
    ];
  }

  if (!staged.length) {
    return [
      doctorCheck("staged-pendings", "save-login", "pass", "no login is staged mid-setup"),
    ];
  }

  return staged.map((pending) => {
    const discard = `${SETUP_CMD} --discard-pending --name ${pending.name}`;
    // The BARE resume command, mode-aware (spec §--add-login state machine):
    // it re-runs discovery on the staged pair and re-emits whichever branch
    // interrupted the original run.
    const resume =
      pending.mode === "add"
        ? `${SETUP_CMD} --add-login --name ${pending.name}`
        : pending.mode === "reauth"
          ? `${SETUP_CMD} --reauth --name ${pending.name}`
          : null;
    return doctorCheck(
      `staged-pending:${pending.name}`,
      "save-login",
      pending.ageMs > STALE_PENDING_MS ? "warn" : "pass",
      `${pendingPath(paths.profilesDir, pending.name)} (mode=${pending.mode}) was staged ` +
        `${formatAge(pending.ageMs)} ago and holds an unsaved token pair`,
      resume
        ? `Finish it with \`${resume}\`, or clear it with \`${discard}\`. Clearing removes the ` +
            "pair from this computer; it does not revoke the grant at FreshBooks."
        : `Its mode marker is unreadable, so it cannot be resumed — clear it with \`${discard}\`.`,
    );
  });
}

/**
 * Lingering `<file>.rescue` copies (Security §rescue-file lifecycle).
 *
 * ANY rescue file is reported, not just an undecodable one: its existence means
 * a guarded token write failed, and the pair inside it may be the only live one.
 * The base `.env`'s rescue is scanned too — the legacy single-login profile's
 * own file IS the repo-root `.env`, so its rescue lands outside `profiles/`.
 */
function rescueChecks(paths: SetupPaths): DoctorCheck[] {
  const found: { file: string; path: string; profile: string | null }[] = [];

  const baseRescue = `${paths.baseEnvPath}${RESCUE_SUFFIX}`;
  if (existsSync(baseRescue)) {
    // The legacy base-`.env` profile is registered under the name `default`.
    found.push({ file: basename(baseRescue), path: baseRescue, profile: "default" });
  }
  try {
    if (existsSync(paths.profilesDir)) {
      for (const file of readdirSync(paths.profilesDir).sort()) {
        if (!file.endsWith(RESCUE_SUFFIX)) continue;
        const stem = file.slice(0, -RESCUE_SUFFIX.length);
        found.push({
          file,
          path: join(paths.profilesDir, file),
          profile: stem.endsWith(".env") ? stem.slice(0, -".env".length) : null,
        });
      }
    }
  } catch (err) {
    return [
      doctorCheck(
        "rescue-files",
        "save-login",
        "warn",
        `${paths.profilesDir} could not be scanned for rescue files (${errorMessage(err)})`,
        `Make sure ${paths.profilesDir} is readable, then run --doctor again.`,
      ),
    ];
  }

  if (!found.length) {
    return [
      doctorCheck("rescue-files", "save-login", "pass", "no rescue file is lingering"),
    ];
  }

  return found.map((rescue) => {
    let age = "";
    try {
      age = ` (${formatAge(Date.now() - statSync(rescue.path).mtimeMs)} old)`;
    } catch {
      // A file that vanished between the scan and the stat needs no age.
    }
    const force = rescue.profile
      ? `npm run refresh-tokens -- --profile ${rescue.profile}`
      : "npm run refresh-tokens";
    return doctorCheck(
      `rescue-file:${rescue.file}`,
      "save-login",
      "fail",
      `${rescue.path}${age} holds a rescued token pair: a guarded write to the profile file ` +
        "failed, and this copy may be the live one",
      `The next refresh of that login adopts this pair, or clears it if the profile file already ` +
        `has a newer one. To force that now, run \`${force}\` — which can no-op for up to about ` +
        "10 minutes while the profile file's own access token is still JWT-fresh; it self-heals " +
        "at the next refresh that is actually needed.",
    );
  });
}

/** Every file whose loose permissions would expose a credential. */
function credentialFiles(paths: SetupPaths): string[] {
  const files: string[] = [];
  if (existsSync(paths.baseEnvPath)) files.push(paths.baseEnvPath);
  try {
    if (existsSync(paths.profilesDir)) {
      // Everything in profiles/ is token-bearing: profile files, staged
      // pendings, rescues, and the `.bak` a guarded write leaves behind.
      for (const file of readdirSync(paths.profilesDir).sort()) {
        files.push(join(paths.profilesDir, file));
      }
    }
  } catch {
    // Unreadable directory — the profiles checks already report it.
  }
  return files;
}

/** 0600 on every credential file (Security §Permissions); a no-op on Windows. */
function permissionCheck(paths: SetupPaths): DoctorCheck {
  const id = "file-permissions";
  if (process.platform === "win32") {
    return doctorCheck(id, "save-login", "pass", "skipped: file modes do not apply on Windows");
  }

  const loose: string[] = [];
  let checked = 0;
  for (const path of credentialFiles(paths)) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      checked += 1;
      if (stat.mode & 0o077) loose.push(path);
    } catch {
      // Vanished or unreadable — not a permissions verdict.
    }
  }
  if (!loose.length) {
    return doctorCheck(
      id,
      "save-login",
      "pass",
      `every credential file is private to you (${checked} checked)`,
    );
  }
  return doctorCheck(
    id,
    "save-login",
    "warn",
    `these credential files are readable by other accounts on this computer: ${loose.join(", ")}`,
    `Tighten them: chmod 600 ${loose.join(" ")}`,
  );
}

/** One place a launcher entry can live. */
interface ConfigLocation {
  key: string;
  label: string;
  path: string;
}

/** What one config location holds. Nothing here quotes a byte of the file. */
type ConfigEntry =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "no-entry" }
  | { state: "entry"; command: string; args: string[] };

function configLocations(paths: SetupPaths): ConfigLocation[] {
  return [
    { key: "desktop", label: "Claude Desktop config", path: paths.desktopConfigPath },
    { key: "mcp-json", label: "project .mcp.json", path: paths.mcpJsonPath },
    { key: "claude-json", label: "Claude Code user config", path: paths.claudeJsonPath },
  ];
}

/**
 * Read one config file's `mcpServers.freshbooks` entry, best-effort.
 *
 * A read or parse failure is a STATE, not an error to report: `~/.claude.json`
 * in particular is the CLI's file, not this project's, and a doctor that threw
 * on someone else's malformed config would diagnose nothing. Crucially, the
 * parse error itself is discarded rather than reported — V8 embeds a window of
 * the DOCUMENT in it, and this file holds other connectors' credentials.
 */
function readConfigEntry(path: string): ConfigEntry {
  if (!existsSync(path)) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "unreadable" };
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  const entry = (servers as Record<string, unknown> | undefined)?.freshbooks as
    | { command?: unknown; args?: unknown }
    | undefined;
  if (!entry || typeof entry !== "object") return { state: "no-entry" };
  return {
    state: "entry",
    command: typeof entry.command === "string" ? entry.command.trim() : "",
    args: Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [],
  };
}

/** Could Claude actually START the server from this entry? */
function isResolvable(entry: ConfigEntry): boolean {
  return (
    entry.state === "entry" &&
    entry.command !== "" &&
    entry.args.length > 0 &&
    existsSync(entry.args[0])
  );
}

/**
 * The config checks: one aggregate verdict plus a line per problem found at a
 * location that DOES carry an entry.
 *
 * The aggregate fails only when NO location carries a startable entry (spec:
 * "fail only when no location carries a resolvable entry") — a Desktop-only user
 * legitimately has no `.mcp.json`, and saying so per location as a failure would
 * make a correct install look broken.
 */
function configChecks(paths: SetupPaths): DoctorCheck[] {
  const segments: string[] = [];
  const extra: DoctorCheck[] = [];
  let anyResolvable = false;

  for (const location of configLocations(paths)) {
    const entry = readConfigEntry(location.path);
    const where = `${location.label} (${location.path})`;

    if (entry.state === "absent") {
      segments.push(`${where}: not present`);
      continue;
    }
    if (entry.state === "unreadable") {
      segments.push(`${where}: could not be read as JSON`);
      continue;
    }
    if (entry.state === "no-entry") {
      segments.push(`${where}: no freshbooks entry`);
      continue;
    }

    const resolvable = isResolvable(entry);
    anyResolvable = anyResolvable || resolvable;
    segments.push(
      `${where}: freshbooks → ${entry.command || "(no command)"} ${entry.args.join(" ")}`.trim() +
        (resolvable ? "" : " [cannot start]"),
    );
    extra.push(...configEntryChecks(location, entry, where));
  }

  const aggregate = doctorCheck(
    "config",
    "install-config",
    anyResolvable ? "pass" : "fail",
    segments.join("; "),
    anyResolvable
      ? ""
      : "No Claude configuration here carries an entry that could start this server: run " +
          `\`${SETUP_CMD} --install desktop\` (or --install code) from the project folder. If a ` +
          `previous session already reported that the install succeeded: ${bookFix(
            "verify",
            "config entry missing",
          )}`,
  );
  return [aggregate, ...extra];
}

/** The per-location command / dist-path checks for a location that HAS an entry. */
function configEntryChecks(
  location: ConfigLocation,
  entry: Extract<ConfigEntry, { state: "entry" }>,
  where: string,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // `claude-json` is the CLI's user-scope file, which `--install code` writes
  // through the CLI; the other two location keys are install targets already.
  const target = location.key === "claude-json" ? "code" : location.key;
  const rewrite =
    `Re-run \`${SETUP_CMD} --install ${target}\` from the project folder to rewrite the entry.`;

  if (!entry.command) {
    checks.push(
      doctorCheck(
        `config-command:${location.key}`,
        "install-config",
        "fail",
        `${where}: the freshbooks entry names no command, so nothing can launch it`,
        rewrite,
      ),
    );
  } else if (!isAbsolute(entry.command)) {
    // The two causes the Book distinguishes, told apart by the same probe
    // `--install` would run: if an absolute node exists here, today's install
    // would have written it, so a bare command is a LEGACY entry. If none
    // exists, a bare command is exactly what --install writes — the deliberate
    // sandbox fallback, expected and not an error (hence: warn, never fail).
    const probe = selectCommandPath({});
    const detail = probe.caveat
      ? `${where}: the entry's command "${entry.command}" is not an absolute path, and no ` +
        "absolute node was found at the standard locations either — this is the deliberate " +
        "fallback, expected here, and re-running --install would write the same thing"
      : `${where}: the entry's command "${entry.command}" is not an absolute path, but an ` +
        `absolute node exists at ${probe.command} — this looks like a legacy entry`;
    checks.push(
      doctorCheck(
        `config-command:${location.key}`,
        "install-config",
        "warn",
        detail,
        bookFix("verify", "command isn't an absolute path"),
      ),
    );
  } else if (!existsSync(entry.command)) {
    checks.push(
      doctorCheck(
        `config-command:${location.key}`,
        "install-config",
        "fail",
        `${where}: the entry launches ${entry.command}, which is not on this computer`,
        `${rewrite} It probes the standard locations; pass --command-path <absolute path to ` +
          "node> to name one yourself.",
      ),
    );
  }

  const serverPath = entry.args[0];
  if (!serverPath || !existsSync(serverPath)) {
    checks.push(
      doctorCheck(
        `config-args:${location.key}`,
        "install-config",
        "fail",
        `${where}: the entry points at ${serverPath ?? "(no file)"}, which does not exist`,
        `${bookFix("build", "Cannot find module")} ${rewrite}`,
      ),
    );
  }
  return checks;
}

/**
 * Run every check. Pure diagnosis: nothing here writes, rotates, or calls
 * FreshBooks, which is what lets it run in states the other verbs refuse.
 *
 * `runtimeVersion` is an injected seam (the `selectCommandPath` precedent) so
 * the too-old-Node branch is testable on a runtime that is not too old;
 * production callers take this process's own version.
 */
export function runDoctor(
  paths: SetupPaths,
  runtimeVersion: string = process.versions.node,
): DoctorReport {
  const ctx = bookCtx(paths);
  const checks: DoctorCheck[] = [
    nodeVersionCheck(runtimeVersion),
    bookStepCheck("node-modules", "npm-install", ctx, "Cannot find module 'ts-node'"),
    bookStepCheck("build", "build", ctx, "Cannot find module"),
    appCredentialsCheck(paths),
    secretTmpCheck(paths),
    legacyEnvCheck(paths, ctx),
    ...profileChecks(paths),
    ...pendingChecks(paths),
    ...rescueChecks(paths),
    permissionCheck(paths),
    ...configChecks(paths),
  ];
  // Warnings are advisory (ruling 2): only a failure moves the exit code.
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

function runDoctorVerb(emit: Emit, paths: SetupPaths): number {
  const report = runDoctor(paths);
  emitDoctor(emit, report);
  return report.ok ? EXIT.OK : EXIT.FAIL;
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
    // The invocation never parsed, so nothing downstream will ever read (and
    // therefore delete) a secret file it carried. Read the path off raw argv.
    shredUnreadSecretFile(secretFileArg(argv));
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
  //
  // `--doctor` is the ONE carve-out, for two reasons that both cut the same way:
  // it writes nothing and calls nothing (so none of the above can happen), and
  // REPORTING this state is one of its own checks — the Book's own recovery
  // script for exit 9 is "run `npm run setup`, then resume with `--doctor`", and
  // the spec fixes the doctor's exits at 0 or 1. Refusing it here would make the
  // state undiagnosable by the very verb sent to diagnose it.
  if (parsed.verb !== "--doctor" && legacyEnvNeedsMigration(paths.baseEnvPath)) {
    // This refusal sends the user to the wizard — minutes at least, and the
    // whole point is that they come back later. A live app secret must not wait
    // that long in a file the CLI promised to delete.
    shredUnreadSecretFile(secretFileArg(argv));
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
        // A verb that does not take `--client-secret-file` will never read it.
        shredUnreadSecretFile(secretFileArg(argv));
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
    case "--install":
      return runInstall(parsed, emit, paths);
    case "--print-config":
      return runPrintConfig(parsed, emit, paths);
    case "--discard-pending":
      return runDiscardPending(parsed, emit, paths);
    case "--doctor":
      return runDoctorVerb(emit, paths);
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
