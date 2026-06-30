import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, readTokenMarkers } from "../src/atomic-write";

describe("writeAtomic", () => {
  it("replaces content and leaves a .bak of the prior file, no .tmp residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-aw-"));
    const f = join(dir, "x.env");
    writeFileSync(f, "old");
    writeAtomic(f, "new");
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(readFileSync(`${f}.bak`, "utf8")).toBe("old");
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });
  it("derives tmp/bak names from the target path (two paths never collide)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-aw2-"));
    const a = join(dir, "a.env");
    const b = join(dir, "b.env");
    writeFileSync(a, "a0");
    writeFileSync(b, "b0");
    writeAtomic(a, "a1");
    writeAtomic(b, "b1");
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(b, "utf8")).toBe("b1");
  });
});

describe("readTokenMarkers", () => {
  it("reads access/refresh lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    const f = join(dir, "x.env");
    writeFileSync(f, "FRESHBOOKS_ACCESS_TOKEN=aa\nFRESHBOOKS_REFRESH_TOKEN=rr\n");
    expect(readTokenMarkers(f)).toEqual({ access: "aa", refresh: "rr" });
  });
});
