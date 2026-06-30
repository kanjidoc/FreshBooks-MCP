import { describe, it, expect } from "vitest";
import { parseArgs } from "../scripts/refresh-tokens";

describe("refresh-tokens parseArgs", () => {
  it("defaults: no flags", () => {
    expect(parseArgs([])).toEqual({
      checkOnly: false,
      json: false,
      bufferMinutes: 10,
      only: undefined,
    });
  });

  it("parses --check-only and --json", () => {
    const args = parseArgs(["--check-only", "--json"]);
    expect(args.checkOnly).toBe(true);
    expect(args.json).toBe(true);
  });

  it("parses --profile <name> into `only`", () => {
    expect(parseArgs(["--profile", "work"]).only).toBe("work");
  });

  it("trims the --profile value", () => {
    expect(parseArgs(["--profile", "  work  "]).only).toBe("work");
  });

  it("parses --buffer-minutes", () => {
    expect(parseArgs(["--buffer-minutes", "30"]).bufferMinutes).toBe(30);
  });

  it("combines flags in any order", () => {
    const args = parseArgs(["--profile", "Home", "--check-only", "--buffer-minutes", "5"]);
    expect(args).toEqual({
      checkOnly: true,
      json: false,
      bufferMinutes: 5,
      only: "Home",
    });
  });
});
