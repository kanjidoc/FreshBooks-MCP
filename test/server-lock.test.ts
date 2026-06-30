import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPathFor, writeLock, removeLock, isServerLockFresh } from "../src/server-lock";

describe("server lock (pid-liveness, not age)", () => {
  it("absent -> not fresh; live-pid lock -> fresh; removed -> not fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock-"));
    const p = lockPathFor(dir);
    expect(isServerLockFresh(p)).toBe(false);
    writeLock(p); // records THIS test process's pid, which is alive
    expect(isServerLockFresh(p)).toBe(true);
    removeLock(p);
    expect(isServerLockFresh(p)).toBe(false);
  });
  it("a dead/never-used pid is treated as stale (the bug the overseer caught)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock2-"));
    const p = lockPathFor(dir);
    writeFileSync(p, JSON.stringify({ pid: 0x3fffffff, at: Date.now() })); // not a live pid
    expect(isServerLockFresh(p)).toBe(false);
  });
});
