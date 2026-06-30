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
  it("ignores the advisory server lock", () => {
    expect(ignored(".server.lock")).toBe(true);
  });
});
