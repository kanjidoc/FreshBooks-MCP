import { describe, it, expect } from "vitest";
import { buildClaudeServerConfig, buildClaudeCodeServerJson } from "../src/mcp-config";

describe("buildClaudeServerConfig", () => {
  it("runs node against the project's compiled dist/index.js", () => {
    const cfg = buildClaudeServerConfig("/home/user/FreshBooks-MCP");
    expect(cfg.command).toBe("node");
    expect(cfg.args).toEqual(["/home/user/FreshBooks-MCP/dist/index.js"]);
  });

  it("carries no env block — the server reads .env itself", () => {
    expect(buildClaudeServerConfig("/p")).not.toHaveProperty("env");
  });
});

describe("buildClaudeCodeServerJson", () => {
  it("is the server config plus an explicit stdio type (for `claude mcp add-json`)", () => {
    const json = buildClaudeCodeServerJson("/opt/FreshBooks-MCP");
    expect(json.type).toBe("stdio");
    expect(json.command).toBe("node");
    expect(json.args).toEqual(["/opt/FreshBooks-MCP/dist/index.js"]);
  });

  it("carries no env block", () => {
    expect(buildClaudeCodeServerJson("/p")).not.toHaveProperty("env");
  });
});
