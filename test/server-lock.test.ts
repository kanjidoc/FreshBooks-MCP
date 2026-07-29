import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
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

  it("REGRESSION: one server exiting must not unlock another live server", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock3-"));
    const p = lockPathFor(dir);
    // Another live server holds a lock. Pid 1 (launchd/init) is always alive
    // and not ours, so kill(1, 0) yields EPERM => treated as live.
    writeFileSync(`${p}.1`, JSON.stringify({ pid: 1, at: Date.now() }));
    writeLock(p); // our own per-pid lock
    expect(isServerLockFresh(p)).toBe(true);
    removeLock(p); // we exit — the OTHER server's lock must survive
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(isServerLockFresh(p)).toBe(true);
  });

  it("honors a legacy shared .server.lock held by a pre-fix live server", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock4-"));
    const p = lockPathFor(dir);
    writeFileSync(p, JSON.stringify({ pid: 1, at: Date.now() })); // legacy file, other live pid
    expect(isServerLockFresh(p)).toBe(true);
    removeLock(p); // not ours — must NOT be deleted
    expect(existsSync(p)).toBe(true);
    expect(isServerLockFresh(p)).toBe(true);
  });

  it("removeLock removes a legacy shared file only when it records our own pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock5-"));
    const p = lockPathFor(dir);
    writeFileSync(p, JSON.stringify({ pid: process.pid, at: Date.now() }));
    removeLock(p);
    expect(existsSync(p)).toBe(false);
  });

  it("writeLock sweeps dead-pid crash leftovers but never live ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock6-"));
    const p = lockPathFor(dir);
    writeFileSync(`${p}.999999`, JSON.stringify({ pid: 0x3fffffff, at: Date.now() })); // dead
    writeFileSync(`${p}.1`, JSON.stringify({ pid: 1, at: Date.now() })); // live (EPERM)
    writeLock(p);
    expect(existsSync(`${p}.999999`)).toBe(false);
    expect(existsSync(`${p}.1`)).toBe(true);
    removeLock(p);
  });
  it("the sweep FAILS CLOSED on a malformed sibling — possibly a live server's mid-write", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-lock7-"));
    const p = lockPathFor(dir);
    writeFileSync(`${p}.777`, '{"pid":'); // truncated JSON
    writeLock(p);
    expect(existsSync(`${p}.777`)).toBe(true); // kept, not swept
    removeLock(p);
  });
});
