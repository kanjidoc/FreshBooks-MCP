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
  it("ignores the advisory server lock — the WHOLE per-pid family", () => {
    expect(ignored(".server.lock")).toBe(true);
    // Per-pid lock files (.server.lock.<pid>): one WAS committed when the
    // naming scheme changed without widening the ignore rule. A committed
    // lock whose pid happens to be alive on a clone makes migration refuse
    // with an inexplicable "server is running".
    expect(ignored(".server.lock.12345")).toBe(true);
  });
  it("REGRESSION: no lock file is tracked by git", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url) })
      .toString()
      .split("\n")
      .filter((f) => /(^|\/)\.server\.lock/.test(f));
    expect(tracked).toEqual([]);
  });
});
