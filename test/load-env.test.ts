import { describe, it, expect, vi } from "vitest";
import * as dotenv from "dotenv";
import { dotenvOptions } from "../src/load-env";

/**
 * `src/load-env.ts` runs `dotenv.config()` inside the MCP server process —
 * which speaks the MCP JSON-RPC protocol over **stdout**. Any stray write to
 * stdout corrupts that stream. dotenv v17 prints an "injected env (N)" banner
 * via `console.log` on a successful load unless `quiet: true` is passed, so the
 * loader's options must keep that flag set.
 */
describe("load-env", () => {
  it("suppresses dotenv's stdout banner — stdout carries only MCP JSON-RPC", () => {
    // Deterministic guard — holds even with no `.env` present (e.g. on CI).
    expect(dotenvOptions.quiet).toBe(true);

    // Behavioural proof: re-running config() with the real options object
    // prints nothing. (dotenv only logs on a successful load, so this half is
    // only exercised on a machine that actually has a `.env` file.)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      dotenv.config(dotenvOptions);
    } finally {
      logSpy.mockRestore();
    }
    expect(logSpy).not.toHaveBeenCalled();
  });
});
