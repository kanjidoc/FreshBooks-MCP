import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { allTools } from "../src/tool-registry";
import { RAW_TIER_DESC } from "../src/raw-call";

type RegisteredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};

const tools = allTools as unknown as RegisteredTool[];
const byName = new Map(tools.map((t) => [t.name, t]));

/** Tools that are account-free by design — no injected `account` param. */
const ACCOUNT_FREE = new Set(["freshbooks_help", "freshbooks_list_accounts"]);

/**
 * The annotation convention (documented in CLAUDE.md "Tool annotations" and the
 * freshbooks_help conventions topic — a guard codifying an undocumented rule
 * would leave the docs contradicting the test):
 *   list_/get_/report_ → readOnlyHint
 *   delete_            → destructiveHint
 *   update_            → idempotentHint
 *   create_            → NO annotations (neither read-only, idempotent, nor
 *                        destructive of existing data)
 * Tools matching no action prefix must appear in this explicit allow-list.
 */
const PREFIX_FREE_ALLOW_LIST: Record<string, RegisteredTool["annotations"]> = {
  freshbooks_help: { readOnlyHint: true },
};

describe("tool inventory sweeps", () => {
  it("names are unique", () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("every name matches freshbooks_<action>_<resource>", () => {
    for (const t of tools) {
      expect(t.name, t.name).toMatch(/^freshbooks_[a-z][a-z_]*$/);
    }
  });

  it("every description is non-empty", () => {
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
    }
  });

  it("annotations follow the action-prefix convention", () => {
    for (const t of tools) {
      const action = t.name.replace(/^freshbooks_/, "").split("_")[0];
      const a = t.annotations;
      const label = `${t.name} annotations=${JSON.stringify(a)}`;
      switch (action) {
        case "list":
        case "get":
        case "report":
          expect(a?.readOnlyHint, label).toBe(true);
          expect(a?.destructiveHint, label).toBeUndefined();
          expect(a?.idempotentHint, label).toBeUndefined();
          break;
        case "delete":
          expect(a?.destructiveHint, label).toBe(true);
          expect(a?.readOnlyHint, label).toBeUndefined();
          break;
        case "update":
          expect(a?.idempotentHint, label).toBe(true);
          expect(a?.readOnlyHint, label).toBeUndefined();
          break;
        case "create":
          expect(a, label).toBeUndefined();
          break;
        default:
          expect(
            t.name in PREFIX_FREE_ALLOW_LIST,
            `${t.name} matches no action prefix and is not in the allow-list`,
          ).toBe(true);
          expect(a, label).toEqual(PREFIX_FREE_ALLOW_LIST[t.name]);
      }
    }
  });

  it("every input schema is a raw shape, never a ZodObject (the silent zero-param trap)", () => {
    // withAccount SPREADS inputSchema. Spreading a z.object() yields
    // {"type":"object","properties":{}} — a zero-parameter tool, silently.
    for (const t of tools) {
      expect(t.inputSchema instanceof z.ZodType, `${t.name} inputSchema must be a plain shape`).toBe(false);
      expect(typeof t.inputSchema, t.name).toBe("object");
    }
  });

  it("exactly the account-free tools lack the injected account param", () => {
    for (const t of tools) {
      const hasAccount = "account" in t.inputSchema;
      expect(hasAccount, `${t.name} account param`).toBe(!ACCOUNT_FREE.has(t.name));
    }
  });

  it("no schema uses a JSON-Schema-unrepresentable zod type (kills listTools for the whole server)", () => {
    const banned = [
      z.ZodDate,
      z.ZodBigInt,
      z.ZodSymbol,
      z.ZodUndefined,
      z.ZodVoid,
      z.ZodNaN,
      z.ZodMap,
      z.ZodSet,
      z.ZodFunction,
    ];
    const check = (schema: unknown, path: string) => {
      if (!(schema instanceof z.ZodType)) return;
      for (const B of banned) {
        expect(schema instanceof B, `${path} uses ${B.name}`).toBe(false);
      }
      const def = (schema as z.ZodType)._def as Record<string, unknown>;
      for (const key of ["innerType", "schema", "type"]) {
        if (def[key] instanceof z.ZodType) check(def[key], `${path}.<${key}>`);
      }
      if (def.typeName === "ZodObject") {
        const shape = (def.shape as () => Record<string, unknown>)();
        for (const [k, v] of Object.entries(shape)) check(v, `${path}.${k}`);
      }
    };
    for (const t of tools) {
      for (const [k, v] of Object.entries(t.inputSchema)) check(v, `${t.name}.${k}`);
    }
  });

  it("every tool defined under src/tools/raw/ carries the raw-tier marker", () => {
    const rawDir = join(__dirname, "..", "src", "tools", "raw");
    if (!existsSync(rawDir)) return; // Phase 2+ populates it
    const rawNames = readdirSync(rawDir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => readFileSync(join(rawDir, f), "utf8").match(/"freshbooks_[a-z_]+"/g) ?? [])
      .map((s) => s.slice(1, -1));
    expect(rawNames.length).toBeGreaterThan(0); // a raw/ dir with no tools is a mistake
    for (const name of new Set(rawNames)) {
      const t = byName.get(name);
      expect(t, `${name} found in src/tools/raw/ but not registered`).toBeDefined();
      expect(t!.description, `${name} must carry RAW_TIER_DESC`).toContain(RAW_TIER_DESC);
    }
    // And the marker never leaks onto SDK-backed tools.
    for (const t of tools) {
      if (!rawNames.includes(t.name)) {
        expect(t.description, `${t.name} is not raw but carries the marker`).not.toContain(RAW_TIER_DESC);
      }
    }
  });
});
