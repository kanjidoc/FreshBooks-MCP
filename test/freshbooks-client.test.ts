import { describe, it, expect } from "vitest";
import { decodeJwtExp, applyTokensToEnv } from "../src/freshbooks-client";

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

describe("applyTokensToEnv", () => {
  it("replaces the access and refresh token lines, leaving other lines untouched", () => {
    const before = [
      "FRESHBOOKS_CLIENT_ID=abc",
      "FRESHBOOKS_ACCESS_TOKEN=old_access",
      "FRESHBOOKS_REFRESH_TOKEN=old_refresh",
      "FRESHBOOKS_ACCOUNT_ID=xyz",
    ].join("\n");
    const after = applyTokensToEnv(before, "new_access", "new_refresh");
    expect(after).toContain("FRESHBOOKS_ACCESS_TOKEN=new_access");
    expect(after).toContain("FRESHBOOKS_REFRESH_TOKEN=new_refresh");
    expect(after).toContain("FRESHBOOKS_CLIENT_ID=abc");
    expect(after).toContain("FRESHBOOKS_ACCOUNT_ID=xyz");
    expect(after).not.toContain("old_access");
    expect(after).not.toContain("old_refresh");
  });

  it("throws when a token line is absent, so a failed write is caught not silent", () => {
    expect(() => applyTokensToEnv("FRESHBOOKS_CLIENT_ID=abc", "a", "r")).toThrow();
  });
});
