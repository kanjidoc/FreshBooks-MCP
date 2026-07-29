import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@freshbooks/api";

/**
 * The raw-endpoint layer (src/raw-call.ts) rides on SDK internals verified at
 * @freshbooks/api@4.1.0 (pinned exact). These tests pin the contract so a
 * dependency swap fails HERE, with a named reason, instead of as a runtime
 * mystery. asRawCallable() is the runtime half of the same enforcement.
 */
describe("SDK contract pins", () => {
  it("Client.prototype has its own call(), arity 5", () => {
    expect(Object.prototype.hasOwnProperty.call(Client.prototype, "call")).toBe(true);
    expect((Client.prototype as unknown as { call: (...a: unknown[]) => unknown }).call.length).toBe(5);
  });
  it("@freshbooks/api is pinned to exact 4.1.0 in both manifests", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(__dirname, "..", "package-lock.json"), "utf8"));
    expect(pkg.dependencies["@freshbooks/api"]).toBe("4.1.0");
    expect(lock.packages[""].dependencies["@freshbooks/api"]).toBe("4.1.0");
  });
});

/** Every src/**\/*.ts file, recursively. */
function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Strip block and line comments so prose about the rules can't trip the guard.
 * Naive (does not parse strings) — fine for a grep-grade architectural check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("architectural grep guards", () => {
  const files = srcFiles(join(__dirname, "..", "src"));
  const hits = (re: RegExp) =>
    files.flatMap((f) => {
      const matches = stripComments(readFileSync(f, "utf8")).match(re);
      return matches ? matches.map(() => f) : [];
    });

  it("a FreshBooks Client is constructed in EXACTLY one place (A1)", () => {
    // Token state must live on one object per profile; a second construction
    // site would fork it. getOrCreateClient(profile) is the one.
    expect(hits(/new Client\(/g)).toEqual([join(__dirname, "..", "src", "freshbooks-client.ts")]);
  });

  it("client.axios is touched in EXACTLY one place (the timeout install)", () => {
    // call() re-syncs the Authorization header from client.accessToken per
    // request; anything using client.axios directly would send the token baked
    // in at construction — i.e. a stale one after a refresh.
    expect(hits(/\.axios\b/g)).toEqual([join(__dirname, "..", "src", "freshbooks-client.ts")]);
  });
});
