import { writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * Per-pid lock files. A single shared `.server.lock` was last-writer-wins: N
 * servers overwrote one file, and the FIRST exiter deleted it — unlocking
 * migration for everyone while N-1 servers still held live tokens (the A2
 * CRITICAL race this lock exists to prevent). Each server therefore writes its
 * own `.server.lock.<pid>`, removes only its own on exit, and freshness scans
 * the whole family. The legacy shared `.server.lock` is still honored on read
 * (a server built before this fix may hold one) but is never written.
 */
export function lockPathFor(rootDir: string): string {
  return join(rootDir, ".server.lock");
}

function ownLockPath(basePath: string): string {
  return `${basePath}.${process.pid}`;
}

function readLockPid(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")).pid;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe (sends nothing)
    return true;
  } catch (err) {
    // EPERM => alive but not ours; ESRCH => dead
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The legacy shared file plus every per-pid sibling for this base path. */
function allLockFiles(basePath: string): string[] {
  const dir = dirname(basePath);
  const base = basename(basePath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n === base || n.startsWith(`${base}.`)).map((n) => join(dir, n));
}

export function writeLock(basePath: string): void {
  writeFileSync(ownLockPath(basePath), JSON.stringify({ pid: process.pid, at: Date.now() }));
  // Opportunistic sweep of crash leftovers: a sibling whose pid is dead can be
  // removed safely (pid reuse fails CLOSED — kill(pid, 0) on a reused pid says
  // "alive", so the file is kept and migration keeps refusing).
  for (const f of allLockFiles(basePath)) {
    if (f === ownLockPath(basePath)) continue;
    if (!pidIsAlive(readLockPid(f))) {
      try {
        rmSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}

export function removeLock(basePath: string): void {
  try {
    const own = ownLockPath(basePath);
    if (existsSync(own)) rmSync(own);
    // The legacy shared file is removed ONLY when it records our own pid —
    // deleting another live server's lock is the exact defect this fixes.
    if (existsSync(basePath) && readLockPid(basePath) === process.pid) rmSync(basePath);
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
 * `confirmNoServer` override on `runMigration`), which is the correct bias for a
 * token-safety lock. True if ANY lock file in the family holds a live pid.
 */
export function isServerLockFresh(basePath: string): boolean {
  return allLockFiles(basePath).some((f) => pidIsAlive(readLockPid(f)));
}
