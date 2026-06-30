import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withAccount, withoutAccount } from "../src/tools/with-refresh";
import { currentProfile, resetRegistry } from "../src/profiles";
import { getAccountId } from "../src/freshbooks-client";

function jwt(): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({})}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`; // far-future -> refresh no-ops, no network
}
const cfg = (acc: string) =>
  `FRESHBOOKS_ACCESS_TOKEN=${jwt()}\nFRESHBOOKS_REFRESH_TOKEN=rt-${acc}\nFRESHBOOKS_ACCOUNT_ID=${acc}\nFRESHBOOKS_BUSINESS_ID=1\n`;

async function connect(server: any) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverT);
  const client = new McpClient({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

beforeAll(() => {
  process.env.FRESHBOOKS_CLIENT_ID = "cid";
  const root = mkdtempSync(join(tmpdir(), "fb-rt-"));
  const dir = join(root, "profiles");
  mkdirSync(dir);
  writeFileSync(join(dir, "acme.env"), cfg("ACC_A"));
  writeFileSync(join(dir, "beta.env"), cfg("ACC_B"));
  process.env.FRESHBOOKS_PROFILES_DIR = dir;
  process.env.FRESHBOOKS_BASE_ENV = join(root, ".env"); // never read the dev's real .env
  resetRegistry();
});

describe("real MCP round-trip (Amendment A11)", () => {
  // A withAccount-wrapped echo tool that reports the profile it actually resolved to.
  const echo = withAccount(
    tool("freshbooks_echo", "echo", { ping: z.string().optional() }, async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ profile: currentProfile().name, accountId: getAccountId() }),
        },
      ],
    })) as any,
  );
  const helpLike = withoutAccount(
    tool("freshbooks_help", "help", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    })) as any,
  );

  it("exposes `account` in the SERVED schema of an API tool, but not on account-free tools", async () => {
    const client = await connect(
      createSdkMcpServer({ name: "t", version: "0.0.0", tools: [echo, helpLike] }),
    );
    const { tools } = await client.listTools();
    const e = tools.find((t: any) => t.name === "freshbooks_echo")!;
    expect((e.inputSchema as any).properties.account.type).toBe("string");
    const h = tools.find((t: any) => t.name === "freshbooks_help")!;
    expect((h.inputSchema as any).properties?.account).toBeUndefined();
  });

  it("two concurrent callTool()s each resolve their OWN profile end-to-end", async () => {
    const client = await connect(
      createSdkMcpServer({ name: "t", version: "0.0.0", tools: [echo] }),
    );
    const [ra, rb] = await Promise.all([
      client.callTool({ name: "freshbooks_echo", arguments: { account: "acme" } }),
      client.callTool({ name: "freshbooks_echo", arguments: { account: "beta" } }),
    ]);
    expect(JSON.parse((ra.content as any)[0].text)).toEqual({
      profile: "acme",
      accountId: "ACC_A",
    });
    expect(JSON.parse((rb.content as any)[0].text)).toEqual({
      profile: "beta",
      accountId: "ACC_B",
    });
  });

  it("an unknown account returns isError through the SDK (never a rejected promise)", async () => {
    const client = await connect(
      createSdkMcpServer({ name: "t", version: "0.0.0", tools: [echo] }),
    );
    const bad = await client.callTool({ name: "freshbooks_echo", arguments: { account: "ghost" } });
    expect(bad.isError).toBe(true);
  });
});

describe("real server exposes account correctly", () => {
  it("freshbooks_list_invoices has `account`; help and list_accounts do not", async () => {
    const { freshbooksServer } = await import("../src/server");
    const client = await connect(freshbooksServer);
    const { tools } = await client.listTools();
    const inv = tools.find((t: any) => t.name === "freshbooks_list_invoices")!;
    expect((inv.inputSchema as any).properties.account.type).toBe("string");
    expect(
      (tools.find((t: any) => t.name === "freshbooks_help")!.inputSchema as any).properties
        ?.account,
    ).toBeUndefined();
    expect(
      (tools.find((t: any) => t.name === "freshbooks_list_accounts")!.inputSchema as any).properties
        ?.account,
    ).toBeUndefined();
  });
});
