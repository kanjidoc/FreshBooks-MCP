import { writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function lockPathFor(rootDir: string): string {
  return join(rootDir, ".server.lock");
}
export function writeLock(path: string): void {
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }));
}
export function removeLock(path: string): void {
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    /* best effort */
  }
}

/**
 * A lock means "a server is alive" — judged by PID LIVENESS ONLY (R1). There is
 * NO file-age bound and NO heartbeat: a long-running or laptop-suspended server
 * must never be judged "stale" while its PID is alive, or migration could run
 * concurrently with it and burn a token (the A2 CRITICAL race). A reused PID
 * after an uncleaned crash fails CLOSED (migration refuses; recover via the
 * hardened `--force` path), which is the correct bias for a token-safety lock.
 */
export function isServerLockFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(path, "utf8")).pid;
  } catch {
    return false;
  }
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe (sends nothing)
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // EPERM => alive but not ours; ESRCH => dead
  }
}
