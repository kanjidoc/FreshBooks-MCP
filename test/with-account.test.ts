import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRegistry } from "../src/profiles";
import { withAccount, withoutAccount } from "../src/tools/with-refresh";

// A far-future JWT so refreshIfNeeded() is a pure no-op (no network) — the
// wrapper must resolve + run without ever touching FreshBooks here.
function jwt(): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({})}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
}

// `a` seeds a distinct refresh token; `acc` is the accountId; `extra` prepends
// marker/comment lines (e.g. the distinct-login opt-in).
const cfg = (a: string, acc: string, extra = "") =>
  `${extra}FRESHBOOKS_ACCESS_TOKEN=${jwt()}\n` +
  `FRESHBOOKS_REFRESH_TOKEN=rt-${a}\n` +
  `FRESHBOOKS_ACCOUNT_ID=${acc}\n` +
  `FRESHBOOKS_BUSINESS_ID=1\n`;

const created: string[] = [];

// Point the registry at a fresh temp dir via the REAL discovery path (env
// overrides + resetRegistry) — no vi.spyOn. The base .env path is set to a
// file that does not exist so the legacy fallback can't read the dev's real .env.
function useProfiles(files: Record<string, string>): void {
  const root = mkdtempSync(join(tmpdir(), "fb-wa-"));
  created.push(root);
  const dir = join(root, "profiles");
  mkdirSync(dir);
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body);
  process.env.FRESHBOOKS_PROFILES_DIR = dir;
  process.env.FRESHBOOKS_BASE_ENV = join(root, ".env"); // absent -> zero profiles when empty
  resetRegistry();
}

// A fake tool def matching the SDK shape (name/description/inputSchema/handler).
const makeTool = (): any => ({
  name: "freshbooks_demo",
  description: "demo",
  inputSchema: {},
  handler: async (args: any) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
});

// A tool that records whether its handler ran, to prove refusal paths never run it.
function makeTrackingTool(): { tool: any; state: { ran: boolean } } {
  const state = { ran: false };
  const tool = {
    name: "freshbooks_demo",
    description: "demo",
    inputSchema: {},
    handler: async () => {
      state.ran = true;
      return { content: [{ type: "text", text: "ran" }] };
    },
  };
  return { tool, state };
}

beforeEach(() => {
  process.env.FRESHBOOKS_CLIENT_ID = "cid";
});

afterEach(() => {
  // Tear down env overrides + memoized registry so blocks never leak into one
  // another (and never read the developer's real .env).
  delete process.env.FRESHBOOKS_PROFILES_DIR;
  delete process.env.FRESHBOOKS_BASE_ENV;
  resetRegistry();
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("withAccount", () => {
  it("injects an `account` field into inputSchema", () => {
    useProfiles({ "acme.env": cfg("a", "A") });
    expect(Object.keys(withAccount(makeTool()).inputSchema)).toContain("account");
  });

  it("returns isError (never throws) when account omitted and >=2 profiles", async () => {
    useProfiles({ "acme.env": cfg("a", "A"), "beta.env": cfg("b", "B") });
    const res = await withAccount(makeTool()).handler({ page: 1 }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/acme|beta|multiple/);
  });

  it("uses the lone profile as default when account omitted and exactly one exists", async () => {
    useProfiles({ "acme.env": cfg("a", "A") });
    const res = await withAccount(makeTool()).handler({ page: 1 }, {});
    expect(res.isError).toBeUndefined();
  });

  it("resolves the named profile and strips `account` before the handler", async () => {
    useProfiles({ "acme.env": cfg("a", "A") });
    const res = await withAccount(makeTool()).handler({ page: 7, account: "acme" }, {});
    expect(JSON.parse(res.content[0].text)).toEqual({ page: 7 }); // account stripped
  });

  it("zero profiles -> isError, never a throw (never-throw contract)", async () => {
    useProfiles({}); // empty dir + non-existent base .env -> zero profiles
    const res = await withAccount(makeTool()).handler({ account: "ghost" }, {});
    expect(res.isError).toBe(true);
  });

  it("unknown account name -> isError listing the configured names, never a throw", async () => {
    useProfiles({ "acme.env": cfg("a", "A") });
    const res = await withAccount(makeTool()).handler({ account: "ghost" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("acme");
  });

  // R2: a quarantined profile (same accountId, different token, no opt-in marker)
  // must be REFUSED on explicit use — never run, never refreshed.
  it("refuses a quarantined profile with isError mentioning the opt-in marker, without running the handler", async () => {
    useProfiles({
      "acme.env": cfg("a", "SAME"),
      "copy.env": cfg("b", "SAME"), // distinct refresh token, same accountId -> copy quarantined
    });
    const { tool, state } = makeTrackingTool();
    const res = await withAccount(tool).handler({ account: "copy" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("# freshbooks-distinct-login");
    expect(res.content[0].text).toContain("copy");
    expect(state.ran).toBe(false); // handler must NOT have run
  });
});

describe("withoutAccount", () => {
  it("is an identity passthrough: schema unchanged, handler runs without a profile", async () => {
    const t = makeTool();
    const wrapped = withoutAccount(t);
    expect(wrapped).toBe(t);
    expect(Object.keys(wrapped.inputSchema)).not.toContain("account");
    const res = await wrapped.handler({ topic: "overview" }, {});
    expect(res.isError).toBeUndefined();
  });
});
