import { describe, it, expect } from "vitest";
import { discoverTokenFiles, decodeJwtExp } from "../src/freshbooks-client";

describe("discoverTokenFiles", () => {
  it("returns .env as the required canonical store plus two optional mirrors", () => {
    const files = discoverTokenFiles();
    expect(files).toHaveLength(3);

    const env = files.find((f) => f.path.endsWith(".env"));
    expect(env).toBeDefined();
    expect(env?.required).toBe(true);
    expect(env?.kind).toBe("env");

    // .mcp.json and the Claude Desktop config are optional mirrors — this is
    // what lets a fresh clone refresh cleanly on any OS.
    const optional = files.filter((f) => !f.required);
    expect(optional).toHaveLength(2);
    expect(optional.every((f) => f.kind === "json")).toBe(true);
  });
});

describe("decodeJwtExp", () => {
  it("extracts the numeric exp claim from a JWT", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString("base64url");
    expect(decodeJwtExp(`header.${payload}.signature`)).toBe(1893456000);
  });

  it("returns null for an opaque (non-JWT) token", () => {
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
    expect(decodeJwtExp("")).toBeNull();
  });

  it("returns null when the payload has no numeric exp", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "abc" })).toString("base64url");
    expect(decodeJwtExp(`header.${payload}.signature`)).toBeNull();
  });
});
