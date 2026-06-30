# Multi-Account Support via Named Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one MCP server serve 3–4 separate FreshBooks logins ("profiles"), choosing the target login via an explicit `account` argument on every API tool — without ever burning a refresh token or writing to the wrong company.

**Architecture:** Each login is a `profiles/<name>.env` file (tokens + IDs). A memoized registry parses them in-memory into `ProfileState` objects. The existing `withTokenRefresh` wrapper becomes `withAccount`: it injects an `account` field into every API tool's schema, resolves the named profile, refreshes that profile's token, and runs the original handler inside an `AsyncLocalStorage` context. The unchanged zero-arg `getFreshBooksClient()`/`getAccountId()`/`getBusinessId()` resolve the current profile from that context, so the 17 resource tool files are not touched. A single `getOrCreateClient(profile)` is the only place a `Client` is built, keeping token state on one object per profile.

**Tech Stack:** TypeScript (strict), Node.js, `@freshbooks/api`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`, `dotenv`, Vitest.

## Global Constraints

- Tool handlers MUST never throw — return `{ content, isError: true }` on every failure path. (Uncaught exceptions kill the agent loop.)
- Tokens live ONLY in dotenv files (base `.env` for shared app creds; `profiles/<name>.env` for per-login tokens). Never commit any of them.
- A `Client` is constructed in exactly ONE place: `getOrCreateClient(profile)`. (Amendment A1.)
- Per-profile token writes use the atomic tmp+rename+`.bak`+post-write-verify path; tmp/bak names are always derived from the target path, never a shared constant.
- `account` is `z.string().optional()` in the schema; the wrapper enforces "required when ≥2 profiles".
- `freshbooks_help` and `freshbooks_list_accounts` are the ONLY account-free tools.
- Version has one source of truth (`package.json` → `getVersion()`); tool total is derived from `allTools.length`. Adding `freshbooks_list_accounts` changes the total 75 → 76; update every doc watched by `test/doc-tool-count.test.ts`.
- New tests go in `test/`. Run the suite with `npm test`; type-check with `npm run build`.
- The full design + the binding audit amendments (A1–A11) live in `docs/superpowers/specs/2026-06-30-multi-account-profiles-design.md` — read its "Audit-Driven Amendments" section before starting.

---

## File Structure

**Create:**
- `src/profiles.ts` — `ProfileConfig`/`ProfileState` types, name normalization, file parsing/validation, discovery, memoized registry, legacy fallback, duplicate/case detection, `AsyncLocalStorage` context.
- `src/atomic-write.ts` — `writeAtomic(path, content)` + `readTokenMarkers(path)` extracted from `freshbooks-client.ts` so migration reuses the exact same safety.
- `src/tools/accounts.ts` — the `freshbooks_list_accounts` tool.
- `src/migrate.ts` — transactional migration of legacy `.env` into `profiles/<name>.env`.
- `src/server-lock.ts` — best-effort lock file so migration refuses to run while a server holds tokens.
- Tests: `test/profiles.test.ts`, `test/atomic-write.test.ts`, `test/freshbooks-client-profiles.test.ts`, `test/with-account.test.ts`, `test/accounts-tool.test.ts`, `test/migrate.test.ts`, `test/gitignore.test.ts`.

**Modify:**
- `src/freshbooks-client.ts` — `getOrCreateClient`, per-profile refresh/persist/single-flight, ALS-backed helpers, `inspectTokenHealth(profile)`, `ensureFreshTokens()`; drop the module-level singleton + `process.env` token coupling.
- `src/tools/with-refresh.ts` — `withAccount` (schema injection + resolution + try/catch + `runInProfile`) and `withoutAccount`.
- `src/tool-registry.ts` — register `listAccounts`; wrap API tools with `withAccount`, help/list_accounts with `withoutAccount`.
- `src/index.ts` — connect first, then refresh profiles in the background; write/remove the server lock.
- `scripts/setup.ts` — add-login loop with business selection; invoke migration; print build-order checklist.
- `scripts/refresh-tokens.ts` — iterate profiles; `--profile <name>`.
- `.gitignore`, `.env.example`.
- `README.md`, `SETUP.md`, `CLAUDE.md`, `docs/claude-project-system-prompt.md`, `src/docs/content.ts`, and the bundled `freshbooks-token-refresh` skill.

---

### Task 1: Profile types, name normalization, and file parsing (pure)

**Files:**
- Create: `src/profiles.ts`
- Test: `test/profiles.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module aside from `dotenv`, `node:*`, `@freshbooks/api` type).
- Produces:
  - `interface ProfileConfig { accessToken: string; refreshToken: string; accountId: string; businessId: string }`
  - `interface ProfileState { name: string; filePath: string; config: ProfileConfig; client: Client | null; refreshInFlight: Promise<void> | null }`
  - `class UnknownProfileError extends Error { requested: string; available: string[] }`
  - `function normalizeProfileName(raw: string): string` (throws on invalid)
  - `function parseProfileConfig(content: string): ProfileConfig | null`
  - `const PROFILE_NAME_RE: RegExp`

- [ ] **Step 1: Write the failing test**

```ts
// test/profiles.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeProfileName,
  parseProfileConfig,
  UnknownProfileError,
} from "../src/profiles";

describe("normalizeProfileName", () => {
  it("lowercases and accepts valid names", () => {
    expect(normalizeProfileName("Acme")).toBe("acme");
    expect(normalizeProfileName("client-2_b")).toBe("client-2_b");
  });
  it("rejects names with spaces or path chars", () => {
    expect(() => normalizeProfileName("acme copy")).toThrow();
    expect(() => normalizeProfileName("../etc")).toThrow();
    expect(() => normalizeProfileName("")).toThrow();
  });
});

describe("parseProfileConfig", () => {
  const good =
    "FRESHBOOKS_ACCESS_TOKEN=a\nFRESHBOOKS_REFRESH_TOKEN=r\nFRESHBOOKS_ACCOUNT_ID=acc\nFRESHBOOKS_BUSINESS_ID=42\n";
  it("parses a complete file", () => {
    expect(parseProfileConfig(good)).toEqual({
      accessToken: "a",
      refreshToken: "r",
      accountId: "acc",
      businessId: "42",
    });
  });
  it("returns null when any marker is missing", () => {
    expect(parseProfileConfig("FRESHBOOKS_ACCESS_TOKEN=a\n")).toBeNull();
  });
});

describe("UnknownProfileError", () => {
  it("lists available names", () => {
    const e = new UnknownProfileError("x", ["acme", "beta"]);
    expect(e.message).toContain("acme, beta");
  });
  it("guides setup when none configured", () => {
    expect(new UnknownProfileError("x", []).message).toContain("npm run setup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profiles.test.ts`
Expected: FAIL — `Cannot find module '../src/profiles'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/profiles.ts
import { join } from "node:path";
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
  const name = String(raw ?? "").trim().toLowerCase();
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
  const accountId = p.FRESHBOOKS_ACCOUNT_ID?.trim();
  const businessId = p.FRESHBOOKS_BUSINESS_ID?.trim();
  if (!accessToken || !refreshToken || !accountId || !businessId) return null;
  return { accessToken, refreshToken, accountId, businessId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/profiles.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/profiles.ts test/profiles.test.ts
git commit -m "feat: profile types, name normalization, and config parsing"
```

---

### Task 2: Discovery, memoized registry, legacy fallback, duplicate/case detection, ALS context

**Files:**
- Modify: `src/profiles.ts`
- Test: `test/profiles.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - `interface DiscoveryResult { profiles: Map<string, ProfileState>; broken: string[]; duplicates: string[] }`
  - `function discoverProfiles(dir?: string, baseEnvFile?: string): DiscoveryResult`
  - `function getRegistry(): DiscoveryResult` (memoized) · `function resetRegistry(): void` (tests)
  - `function profileNames(): string[]` · `function profileCount(): number`
  - `function resolveProfile(name: string): ProfileState` (throws `UnknownProfileError`)
  - `function defaultProfileName(): string | null`
  - `function runInProfile<T>(profile: ProfileState, fn: () => Promise<T>): Promise<T>`
  - `function currentProfile(): ProfileState` (throws outside context) · `function currentProfileOrNull(): ProfileState | null`

- [ ] **Step 1: Write the failing test**

```ts
// test/profiles.test.ts  (append)
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProfiles,
  runInProfile,
  currentProfile,
  currentProfileOrNull,
} from "../src/profiles";

function makeDir(files: Record<string, string>): { dir: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "fb-prof-"));
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, base: join(root, ".env") };
}
const cfg = (a: string, acc: string, biz = "1") =>
  `FRESHBOOKS_ACCESS_TOKEN=at-${a}\nFRESHBOOKS_REFRESH_TOKEN=rt-${a}\nFRESHBOOKS_ACCOUNT_ID=${acc}\nFRESHBOOKS_BUSINESS_ID=${biz}\n`;

describe("discoverProfiles", () => {
  it("loads valid profiles keyed by lowercased stem", () => {
    const { dir, base } = makeDir({ "acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    const r = discoverProfiles(dir, base);
    expect([...r.profiles.keys()].sort()).toEqual(["acme", "beta"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("excludes malformed files as broken, never counting them", () => {
    const { dir, base } = makeDir({ "acme.env": cfg("a", "A1"), "stub.env": "FRESHBOOKS_ACCESS_TOKEN=x\n" });
    const r = discoverProfiles(dir, base);
    expect([...r.profiles.keys()]).toEqual(["acme"]);
    expect(r.broken).toContain("stub.env");
  });
  it("flags duplicate refresh tokens / account ids as duplicates, not profiles", () => {
    const { dir, base } = makeDir({ "acme.env": cfg("dup", "SAME"), "copy.env": cfg("dup", "SAME") });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(1);
    expect(r.duplicates.length).toBe(1);
  });
  it("flags case-colliding stems", () => {
    // On case-sensitive CI both files exist; discovery must still reject the second.
    const { dir, base } = makeDir({ "acme.env": cfg("a", "A1"), "Acme.env": cfg("c", "C1") });
    const r = discoverProfiles(dir, base);
    expect(r.profiles.size).toBe(1);
    expect(r.duplicates.length + r.broken.length).toBe(1);
  });
  it("falls back to a legacy base .env as the 'default' profile when profiles/ is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-leg-"));
    const base = join(root, ".env");
    writeFileSync(base, cfg("legacy", "LEG"));
    const r = discoverProfiles(join(root, "profiles"), base);
    expect([...r.profiles.keys()]).toEqual(["default"]);
    expect(r.profiles.get("default")!.filePath).toBe(base);
  });
});

describe("AsyncLocalStorage context", () => {
  it("exposes the running profile and isolates concurrent contexts", async () => {
    const { dir, base } = makeDir({ "acme.env": cfg("a", "A1"), "beta.env": cfg("b", "B1") });
    const r = discoverProfiles(dir, base);
    const a = r.profiles.get("acme")!;
    const b = r.profiles.get("beta")!;
    expect(currentProfileOrNull()).toBeNull();
    const [ra, rb] = await Promise.all([
      runInProfile(a, async () => { await new Promise((s) => setTimeout(s, 5)); return currentProfile().name; }),
      runInProfile(b, async () => currentProfile().name),
    ]);
    expect([ra, rb]).toEqual(["acme", "beta"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profiles.test.ts`
Expected: FAIL — `discoverProfiles` / `runInProfile` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/profiles.ts  (append)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

export interface DiscoveryResult {
  profiles: Map<string, ProfileState>;
  broken: string[];
  duplicates: string[];
}

function readLegacyBaseEnv(baseEnvFile: string): ProfileConfig | null {
  if (!existsSync(baseEnvFile)) return null;
  return parseProfileConfig(readFileSync(baseEnvFile, "utf8"));
}

export function discoverProfiles(
  dir: string = PROFILES_DIR,
  baseEnvFile: string = BASE_ENV_FILE,
): DiscoveryResult {
  const profiles = new Map<string, ProfileState>();
  const broken: string[] = [];
  const duplicates: string[] = [];
  const seenName = new Set<string>();
  const seenRefresh = new Map<string, string>();
  const seenAccount = new Map<string, string>();

  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".env")).sort()
    : [];

  for (const file of files) {
    const stem = file.slice(0, -".env".length);
    const lower = stem.toLowerCase();
    if (!PROFILE_NAME_RE.test(lower)) { broken.push(file); continue; }
    if (seenName.has(lower)) { duplicates.push(file); continue; } // case-collision / dup name
    const config = parseProfileConfig(readFileSync(join(dir, file), "utf8"));
    if (!config) { broken.push(file); continue; }
    if (seenRefresh.has(config.refreshToken) || seenAccount.has(config.accountId)) {
      duplicates.push(file); continue; // same login twice -> would lock one out
    }
    seenName.add(lower);
    seenRefresh.set(config.refreshToken, file);
    seenAccount.set(config.accountId, file);
    profiles.set(lower, { name: lower, filePath: join(dir, file), config, client: null, refreshInFlight: null });
  }

  if (profiles.size === 0) {
    const legacy = readLegacyBaseEnv(baseEnvFile); // Amendment A3
    if (legacy) {
      profiles.set("default", { name: "default", filePath: baseEnvFile, config: legacy, client: null, refreshInFlight: null });
    }
  }
  return { profiles, broken, duplicates };
}

let registry: DiscoveryResult | null = null;
export function getRegistry(): DiscoveryResult {
  if (!registry) registry = discoverProfiles();
  return registry;
}
export function resetRegistry(): void { registry = null; }
export function profileNames(): string[] { return [...getRegistry().profiles.keys()]; }
export function profileCount(): number { return getRegistry().profiles.size; }

export function resolveProfile(name: string): ProfileState {
  const reg = getRegistry();
  const p = reg.profiles.get(String(name).trim().toLowerCase());
  if (!p) throw new UnknownProfileError(name, [...reg.profiles.keys()]);
  return p;
}

export function defaultProfileName(): string | null {
  const reg = getRegistry();
  const fromEnv = process.env.FRESHBOOKS_DEFAULT_PROFILE?.trim().toLowerCase();
  if (fromEnv && reg.profiles.has(fromEnv)) return fromEnv;
  if (reg.profiles.size === 1) return [...reg.profiles.keys()][0];
  return null;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/profiles.ts test/profiles.test.ts
git commit -m "feat: profile discovery, registry, legacy fallback, dup/case detection, ALS"
```

---

### Task 3: Extract the atomic-write utility

**Files:**
- Create: `src/atomic-write.ts`
- Test: `test/atomic-write.test.ts`

**Interfaces:**
- Produces:
  - `function writeAtomic(path: string, content: string): void` (writes `${path}.bak`, then `${path}.tmp`, then `rename`s into place — names derived from `path`, never shared constants)
  - `function readTokenMarkers(path: string): { access?: string; refresh?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/atomic-write.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, readTokenMarkers } from "../src/atomic-write";

describe("writeAtomic", () => {
  it("replaces content and leaves a .bak of the prior file, no .tmp residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-aw-"));
    const f = join(dir, "x.env");
    writeFileSync(f, "old");
    writeAtomic(f, "new");
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(readFileSync(`${f}.bak`, "utf8")).toBe("old");
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });
  it("derives tmp/bak names from the target path (two paths never collide)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-aw2-"));
    const a = join(dir, "a.env");
    const b = join(dir, "b.env");
    writeFileSync(a, "a0"); writeFileSync(b, "b0");
    writeAtomic(a, "a1"); writeAtomic(b, "b1");
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(b, "utf8")).toBe("b1");
  });
});

describe("readTokenMarkers", () => {
  it("reads access/refresh lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    const f = join(dir, "x.env");
    writeFileSync(f, "FRESHBOOKS_ACCESS_TOKEN=aa\nFRESHBOOKS_REFRESH_TOKEN=rr\n");
    expect(readTokenMarkers(f)).toEqual({ access: "aa", refresh: "rr" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/atomic-write.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/atomic-write.ts
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
} from "node:fs";

/** Atomic write: backup to `${path}.bak`, stage in `${path}.tmp`, rename into place. */
export function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readTokenMarkers(path: string): { access?: string; refresh?: string } {
  const content = readFileSync(path, "utf8");
  return {
    access: content.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim(),
    refresh: content.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m)?.[1]?.trim(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/atomic-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atomic-write.ts test/atomic-write.test.ts
git commit -m "feat: extract atomic-write utility (shared by client refresh and migration)"
```

---

### Task 4: `getOrCreateClient` + ALS-backed `getFreshBooksClient`/`getAccountId`/`getBusinessId`

**Files:**
- Modify: `src/freshbooks-client.ts:13` (remove `fbClient` singleton), `273-309` (rewrite the three getters), and imports.
- Test: `test/freshbooks-client-profiles.test.ts`

**Interfaces:**
- Consumes: `ProfileState`, `currentProfile`, `getRegistry`, `runInProfile` (Tasks 1–2); `writeAtomic`, `readTokenMarkers` (Task 3); `decodeJwtExp`, `RETRY_OPTIONS`, `REQUEST_TIMEOUT_MS` (existing).
- Produces:
  - `function getOrCreateClient(profile: ProfileState): Client` — the ONLY `Client` construction site.
  - `function getFreshBooksClient(): Client` = `getOrCreateClient(currentProfile())`.
  - `function getAccountId(): string` / `function getBusinessId(): number` — from `currentProfile().config`.

- [ ] **Step 1: Write the failing test**

```ts
// test/freshbooks-client-profiles.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProfiles, runInProfile } from "../src/profiles";
import { getAccountId, getBusinessId, getOrCreateClient } from "../src/freshbooks-client";

const cfg = (a: string, acc: string, biz: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=at-${a}\nFRESHBOOKS_REFRESH_TOKEN=rt-${a}\nFRESHBOOKS_ACCOUNT_ID=${acc}\nFRESHBOOKS_BUSINESS_ID=${biz}\n`;

describe("ALS-backed id getters", () => {
  let acme: any, beta: any;
  beforeEach(() => {
    process.env.FRESHBOOKS_CLIENT_ID = "cid";
    const root = mkdtempSync(join(tmpdir(), "fb-cli-"));
    const dir = join(root, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "acme.env"), cfg("a", "ACC_A", "11"));
    writeFileSync(join(dir, "beta.env"), cfg("b", "ACC_B", "22"));
    const r = discoverProfiles(dir, join(root, ".env"));
    acme = r.profiles.get("acme"); beta = r.profiles.get("beta");
  });
  it("returns each profile's account/business id under its context", async () => {
    const a = await runInProfile(acme, async () => [getAccountId(), getBusinessId()]);
    const b = await runInProfile(beta, async () => [getAccountId(), getBusinessId()]);
    expect(a).toEqual(["ACC_A", 11]);
    expect(b).toEqual(["ACC_B", 22]);
  });
  it("getOrCreateClient returns a stable single instance per profile", () => {
    const c1 = getOrCreateClient(acme);
    const c2 = getOrCreateClient(acme);
    expect(c1).toBe(c2);
    expect(getOrCreateClient(beta)).not.toBe(c1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/freshbooks-client-profiles.test.ts`
Expected: FAIL — `getOrCreateClient` not exported; getters still read `process.env`.

- [ ] **Step 3: Write minimal implementation**

Remove `let fbClient: Client | null = null;` (line 13). Replace `getFreshBooksClient`/`getAccountId`/`getBusinessId` (lines 273–309) with:

```ts
import type { ProfileState } from "./profiles";
import { currentProfile } from "./profiles";

/** The ONLY place a FreshBooks Client is constructed (Amendment A1). */
export function getOrCreateClient(profile: ProfileState): Client {
  if (!profile.client) {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    if (!clientId) throw new Error("FRESHBOOKS_CLIENT_ID is not set");
    profile.client = new Client(clientId, {
      accessToken: profile.config.accessToken,
      refreshToken: profile.config.refreshToken,
      clientSecret: process.env.FRESHBOOKS_CLIENT_SECRET,
      redirectUri: process.env.FRESHBOOKS_REDIRECT_URI,
      retryOptions: RETRY_OPTIONS as any,
    });
    (profile.client as any).axios.defaults.timeout = REQUEST_TIMEOUT_MS;
  }
  return profile.client;
}

export function getFreshBooksClient(): Client {
  return getOrCreateClient(currentProfile());
}

export function getAccountId(): string {
  const id = currentProfile().config.accountId;
  if (!id) throw new Error("account id is not set for the active profile");
  return id;
}

export function getBusinessId(): number {
  const id = currentProfile().config.businessId;
  if (!id) throw new Error("business id is not set for the active profile");
  return parseInt(id, 10);
}
```

Also delete the now-unused `ENV_FILE` constant and `writeAtomic`/`readEnvTokens` definitions in this file (they move to Task 3 / are reworked in Task 5); import `writeAtomic`, `readTokenMarkers` from `./atomic-write` where needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/freshbooks-client-profiles.test.ts`
Expected: PASS. (Type errors about removed refresh functions are fixed in Task 5; if blocking, do Tasks 4 and 5 as one commit.)

- [ ] **Step 5: Commit**

```bash
git add src/freshbooks-client.ts test/freshbooks-client-profiles.test.ts
git commit -m "feat: single per-profile Client + ALS-backed id getters"
```

---

### Task 5: Per-profile refresh, persistence, single-flight, health, and `ensureFreshTokens`

**Files:**
- Modify: `src/freshbooks-client.ts` (refresh/persist/preflight/health section, lines ~62–271)
- Test: `test/freshbooks-client-profiles.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 (`writeAtomic`, `readTokenMarkers`), Task 4 (`getOrCreateClient`), `getRegistry` (Task 2), `decodeJwtExp` (existing).
- Produces:
  - `function refreshIfNeeded(profile: ProfileState, bufferSeconds?: number): Promise<{ refreshed: boolean; reason: string }>`
  - `function refreshTokensNow(profile: ProfileState): Promise<void>`
  - `async function ensureFreshTokens(): Promise<void>` — sequential, per-profile try/catch (Amendment A4).
  - `function inspectTokenHealth(profile: ProfileState, bufferSeconds?: number): TokenHealth` (`TokenHealth` adds `name: string`).
  - internal `preflightEnvFile(filePath)`, `persistTokens(profile, access, refresh)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/freshbooks-client-profiles.test.ts  (append)
import { readFileSync } from "node:fs";
import { refreshIfNeeded, inspectTokenHealth } from "../src/freshbooks-client";

// A token whose exp is far future so refreshIfNeeded is a no-op without any network.
function jwt(expSecondsFromNow: number): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

describe("refreshIfNeeded (no network when current)", () => {
  it("is a no-op for a token far from expiry", async () => {
    const profile: any = {
      name: "x", filePath: "/dev/null",
      config: { accessToken: jwt(3600), refreshToken: "r", accountId: "A", businessId: "1" },
      client: null, refreshInFlight: null,
    };
    const r = await refreshIfNeeded(profile);
    expect(r.refreshed).toBe(false);
    expect(r.reason).toContain("current");
  });
});

describe("inspectTokenHealth", () => {
  it("reports expiry from the profile's own config token", () => {
    const profile: any = {
      name: "x", filePath: "/dev/null",
      config: { accessToken: jwt(-10), refreshToken: "r", accountId: "A", businessId: "1" },
      client: null, refreshInFlight: null,
    };
    const h = inspectTokenHealth(profile);
    expect(h.name).toBe("x");
    expect(h.expired).toBe(true);
    expect(h.needsRefresh).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/freshbooks-client-profiles.test.ts`
Expected: FAIL — new signatures not present.

- [ ] **Step 3: Write minimal implementation**

Rewrite the refresh/persist/health block. `applyTokensToEnv` stays as-is (exported, pure). `decodeJwtExp` stays. Replace the rest:

```ts
import { existsSync, accessSync, readFileSync, constants as fsConstants } from "node:fs";
import { getRegistry } from "./profiles";
import { writeAtomic, readTokenMarkers } from "./atomic-write";

function preflightEnvFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`[freshbooks] ${filePath} does not exist — run \`npm run setup\``);
  try { accessSync(filePath, fsConstants.R_OK | fsConstants.W_OK); }
  catch { throw new Error(`[freshbooks] ${filePath} is not readable/writable`); }
  const { access, refresh } = readTokenMarkers(filePath);
  const missing: string[] = [];
  if (!access) missing.push("FRESHBOOKS_ACCESS_TOKEN");
  if (!refresh) missing.push("FRESHBOOKS_REFRESH_TOKEN");
  if (missing.length) throw new Error(`[freshbooks] ${filePath} is missing ${missing.join(", ")} — refusing to refresh`);
}

function persistTokens(profile: ProfileState, accessToken: string, refreshToken: string): void {
  try {
    const next = applyTokensToEnv(readFileSync(profile.filePath, "utf8"), accessToken, refreshToken);
    writeAtomic(profile.filePath, next);
    const after = readTokenMarkers(profile.filePath);
    if (after.access !== accessToken || after.refresh !== refreshToken) throw new Error("post-write verification failed");
  } catch (err: any) {
    console.error(`[freshbooks] CRITICAL — refresh succeeded but writing ${profile.filePath} failed (profile "${profile.name}").`);
    console.error(`[freshbooks] NEW ACCESS TOKEN:  ${accessToken}`);
    console.error(`[freshbooks] NEW REFRESH TOKEN: ${refreshToken}`);
    // A10: keep config authoritative even on write failure so the live (already-rotated)
    // client and the expiry check agree, avoiding a re-rotation churn loop this process.
    profile.config.accessToken = accessToken;
    profile.config.refreshToken = refreshToken;
    throw new Error(`Token persist to ${profile.filePath} failed: ${err?.message ?? err}`, { cause: err });
  }
  profile.config.accessToken = accessToken;
  profile.config.refreshToken = refreshToken;
}

async function refreshAndPersist(profile: ProfileState): Promise<void> {
  if (profile.refreshInFlight) return profile.refreshInFlight; // per-profile single-flight
  profile.refreshInFlight = (async () => {
    try {
      preflightEnvFile(profile.filePath);
      const client = getOrCreateClient(profile); // SAME object the handler uses (A1)
      const result = await client.refreshAccessToken();
      if (!result) throw new Error("FreshBooks refreshAccessToken returned no data");
      persistTokens(profile, result.accessToken, result.refreshToken);
      client.accessToken = result.accessToken;
      client.refreshToken = result.refreshToken;
      console.error(`[freshbooks] access token refreshed for profile "${profile.name}"`);
    } finally {
      profile.refreshInFlight = null;
    }
  })();
  return profile.refreshInFlight;
}

export async function refreshIfNeeded(
  profile: ProfileState,
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): Promise<{ refreshed: boolean; reason: string }> {
  const token = profile.config.accessToken;
  if (!token) return { refreshed: false, reason: "no access token configured" };
  const exp = decodeJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp !== null && exp - now >= bufferSeconds) return { refreshed: false, reason: "access token is current" };
  const reason = exp === null ? "access token expiry could not be decoded"
    : exp - now <= 0 ? "access token expired" : "access token near expiry";
  await refreshAndPersist(profile);
  return { refreshed: true, reason };
}

export async function refreshTokensNow(profile: ProfileState): Promise<void> {
  await refreshAndPersist(profile);
}

/** Startup: refresh each profile sequentially with per-profile isolation (A4). Never throws. */
export async function ensureFreshTokens(): Promise<void> {
  for (const profile of getRegistry().profiles.values()) {
    try { await refreshIfNeeded(profile); }
    catch (err) { console.error(`[freshbooks] startup refresh failed for "${profile.name}":`, err instanceof Error ? err.message : err); }
  }
}

export interface TokenHealth {
  name: string;
  filePath: string;
  access?: string;
  refresh?: string;
  expirySeconds: number | null;
  expired: boolean;
  issues: string[];
  needsRefresh: boolean;
}

export function inspectTokenHealth(
  profile: ProfileState,
  bufferSeconds: number = REFRESH_BUFFER_SECONDS,
): TokenHealth {
  const { accessToken: access, refreshToken: refresh } = profile.config;
  const issues: string[] = [];
  if (!access) issues.push("no access token");
  if (!refresh) issues.push("no refresh token");
  let expirySeconds: number | null = null;
  let expired = false;
  if (access) {
    const exp = decodeJwtExp(access);
    if (exp !== null) { expirySeconds = exp - Math.floor(Date.now() / 1000); expired = expirySeconds <= 0; }
  }
  const nearExpiry = expirySeconds !== null && expirySeconds < bufferSeconds;
  const needsRefresh = expired || nearExpiry || (access !== undefined && expirySeconds === null);
  return { name: profile.name, filePath: profile.filePath, access, refresh, expirySeconds, expired, issues, needsRefresh };
}
```

Delete the old `ensureFreshToken`, `refreshInFlight` module global, old `inspectTokenHealth`, old `preflightEnvFile`, old `persistTokens`, old `readEnvTokens`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/freshbooks-client-profiles.test.ts && npm run build`
Expected: tests PASS; `npm run build` may flag callers of the removed `ensureFreshToken`/zero-arg `refreshTokensNow`/`inspectTokenHealth` (`index.ts`, `refresh-tokens.ts`) — fixed in Tasks 8 and 11.

- [ ] **Step 5: Commit**

```bash
git add src/freshbooks-client.ts test/freshbooks-client-profiles.test.ts
git commit -m "feat: per-profile refresh, persistence, single-flight, health, ensureFreshTokens"
```

---

### Task 6: `withAccount` / `withoutAccount` wrapper

**Files:**
- Modify: `src/tools/with-refresh.ts` (full rewrite)
- Test: `test/with-account.test.ts`

**Interfaces:**
- Consumes: `refreshIfNeeded` (Task 5); `resolveProfile`, `runInProfile`, `profileCount`, `profileNames`, `defaultProfileName`, `UnknownProfileError` (Task 2); `zod`.
- Produces:
  - `function withAccount<T extends ToolDefinition>(toolDef: T): T`
  - `function withoutAccount<T extends ToolDefinition>(toolDef: T): T`
  - `type ToolDefinition = { name: string; inputSchema: Record<string, unknown>; handler: (args: any, extra: unknown) => Promise<any> }`

- [ ] **Step 1: Write the failing test**

```ts
// test/with-account.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build a registry the wrapper will read, then import the wrapper fresh.
import { discoverProfiles, resetRegistry } from "../src/profiles";

const cfg = (a: string, acc: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=${jwt()}\nFRESHBOOKS_REFRESH_TOKEN=rt-${a}\nFRESHBOOKS_ACCOUNT_ID=${acc}\nFRESHBOOKS_BUSINESS_ID=1\n`;
function jwt(): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({})}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
}

// A fake tool def matching the SDK shape.
const makeTool = (): any => ({
  name: "freshbooks_demo",
  description: "demo",
  inputSchema: { page: { _def: { typeName: "ZodNumber" } } },
  handler: async (args: any) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
});

describe("withAccount", () => {
  let withAccount: any;
  beforeEach(async () => {
    process.env.FRESHBOOKS_CLIENT_ID = "cid";
    ({ withAccount } = await import("../src/tools/with-refresh"));
  });

  it("injects an `account` field into inputSchema", () => {
    const wrapped = withAccount(makeTool());
    expect(Object.keys(wrapped.inputSchema)).toContain("account");
  });

  it("returns isError (never throws) when account omitted and >=2 profiles", async () => {
    // Two profiles via a monkeypatched registry.
    const mod = await import("../src/profiles");
    (mod as any).resetRegistry?.();
    const root = mkdtempSync(join(tmpdir(), "fb-wa-")); const dir = join(root, "profiles"); mkdirSync(dir);
    writeFileSync(join(dir, "acme.env"), cfg("a", "A")); writeFileSync(join(dir, "beta.env"), cfg("b", "B"));
    // Replace registry with this dir's discovery.
    const disc = discoverProfiles(dir, join(root, ".env"));
    viSpyRegistry(mod, disc);
    const wrapped = withAccount(makeTool());
    const res = await wrapped.handler({ page: 1 }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/acme.*beta|multiple/);
  });

  it("resolves the named profile, strips `account`, runs the handler", async () => {
    const mod = await import("../src/profiles");
    const root = mkdtempSync(join(tmpdir(), "fb-wa2-")); const dir = join(root, "profiles"); mkdirSync(dir);
    writeFileSync(join(dir, "acme.env"), cfg("a", "A"));
    viSpyRegistry(mod, discoverProfiles(dir, join(root, ".env")));
    const wrapped = withAccount(makeTool());
    const res = await wrapped.handler({ page: 7, account: "acme" }, {});
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ page: 7 }); // account stripped
  });

  it("zero profiles -> isError, not a throw (never-throw contract)", async () => {
    const mod = await import("../src/profiles");
    const root = mkdtempSync(join(tmpdir(), "fb-wa0-"));
    viSpyRegistry(mod, discoverProfiles(join(root, "profiles"), join(root, ".env")));
    const wrapped = withAccount(makeTool());
    const res = await wrapped.handler({ account: "ghost" }, {});
    expect(res.isError).toBe(true);
  });
});

// helper: force getRegistry() to return a given DiscoveryResult
import { vi } from "vitest";
function viSpyRegistry(mod: any, disc: any) {
  vi.spyOn(mod, "getRegistry").mockReturnValue(disc);
  vi.spyOn(mod, "profileCount").mockReturnValue(disc.profiles.size);
  vi.spyOn(mod, "profileNames").mockReturnValue([...disc.profiles.keys()]);
  vi.spyOn(mod, "defaultProfileName").mockReturnValue(disc.profiles.size === 1 ? [...disc.profiles.keys()][0] : null);
  vi.spyOn(mod, "resolveProfile").mockImplementation((n: any) => {
    const p = disc.profiles.get(String(n).toLowerCase());
    if (!p) { const { UnknownProfileError } = mod; throw new UnknownProfileError(n, [...disc.profiles.keys()]); }
    return p;
  });
}
```

> Note for the implementer: if `vi.spyOn` on module exports is awkward under the project's ESM/CJS setup, instead pass an explicit `profiles` dir via an env var the wrapper reads in tests, or test through the real registry by writing files into a temp `profiles/` and calling `resetRegistry()`. The behavioral assertions (schema has `account`; omitted+≥2 → isError; named → strips+runs; zero/unknown → isError) are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/with-account.test.ts`
Expected: FAIL — `withAccount` not exported / still named `withTokenRefresh`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/with-refresh.ts  (full rewrite)
import { z } from "zod";
import { refreshIfNeeded } from "../freshbooks-client";
import {
  resolveProfile,
  runInProfile,
  profileCount,
  profileNames,
  defaultProfileName,
  UnknownProfileError,
  type ProfileState,
} from "../profiles";

export type ToolDefinition = {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, extra: unknown) => Promise<any>;
};

const accountField = z
  .string()
  .optional()
  .describe(
    "Which configured FreshBooks login to act on. Run freshbooks_list_accounts to see valid names. Required when more than one account is configured.",
  );

const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** Wrap an API tool: inject `account`, resolve the profile, refresh it, run inside ALS. */
export function withAccount<T extends ToolDefinition>(toolDef: T): T {
  const originalHandler = toolDef.handler;
  return {
    ...toolDef,
    inputSchema: { ...toolDef.inputSchema, account: accountField },
    handler: async (args: any, extra: unknown) => {
      let profile: ProfileState;
      try {
        const requested = typeof args?.account === "string" ? args.account.trim() : "";
        let name = requested;
        if (!name) {
          if (profileCount() >= 2) {
            return errorResult(
              `This server has multiple FreshBooks accounts configured (${profileNames().join(", ")}). Pass account=<name> to choose one.`,
            );
          }
          const def = defaultProfileName();
          if (!def) return errorResult("No FreshBooks accounts are configured. Run `npm run setup` to add one.");
          name = def;
        }
        profile = resolveProfile(name);
      } catch (err) {
        if (err instanceof UnknownProfileError) return errorResult(err.message);
        return errorResult(`Account resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const { account: _drop, ...handlerArgs } = args ?? {};
      return runInProfile(profile, async () => {
        try {
          await refreshIfNeeded(profile);
        } catch (err) {
          console.error(
            `[freshbooks] pre-call refresh failed for "${profile.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return originalHandler(handlerArgs, extra);
      });
    },
  } as T;
}

/** Account-free tools (help, list_accounts): no schema change, no profile context. */
export function withoutAccount<T extends ToolDefinition>(toolDef: T): T {
  return toolDef;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/with-account.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/with-refresh.ts test/with-account.test.ts
git commit -m "feat: withAccount wrapper (schema injection, resolution, never-throw, ALS)"
```

---

### Task 7: `freshbooks_list_accounts` tool + registry wiring + real-MCP test

**Files:**
- Create: `src/tools/accounts.ts`
- Modify: `src/tool-registry.ts`
- Test: `test/accounts-tool.test.ts`

**Interfaces:**
- Consumes: `getRegistry` (Task 2), `getOrCreateClient`, `refreshIfNeeded`, `inspectTokenHealth` (Tasks 4–5), `tool()` (SDK), `withAccount`/`withoutAccount` (Task 6).
- Produces: `export const listAccounts` (tool def). `allTools` length becomes 76.

- [ ] **Step 1: Write the failing test**

```ts
// test/accounts-tool.test.ts
import { describe, it, expect } from "vitest";
import { allTools } from "../src/tool-registry";

describe("registry wiring", () => {
  it("registers exactly 76 tools", () => {
    expect(allTools.length).toBe(76);
  });
  it("includes freshbooks_list_accounts and it has no `account` field", () => {
    const la = allTools.find((t: any) => t.name === "freshbooks_list_accounts");
    expect(la).toBeTruthy();
    expect(Object.keys((la as any).inputSchema)).not.toContain("account");
  });
  it("every API tool except help/list_accounts carries an injected `account` field", () => {
    const free = new Set(["freshbooks_help", "freshbooks_list_accounts"]);
    for (const t of allTools as any[]) {
      if (free.has(t.name)) continue;
      expect(Object.keys(t.inputSchema)).toContain("account");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/accounts-tool.test.ts`
Expected: FAIL — count is 75 / `list_accounts` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/accounts.ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { getRegistry } from "../profiles";
import { getOrCreateClient, refreshIfNeeded, inspectTokenHealth } from "../freshbooks-client";

export const listAccounts = tool(
  "freshbooks_list_accounts",
  "List the FreshBooks logins this server is configured with. Returns each profile's name, account_id, business_id, company name, and token health. Use a returned name as the `account` argument to other tools.",
  {},
  async () => {
    try {
      const reg = getRegistry();
      const accounts: unknown[] = [];
      for (const profile of reg.profiles.values()) {
        const health = inspectTokenHealth(profile);
        let company: string | null = null;
        try {
          await refreshIfNeeded(profile);
          const me = await getOrCreateClient(profile).users.me();
          const memberships = (me as any)?.data?.businessMemberships ?? [];
          const match = memberships.find(
            (m: any) => String(m?.business?.accountId ?? m?.accountId) === profile.config.accountId,
          );
          company = match?.business?.name ?? memberships[0]?.business?.name ?? null;
        } catch {
          // Health is still reported; company stays null on auth/network failure.
        }
        accounts.push({
          account: profile.name,
          account_id: profile.config.accountId,
          business_id: profile.config.businessId,
          company,
          token: {
            expiry_seconds: health.expirySeconds,
            expired: health.expired,
            needs_refresh: health.needsRefresh,
          },
        });
      }
      const ignored = [...reg.broken, ...reg.duplicates];
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ accounts, ignored_files: ignored }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to list accounts: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnlyHint: true } },
);
```

In `src/tool-registry.ts`: change the import on line 1 to `import { withAccount, withoutAccount } from "./tools/with-refresh";`, add `import { listAccounts } from "./tools/accounts";`, and replace the final array build (lines 28–65) so API tools use `withAccount` and the two account-free tools use `withoutAccount`:

```ts
const accountScoped = [
  listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice,
  listClients, getClient, createClient, updateClient, deleteClient,
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  listPayments, getPayment, createPayment, updatePayment, deletePayment,
  listTimeEntries, getTimeEntry, createTimeEntry, updateTimeEntry, deleteTimeEntry,
  listItems, getItem, createItem, updateItem,
  listOtherIncomes, getOtherIncome, createOtherIncome, updateOtherIncome, deleteOtherIncome,
  listBills, getBill, createBill, deleteBill,
  listBillPayments, getBillPayment, createBillPayment, updateBillPayment, deleteBillPayment,
  listBillVendors, getBillVendor, createBillVendor, updateBillVendor, deleteBillVendor,
  listCreditNotes, getCreditNote, createCreditNote, updateCreditNote, deleteCreditNote,
  listProjects, getProject, createProject, updateProject, deleteProject,
  listServices, getService, createService,
  reportPaymentsCollected, reportProfitLoss, reportTaxSummary,
  listTasks, getTask, createTask, updateTask, deleteTask,
  listExpenseCategories, getExpenseCategory,
  createJournalEntry, listJournalEntryAccounts, listJournalEntryDetails,
].map(withAccount);

const accountFree = [freshbooksHelp, listAccounts].map(withoutAccount);

export const allTools = [...accountScoped, ...accountFree];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/accounts-tool.test.ts && npm run build`
Expected: tests PASS (76 tools); build clean except `index.ts`/`refresh-tokens.ts` (Tasks 8/11).

- [ ] **Step 5: Commit**

```bash
git add src/tools/accounts.ts src/tool-registry.ts test/accounts-tool.test.ts
git commit -m "feat: freshbooks_list_accounts tool + per-tool account wiring"
```

---

### Task 8: Startup — connect first, refresh in the background, server lock

**Files:**
- Create: `src/server-lock.ts`
- Modify: `src/index.ts`
- Test: `test/server-lock.test.ts`

**Interfaces:**
- Produces:
  - `function acquireServerLock(): void` (writes `${PROFILES_DIR}/../.server.lock` with pid+timestamp; registers `process.on("exit")` cleanup)
  - `function releaseServerLock(): void`
  - `function isServerLockFresh(maxAgeMs?: number): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/server-lock.test.ts
import { describe, it, expect } from "vitest";
import { lockPathFor, writeLock, isLockFresh } from "../src/server-lock";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server lock", () => {
  it("reports a just-written lock as fresh and an absent one as stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock-"));
    const p = lockPathFor(dir);
    expect(isLockFresh(p, 60_000)).toBe(false);
    writeLock(p);
    expect(isLockFresh(p, 60_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server-lock.ts
import { writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

export function lockPathFor(rootDir: string): string {
  return join(rootDir, ".server.lock");
}
export function writeLock(path: string): void {
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }));
}
export function isLockFresh(path: string, maxAgeMs = 60_000): boolean {
  if (!existsSync(path)) return false;
  return Date.now() - statSync(path).mtimeMs < maxAgeMs;
}
```

(`index.ts` writes the lock at the package root and removes it on exit; migration in Task 9 refuses if `isLockFresh` unless `--force`.)

Rewrite `src/index.ts`:

```ts
import "./load-env";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { freshbooksServer } from "./server";
import { ensureFreshTokens } from "./freshbooks-client";
import { lockPathFor, writeLock } from "./server-lock";
import { existsSync, rmSync } from "node:fs";

async function main() {
  const lock = lockPathFor(join(__dirname, ".."));
  writeLock(lock);
  const cleanup = () => { try { if (existsSync(lock)) rmSync(lock); } catch { /* ignore */ } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  // Connect FIRST so a slow/rate-limited refresh can never exceed the MCP init
  // timeout and fail the whole server (Amendment A4). Lazy pre-call refresh in
  // withAccount covers correctness; this startup pass is best-effort.
  const transport = new StdioServerTransport();
  await freshbooksServer.instance.connect(transport);

  ensureFreshTokens().catch((err) =>
    console.error("[freshbooks] background startup refresh error:", err instanceof Error ? err.message : err),
  );
}

main().catch((err) => {
  console.error("Failed to start FreshBooks MCP server:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server-lock.test.ts && npm run build`
Expected: tests PASS; build clean (only `refresh-tokens.ts` remains, Task 11).

- [ ] **Step 5: Commit**

```bash
git add src/server-lock.ts src/index.ts test/server-lock.test.ts
git commit -m "feat: connect-first startup with background per-profile refresh + server lock"
```

---

### Task 9: Transactional migration of legacy `.env` → `profiles/<name>.env`

**Files:**
- Create: `src/migrate.ts`
- Test: `test/migrate.test.ts`

**Interfaces:**
- Consumes: `ProfileConfig`, `parseProfileConfig`, `normalizeProfileName` (Task 1), `writeAtomic`, `readTokenMarkers` (Task 3), `isLockFresh`/`lockPathFor` (Task 8).
- Produces:
  - `const MIGRATED_MARKER = "FRESHBOOKS_MIGRATED"`
  - `function isMigrated(baseEnvContent: string): boolean`
  - `function buildProfileFileContent(config: ProfileConfig): string`
  - `function stripTokensFromBaseEnv(content: string): string`
  - `function runMigration(opts: { name: string; rootDir: string; force?: boolean }): { profilePath: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMigrated, buildProfileFileContent, stripTokensFromBaseEnv, runMigration,
} from "../src/migrate";
import { parseProfileConfig } from "../src/profiles";

const legacy =
  "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_CLIENT_SECRET=sec\nFRESHBOOKS_REDIRECT_URI=u\n" +
  "FRESHBOOKS_ACCESS_TOKEN=at\nFRESHBOOKS_REFRESH_TOKEN=rt\nFRESHBOOKS_ACCOUNT_ID=ACC\nFRESHBOOKS_BUSINESS_ID=9\n";

describe("pure helpers", () => {
  it("stripTokensFromBaseEnv removes tokens/ids, keeps app creds, adds marker", () => {
    const out = stripTokensFromBaseEnv(legacy);
    expect(out).toContain("FRESHBOOKS_CLIENT_ID=cid");
    expect(out).not.toMatch(/FRESHBOOKS_ACCESS_TOKEN=/);
    expect(out).not.toMatch(/FRESHBOOKS_ACCOUNT_ID=/);
    expect(isMigrated(out)).toBe(true);
  });
  it("buildProfileFileContent round-trips through parseProfileConfig", () => {
    const cfg = { accessToken: "at", refreshToken: "rt", accountId: "ACC", businessId: "9" };
    expect(parseProfileConfig(buildProfileFileContent(cfg))).toEqual(cfg);
  });
});

describe("runMigration (transactional ordering)", () => {
  it("writes+verifies the profile file BEFORE stripping base .env", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-mig-"));
    const base = join(root, ".env");
    writeFileSync(base, legacy);
    const { profilePath } = runMigration({ name: "Acme", rootDir: root });
    expect(profilePath.endsWith("/profiles/acme.env")).toBe(true);
    // profile file is complete & parseable
    expect(parseProfileConfig(readFileSync(profilePath, "utf8"))).toEqual({
      accessToken: "at", refreshToken: "rt", accountId: "ACC", businessId: "9",
    });
    // base .env no longer holds tokens, has marker, keeps app creds
    const after = readFileSync(base, "utf8");
    expect(after).toContain("FRESHBOOKS_CLIENT_ID=cid");
    expect(after).not.toMatch(/FRESHBOOKS_REFRESH_TOKEN=/);
    expect(isMigrated(after)).toBe(true);
  });
  it("is idempotent: refuses to clobber an existing profile file", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-mig2-"));
    writeFileSync(join(root, ".env"), legacy);
    runMigration({ name: "acme", rootDir: root });
    expect(() => runMigration({ name: "acme", rootDir: root })).toThrow(/already|exists|migrated/i);
  });
  it("refuses when migration marker already present (already migrated)", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-mig3-"));
    writeFileSync(join(root, ".env"), "FRESHBOOKS_CLIENT_ID=cid\nFRESHBOOKS_MIGRATED=1\n");
    expect(() => runMigration({ name: "x", rootDir: root })).toThrow(/already migrated/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/migrate.ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic, readTokenMarkers } from "./atomic-write";
import { parseProfileConfig, normalizeProfileName, type ProfileConfig } from "./profiles";
import { lockPathFor, isLockFresh } from "./server-lock";

export const MIGRATED_MARKER = "FRESHBOOKS_MIGRATED";

export function isMigrated(baseEnvContent: string): boolean {
  return new RegExp(`^${MIGRATED_MARKER}=`, "m").test(baseEnvContent);
}

export function buildProfileFileContent(config: ProfileConfig): string {
  return [
    `FRESHBOOKS_ACCESS_TOKEN=${config.accessToken}`,
    `FRESHBOOKS_REFRESH_TOKEN=${config.refreshToken}`,
    `FRESHBOOKS_ACCOUNT_ID=${config.accountId}`,
    `FRESHBOOKS_BUSINESS_ID=${config.businessId}`,
    "",
  ].join("\n");
}

export function stripTokensFromBaseEnv(content: string): string {
  let out = content
    .replace(/^FRESHBOOKS_ACCESS_TOKEN=.*$\n?/m, "")
    .replace(/^FRESHBOOKS_REFRESH_TOKEN=.*$\n?/m, "")
    .replace(/^FRESHBOOKS_ACCOUNT_ID=.*$\n?/m, "")
    .replace(/^FRESHBOOKS_BUSINESS_ID=.*$\n?/m, "");
  if (!isMigrated(out)) {
    if (!out.endsWith("\n")) out += "\n";
    out += `${MIGRATED_MARKER}=1\n`;
  }
  return out;
}

/**
 * Move the legacy single-login tokens from base .env into profiles/<name>.env.
 * Ordering (Amendment A2): refuse if a server holds the lock -> create profiles/ ->
 * re-read the FRESHEST tokens from .env -> write+verify the profile file atomically
 * -> ONLY THEN strip+mark base .env atomically. Refuse to overwrite an existing profile.
 */
export function runMigration(opts: { name: string; rootDir: string; force?: boolean }): { profilePath: string } {
  const { rootDir } = opts;
  const name = normalizeProfileName(opts.name);
  const baseEnv = join(rootDir, ".env");
  const profilesDir = join(rootDir, "profiles");
  const profilePath = join(profilesDir, `${name}.env`);

  if (!existsSync(baseEnv)) throw new Error(`No .env at ${baseEnv} — nothing to migrate.`);

  if (!opts.force && isLockFresh(lockPathFor(rootDir))) {
    throw new Error("A FreshBooks MCP server appears to be running (fresh .server.lock). Stop it first, then migrate (or pass --force).");
  }

  // Re-read the freshest pair from disk immediately before the move.
  const baseContent = readFileSync(baseEnv, "utf8");
  if (isMigrated(baseContent)) throw new Error("Base .env is already migrated (FRESHBOOKS_MIGRATED marker present).");

  const config = parseProfileConfig(baseContent);
  if (!config) throw new Error("Base .env has no complete token set to migrate.");

  if (existsSync(profilePath)) {
    throw new Error(`profiles/${name}.env already exists — refusing to overwrite. Choose a different name.`);
  }

  mkdirSync(profilesDir, { recursive: true });
  if (!existsSync(profilesDir)) throw new Error(`Failed to create ${profilesDir}.`);

  // 1) write + verify the profile file FIRST.
  writeAtomic(profilePath, buildProfileFileContent(config));
  const check = readTokenMarkers(profilePath);
  if (check.access !== config.accessToken || check.refresh !== config.refreshToken) {
    throw new Error("Profile file failed post-write verification — base .env left intact.");
  }

  // 2) only now strip + mark base .env (atomic; .bak is *.bak -> gitignored).
  writeAtomic(baseEnv, stripTokensFromBaseEnv(baseContent));

  return { profilePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrate.ts test/migrate.test.ts
git commit -m "feat: transactional .env -> profiles/ migration (write+verify before strip)"
```

---

### Task 10: Setup wizard — add-login loop, business selection, migration, build-order checklist

**Files:**
- Modify: `scripts/setup.ts`

**Interfaces:**
- Consumes: `runMigration` (Task 9), `normalizeProfileName` (Task 1), `buildProfileFileContent` (Task 9), existing OAuth/`users.me()` flow.

- [ ] **Step 1: Add migration + add-login (manual verification task — no unit test)**

Edit `scripts/setup.ts`:

1. After loading existing config, if base `.env` has tokens and is not yet migrated, offer migration:

```ts
import { runMigration } from "../src/migrate";
import { normalizeProfileName, buildProfileFileContent } from "../src/profiles";
import { isMigrated } from "../src/migrate";
// ...
const baseHasTokens = existsSync(envPath) && /FRESHBOOKS_REFRESH_TOKEN=.+/.test(readFileSync(envPath, "utf8"));
if (baseHasTokens && !isMigrated(readFileSync(envPath, "utf8"))) {
  console.log("\nFound an existing single-login .env. Before continuing:");
  console.log("  1) fully quit Claude / any running MCP server");
  console.log("  2) run `npm run build`");
  console.log("  3) then run this setup again to migrate.\n");
  const name = normalizeProfileName(await ask("Name for this existing login (e.g. 'acme'): "));
  const { profilePath } = runMigration({ name, rootDir: join(__dirname, "..") });
  console.log(`Migrated existing tokens -> ${profilePath}\n`);
}
```

2. Fix the `businessMemberships[0]` limitation (`scripts/setup.ts:287-293`): when more than one membership exists, list them and let the user pick which business this profile maps to; write the chosen `accountId`/`businessId`.

3. After a successful OAuth add, write `profiles/<name>.env` via `buildProfileFileContent(config)` + `writeAtomic`, and loop: "Add another login? (y/N)".

4. Ensure the wizard never writes tokens into base `.env` anymore — base `.env` holds only `FRESHBOOKS_CLIENT_ID`/`SECRET`/`REDIRECT_URI` (+ `FRESHBOOKS_MIGRATED=1`).

- [ ] **Step 2: Manually verify**

Run (in a scratch copy, not your live `.env`):
```bash
npm run build
node -e "require('./dist/migrate')" # sanity: module loads
```
Expected: setup offers migration, writes `profiles/<name>.env`, and base `.env` ends token-free with the marker. Verify `profiles/acme.env` parses and the original tokens match.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup.ts
git commit -m "feat: setup wizard migrates legacy .env and adds named logins"
```

---

### Task 11: `refresh-tokens` / `check-tokens` CLI — iterate profiles

**Files:**
- Modify: `scripts/refresh-tokens.ts`

**Interfaces:**
- Consumes: `getRegistry` (Task 2), `inspectTokenHealth(profile)`, `refreshTokensNow(profile)` (Task 5).

- [ ] **Step 1: Rewrite the CLI to iterate the registry**

Replace the body so it:
- adds `--profile <name>` (optional; default = all profiles);
- builds the profile set from `getRegistry().profiles`;
- for `--check-only`: prints `inspectTokenHealth(profile)` for each profile (name-tagged) and exits non-zero if any is unhealthy;
- otherwise: for each profile needing refresh, calls `refreshTokensNow(profile)` with a per-profile try/catch so one failure doesn't abort the rest; exit 1 if any failed;
- reports "no profiles configured — run `npm run setup`" with exit 2 when the registry is empty.

```ts
// scripts/refresh-tokens.ts  (core of new main())
import "../src/load-env";
import { getRegistry, type ProfileState } from "../src/profiles";
import { inspectTokenHealth, refreshTokensNow } from "../src/freshbooks-client";

async function main(): Promise<void> {
  const { checkOnly, json, bufferMinutes, only } = parseArgs(process.argv.slice(2));
  const bufferSeconds = bufferMinutes * 60;
  const reg = getRegistry();
  let profiles: ProfileState[] = [...reg.profiles.values()];
  if (only) profiles = profiles.filter((p) => p.name === only.toLowerCase());

  if (profiles.length === 0) {
    console.error(only ? `No profile named "${only}".` : "No FreshBooks accounts configured. Run `npm run setup`.");
    process.exit(2);
  }

  let anyUnhealthy = false;
  let anyFailed = false;
  for (const profile of profiles) {
    let health = inspectTokenHealth(profile, bufferSeconds);
    const unhealthy = health.needsRefresh || health.issues.length > 0;
    if (checkOnly) {
      if (json) console.log(JSON.stringify({ profile: profile.name, health }));
      else printHealth(health);
      anyUnhealthy ||= unhealthy;
      continue;
    }
    if (!unhealthy) { if (!json) console.error(`[${profile.name}] healthy`); continue; }
    try {
      await refreshTokensNow(profile);
      if (!json) console.error(`[${profile.name}] refreshed`);
    } catch (err) {
      anyFailed = true;
      console.error(`[${profile.name}] REFRESH FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(checkOnly ? (anyUnhealthy ? 1 : 0) : anyFailed ? 1 : 0);
}
```

Add `--profile` parsing to `parseArgs` (return `only?: string`). Update `printHealth` to print `health.name`.

- [ ] **Step 2: Manually verify**

Run: `npm run build && npm run check-tokens`
Expected: per-profile health lines (or the "no profiles" message in a fresh clone). No crash, no ALS error.

- [ ] **Step 3: Commit**

```bash
git add scripts/refresh-tokens.ts
git commit -m "feat: per-profile refresh-tokens / check-tokens CLI"
```

---

### Task 12: `.gitignore`, `.env.example`, and a gitignore-safety test

**Files:**
- Modify: `.gitignore`, `.env.example`
- Test: `test/gitignore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/gitignore.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

function ignored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: new URL("..", import.meta.url) });
    return true;
  } catch {
    return false;
  }
}

describe("gitignore protects all token stores", () => {
  it("ignores profiles/<name>.env and the profiles dir", () => {
    expect(ignored("profiles/acme.env")).toBe(true);
    expect(ignored("profiles/anything.env")).toBe(true);
  });
  it("ignores base .env and any migration backup", () => {
    expect(ignored(".env")).toBe(true);
    expect(ignored(".env.bak")).toBe(true);
    expect(ignored("profiles/acme.env.bak")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/gitignore.test.ts`
Expected: FAIL — `profiles/acme.env` not ignored.

- [ ] **Step 3: Implement**

Add to `.gitignore` (after the `.env` line):

```
# Per-login OAuth token stores (one file per FreshBooks login) — never commit.
profiles/
```

Rewrite `.env.example` so it documents ONLY shared app creds plus a pointer:

```
# Shared OAuth APP credentials (one developer app authorizes all your logins).
FRESHBOOKS_CLIENT_ID=
FRESHBOOKS_CLIENT_SECRET=
FRESHBOOKS_REDIRECT_URI=

# Per-login tokens are NOT stored here. Run `npm run setup` to create one
# profiles/<name>.env per FreshBooks login (access/refresh token + account/business id).
# Optional: pick which profile a tool uses when you omit `account` and only one exists.
# FRESHBOOKS_DEFAULT_PROFILE=
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/gitignore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .env.example test/gitignore.test.ts
git commit -m "feat: gitignore profiles/ token stores + app-creds-only .env.example + safety test"
```

---

### Task 13: Docs, tool-count sync, and the bundled token-refresh skill

**Files:**
- Modify: `README.md`, `SETUP.md`, `CLAUDE.md`, `docs/claude-project-system-prompt.md`, `src/docs/content.ts`, the `freshbooks-token-refresh` skill (`SKILL.md` + any bundled runner), `package.json` (description).
- Test: `test/doc-tool-count.test.ts` (existing — must pass at 76).

- [ ] **Step 1: Update the tool total 75 → 76 everywhere the count test watches**

`test/doc-tool-count.test.ts` watches: `README.md` (3 occurrences), `SETUP.md` (1), `docs/claude-project-system-prompt.md` (1), `CLAUDE.md` (2), `CONTRIBUTING.md` (0), and `package.json` description (1). Change every literal "75 tools"/"(75 total)" to 76. Run `npx vitest run test/doc-tool-count.test.ts` until green.

- [ ] **Step 2: Document the multi-account model**

- `README.md` / `SETUP.md`: the profiles model; `npm run setup` migration + add-login; the `account` parameter; `freshbooks_list_accounts`; per-profile `check-tokens`.
- `CLAUDE.md`: split the env-var table (shared app creds in `.env` vs per-profile `profiles/<name>.env`); document the `account` convention, `freshbooks_list_accounts`, the single-`getOrCreateClient` rule, and per-profile token persistence; update the tool total and the `src/` tree (add `profiles.ts`, `atomic-write.ts`, `migrate.ts`, `server-lock.ts`, `tools/accounts.ts`).
- `src/docs/content.ts`: update the architecture/overview help topics for multi-account; `render-tools.ts` picks up the new tool automatically.

- [ ] **Step 3: Update the bundled `freshbooks-token-refresh` skill (Amendment A8)**

Point the skill at the per-profile model: it must run `npm run check-tokens` (which now iterates profiles) and, on a specific profile's 401, `npm run refresh-tokens -- --profile <name>` — never assume base `.env` holds tokens. Update its trigger/description text to mention "a specific account/profile".

- [ ] **Step 4: Full verification**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, ALL tests pass (including `doc-tool-count` at 76 and `gitignore`), lint clean.

- [ ] **Step 5: Commit**

```bash
git add README.md SETUP.md CLAUDE.md docs/ src/docs/ package.json .claude/
git commit -m "docs: document multi-account profiles; sync tool count to 76; update token-refresh skill"
```

---

## Self-Review

**Spec coverage (A1–A11):**
- A1 single Client → Task 4 (`getOrCreateClient`) + Task 5 (refresh uses it). ✓
- A2 transactional migration (ordering, quiesce/lock, marker, refuse-overwrite, ignored backup) → Tasks 9 + 8 (lock) + 12 (backup ignored). ✓
- A3 implicit legacy profile + never-throw resolution → Task 2 (legacy fallback) + Task 6 (try/catch). ✓
- A4 non-blocking startup → Task 8. ✓
- A5 validated discovery → Task 2 (broken/duplicate exclusion). ✓
- A6 name normalization → Task 1 + Task 2 (case detection). ✓
- A7 duplicate-login detection → Task 2. ✓
- A8 per-profile CLIs + skill → Tasks 11 + 13. ✓
- A9 `list_accounts` explicit client → Task 7. ✓
- A10 authoritative `config` + no residual `process.env` → Task 5 (persist updates config on both paths) + Task 12 (`.env.example`/strip). ✓
- A11 lock-in tests → Tasks 1,2,3,5,6,7,9,12 each ship the named tests. ✓

**Placeholder scan:** No TBD/TODO; every code step has real code; doc tasks name exact files and counts.

**Type consistency:** `ProfileState`/`ProfileConfig` defined in Task 1 and used unchanged in 2/4/5/6/7/9. `getOrCreateClient(profile)` (Task 4) is the only constructor and is called by refresh (Task 5) and `list_accounts` (Task 7). `refreshIfNeeded(profile)`/`refreshTokensNow(profile)`/`inspectTokenHealth(profile)` (Task 5) take a `ProfileState` everywhere they're called (Tasks 6, 7, 8, 11). `withAccount`/`withoutAccount` (Task 6) are imported by Task 7. `runMigration` (Task 9) consumed by Task 10.

**Known cross-task build gaps (called out in-task):** removing zero-arg `ensureFreshToken`/`refreshTokensNow`/`inspectTokenHealth` in Tasks 4–5 leaves `index.ts`/`refresh-tokens.ts` non-compiling until Tasks 8/11; this is intentional and flagged in each affected task's Step 4.
