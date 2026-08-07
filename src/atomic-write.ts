import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  copyFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Atomic write: backup to `${path}.bak`, stage in `${path}.tmp`, rename into place.
 *
 * The `.bak`/`.tmp` names are derived from `path` (never shared constants), so two
 * different target paths can be written concurrently without colliding.
 *
 * Crash-durability (U12): `writeAtomic` is crash-atomic via `rename`, but not
 * crash-durable — on power loss the rename metadata can land before the file data,
 * leaving a zero-length/garbage token file and locking out a login. To close that
 * window we `fsync` the tmp file before renaming, and `fsync` the containing
 * directory after. The tmp-file fsync is the load-bearing one; the directory fsync
 * is best-effort (some platforms reject directory fds) and its failure is ignored.
 *
 * Permissions (Security §Permissions): the staged file is created 0600 and the
 * `rename` carries that mode onto the target, so a token file is never briefly
 * world-readable — `writeFileSync`'s `mode` applies at CREATION only, which is
 * exactly why a chmod-after would leave a window. `copyFileSync` gives the
 * `.bak` the SOURCE file's mode, so an already-loose file would hand its
 * looseness to the backup; the explicit `chmodSync` closes that, best-effort
 * (Windows has no meaningful mode bits, and a failure here must not fail a
 * write whose real job already succeeded — `--doctor` reports loose modes).
 */
export function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
    try {
      chmodSync(`${path}.bak`, 0o600);
    } catch {
      // Best-effort: the backup exists, which is the point; its mode is a
      // hardening bonus the doctor's permission check reports on if it fails.
    }
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    // `mode` applied at creation only, so a stale tmp left by an earlier crash
    // would keep ITS old mode and hand it to the target through the rename.
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort, as above: never fail a token write over its mode bits.
  }

  // Flush the staged data to disk before swapping it into place.
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmp, path);

  // Flush the directory entry so the rename itself survives a crash. Best-effort:
  // some platforms reject fsync on a directory fd — ignore that failure.
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync unsupported on this platform; the tmp-file fsync above is
    // the load-bearing durability guarantee.
  }
}

export function readTokenMarkers(path: string): { access?: string; refresh?: string } {
  const content = readFileSync(path, "utf8");
  return {
    access: content.match(/^FRESHBOOKS_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim(),
    refresh: content.match(/^FRESHBOOKS_REFRESH_TOKEN=(.*)$/m)?.[1]?.trim(),
  };
}
