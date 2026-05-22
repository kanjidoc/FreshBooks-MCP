import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getVersion } from "../src/version";
import { renderOverviewTopic, renderVersionTopic } from "../src/docs/content";
import { allTools } from "../src/tool-registry";

describe("version", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  it("getVersion() returns the version from package.json", () => {
    expect(getVersion()).toBe(pkg.version);
  });

  it("the version topic shows the installed version and tool count", () => {
    const text = renderVersionTopic();
    expect(text).toContain(pkg.version);
    expect(text).toContain(String(allTools.length));
  });

  it("the overview topic shows the installed version and tool count", () => {
    const text = renderOverviewTopic();
    expect(text).toContain(pkg.version);
    expect(text).toContain(String(allTools.length));
  });
});
