import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import * as dotenv from "dotenv";
import type { Client } from "@freshbooks/api";

export const PROFILES_DIR = join(__dirname, "..", "profiles");
export const BASE_ENV_FILE = join(__dirname, "..", ".env");

export interface ProfileConfig {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  businessId: string;
}

export interface ProfileState {
  name: string;
  filePath: string;
  config: ProfileConfig;
  client: Client | null;
  refreshInFlight: Promise<void> | null;
  quarantined?: boolean; // R2: same-accountId collision, excluded from rotation until opt-in
}

export interface Collision {
  file: string;
  collidesWith: string;
  kind: "same-token" | "same-account" | "same-account-optin";
}

export interface DiscoveryResult {
  profiles: Map<string, ProfileState>;
  broken: string[];
  duplicates: string[];
  collisions: Collision[];
}

export class UnknownProfileError extends Error {
  constructor(
    public readonly requested: string,
    public readonly available: string[],
  ) {
    super(
      available.length === 0
        ? "No FreshBooks accounts are configured. Run `npm run setup` to add one."
        : `Unknown account "${requested}". Configured accounts: ${available.join(", ")}.`,
    );
    this.name = "UnknownProfileError";
  }
}

// Lowercase only: the owner's macOS filesystem is case-insensitive (Amendment A6),
// so the on-disk stem and the resolution key must share one normalization.
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function normalizeProfileName(raw: string): string {
  const name = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${raw}". Use lowercase letters, digits, '-' or '_'; must start with a letter or digit.`,
    );
  }
  return name;
}

export function parseProfileConfig(content: string): ProfileConfig | null {
  const p = dotenv.parse(content);
  const accessToken = p.FRESHBOOKS_ACCESS_TOKEN?.trim();
  const refreshToken = p.FRESHBOOKS_REFRESH_TOKEN?.trim();
  // U1: gate validity on the two TOKENS only. That still excludes empty stubs /
  // editor-backup copies (A5's real intent), but does NOT brick an accounting-
  // only single-login install that legitimately ships a blank
  // FRESHBOOKS_BUSINESS_ID (A3 "single-login unchanged" outranks A5's literal
  // "all four markers"). IDs default to "" and keep their throw-at-call-time
  // semantics in getAccountId()/getBusinessId().
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    accountId: p.FRESHBOOKS_ACCOUNT_ID?.trim() ?? "",
    businessId: p.FRESHBOOKS_BUSINESS_ID?.trim() ?? "",
  };
}

function readLegacyBaseEnv(baseEnvFile: string): ProfileConfig | null {
  if (!existsSync(baseEnvFile)) return null;
  return parseProfileConfig(readFileSync(baseEnvFile, "utf8"));
}

export function discoverProfiles(
  // Defaults read env overrides at CALL time so tests can point at a temp dir
  // (set FRESHBOOKS_PROFILES_DIR + FRESHBOOKS_BASE_ENV, then resetRegistry()) and
  // NEVER touch the developer's real .env during the suite.
  dir: string = process.env.FRESHBOOKS_PROFILES_DIR?.trim() || PROFILES_DIR,
  baseEnvFile: string = process.env.FRESHBOOKS_BASE_ENV?.trim() || BASE_ENV_FILE,
): DiscoveryResult {
  const profiles = new Map<string, ProfileState>();
  const broken: string[] = [];
  const duplicates: string[] = [];
  const collisions: Collision[] = [];
  const seenName = new Set<string>();
  const seenRefresh = new Map<string, string>(); // refreshToken -> first file

  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".env"))
        .sort()
    : [];

  // PASS 1 — parse every candidate once. Apply the name/case dedup and the
  // identical-refresh-token dedup here; carry each survivor's raw-text opt-in
  // marker flag for the same-account grouping in pass 2. After this pass every
  // surviving candidate has a DISTINCT refresh token.
  interface Candidate {
    file: string;
    lower: string;
    config: ProfileConfig;
    optIn: boolean; // raw `# freshbooks-distinct-login` marker present
  }
  const candidates: Candidate[] = [];

  for (const file of files) {
    const stem = file.slice(0, -".env".length);
    const lower = stem.toLowerCase();
    if (!PROFILE_NAME_RE.test(lower)) {
      broken.push(file);
      continue;
    }
    if (seenName.has(lower)) {
      duplicates.push(file);
      continue;
    } // case/name collision (APFS-safe)
    const raw = readFileSync(join(dir, file), "utf8");
    const config = parseProfileConfig(raw);
    if (!config) {
      broken.push(file);
      continue;
    }

    // (a) identical refresh token across two files => definite double-rotation snapshot. Exclude.
    if (seenRefresh.has(config.refreshToken)) {
      duplicates.push(file);
      collisions.push({ file, collidesWith: seenRefresh.get(config.refreshToken)!, kind: "same-token" });
      continue;
    }

    seenName.add(lower);
    seenRefresh.set(config.refreshToken, file);
    candidates.push({
      file,
      lower,
      config,
      optIn: /^#\s*freshbooks-distinct-login\b/m.test(raw), // raw scan: dotenv ignores comments
    });
  }

  // PASS 2 — group surviving candidates by non-empty accountId. An accountId with
  // >=2 members is an unresolved same-account group (distinct tokens, per pass 1):
  // FAIL CLOSED — quarantine EVERY member that is NOT individually opted-in via the
  // `# freshbooks-distinct-login` marker. This closes the diverged-copy burn vector
  // where the alphabetically-FIRST file is the stale copy: admitting it as
  // "canonical" and auto-rotating its superseded token would revoke the live
  // sibling's whole refresh-token family. A marked file is the user vouching it is a
  // genuinely distinct live login, so it stays admitted; identical-refresh-token
  // copies were already excluded as `duplicates` in pass 1; single-file accountIds
  // are unaffected.
  const byAccount = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.config.accountId) continue;
    const group = byAccount.get(c.config.accountId);
    if (group) group.push(c);
    else byAccount.set(c.config.accountId, [c]);
  }
  const quarantinedFiles = new Set<string>();
  for (const group of byAccount.values()) {
    if (group.length < 2) continue;
    for (const member of group) {
      if (!member.optIn) quarantinedFiles.add(member.file);
      const sibling = group.find((g) => g.file !== member.file)!;
      collisions.push({
        file: member.file,
        collidesWith: sibling.file,
        kind: member.optIn ? "same-account-optin" : "same-account",
      });
    }
  }

  for (const c of candidates) {
    profiles.set(c.lower, {
      name: c.lower,
      filePath: join(dir, c.file),
      config: c.config,
      client: null,
      refreshInFlight: null,
      quarantined: quarantinedFiles.has(c.file),
    });
  }

  // (A3) legacy fallback: empty profiles/ but base .env still carries tokens
  if (profiles.size === 0) {
    const legacy = readLegacyBaseEnv(baseEnvFile);
    if (legacy)
      profiles.set("default", {
        name: "default",
        filePath: baseEnvFile,
        config: legacy,
        client: null,
        refreshInFlight: null,
        quarantined: false,
      });
  }
  return { profiles, broken, duplicates, collisions };
}

let registry: DiscoveryResult | null = null;
export function getRegistry(): DiscoveryResult {
  if (!registry) registry = discoverProfiles();
  return registry;
}
export function resetRegistry(): void {
  registry = null;
}
export function profileNames(): string[] {
  return [...getRegistry().profiles.keys()];
}
export function profileCount(): number {
  // Includes quarantined profiles, so a collision keeps the server in
  // account-required mode (>=2) rather than silently auto-routing.
  return getRegistry().profiles.size;
}

export function resolveProfile(name: string): ProfileState {
  const reg = getRegistry();
  const p = reg.profiles.get(String(name).trim().toLowerCase());
  if (!p) throw new UnknownProfileError(name, [...reg.profiles.keys()]);
  return p;
}

export function defaultProfileName(): string | null {
  // R3: the lone profile's name, or null. NO FRESHBOOKS_DEFAULT_PROFILE selector
  // — with >=2 profiles withAccount requires an explicit account before this is
  // consulted, so an env default would be dead code with multiple profiles and
  // an implicit-routing footgun against the "name every request" decision.
  const reg = getRegistry();
  if (reg.profiles.size !== 1) return null;
  const only = [...reg.profiles.values()][0];
  return only.quarantined ? null : only.name; // never default to a quarantined profile (R2)
}

const als = new AsyncLocalStorage<{ profile: ProfileState }>();
export function runInProfile<T>(profile: ProfileState, fn: () => Promise<T>): Promise<T> {
  return als.run({ profile }, fn);
}
export function currentProfile(): ProfileState {
  const store = als.getStore();
  if (!store) throw new Error("currentProfile() called outside a profile context");
  return store.profile;
}
export function currentProfileOrNull(): ProfileState | null {
  return als.getStore()?.profile ?? null;
}
