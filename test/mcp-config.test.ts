import { describe, it, expect } from "vitest";
import { buildClaudeServerConfig, buildClaudeCodeServerJson } from "../src/mcp-config";

describe("buildClaudeServerConfig", () => {
  it("runs node against the project's compiled dist/index.js with the given env", () => {
    const cfg = buildClaudeServerConfig(
      { FRESHBOOKS_CLIENT_ID: "abc" },
      "/home/user/FreshBooks-MCP",
    );
    expect(cfg.command).toBe("node");
    expect(cfg.args).toEqual(["/home/user/FreshBooks-MCP/dist/index.js"]);
    expect(cfg.env).toEqual({ FRESHBOOKS_CLIENT_ID: "abc" });
  });
});

describe("buildClaudeCodeServerJson", () => {
  it("is the server config plus an explicit stdio type (for `claude mcp add-json`)", () => {
    const json = buildClaudeCodeServerJson(
      { FRESHBOOKS_ACCOUNT_ID: "xyz" },
      "/opt/FreshBooks-MCP",
    );
    expect(json.type).toBe("stdio");
    expect(json.command).toBe("node");
    expect(json.args).toEqual(["/opt/FreshBooks-MCP/dist/index.js"]);
    expect(json.env).toEqual({ FRESHBOOKS_ACCOUNT_ID: "xyz" });
  });
});
