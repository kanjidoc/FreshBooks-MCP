import {
  readFileSync,
  writeFileSync,
  existsSync,
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
 */
export function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);

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
