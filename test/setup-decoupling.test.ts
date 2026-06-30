import { describe, it, expect } from "vitest";
import { buildBaseEnvVars, serializeEnv } from "../scripts/setup";
import { MIGRATED_MARKER } from "../src/migrate";

// (U11) The wizard must leave base `.env` holding ONLY the shared app creds —
// every per-login token/ID belongs exclusively in profiles/<name>.env. These
// are the four markers that must NEVER appear in a setup-produced base `.env`.
const TOKEN_ID_MARKERS = [
  "FRESHBOOKS_ACCESS_TOKEN",
  "FRESHBOOKS_REFRESH_TOKEN",
  "FRESHBOOKS_ACCOUNT_ID",
  "FRESHBOOKS_BUSINESS_ID",
];

describe("setup wizard base .env decoupling (U11)", () => {
  it("buildBaseEnvVars carries only app creds — no token/ID keys", () => {
    const vars = buildBaseEnvVars("cid", "sec", "https://localhost/callback", false);
    expect(vars).toEqual({
      FRESHBOOKS_CLIENT_ID: "cid",
      FRESHBOOKS_CLIENT_SECRET: "sec",
      FRESHBOOKS_REDIRECT_URI: "https://localhost/callback",
    });
    for (const m of TOKEN_ID_MARKERS) expect(vars).not.toHaveProperty(m);
  });

  it("serialized fresh-install base .env has the app creds and NO token/ID markers", () => {
    const content = serializeEnv(buildBaseEnvVars("cid", "sec", "u", false));
    expect(content).toMatch(/^FRESHBOOKS_CLIENT_ID=cid$/m);
    expect(content).toMatch(/^FRESHBOOKS_CLIENT_SECRET=sec$/m);
    expect(content).toMatch(/^FRESHBOOKS_REDIRECT_URI=u$/m);
    // fresh install: no migration marker, no tokens
    expect(content).not.toMatch(new RegExp(`^${MIGRATED_MARKER}=`, "m"));
    for (const m of TOKEN_ID_MARKERS) {
      expect(content).not.toMatch(new RegExp(`^${m}=`, "m"));
    }
  });

  it("after a migration the marker is present but tokens/IDs still are not", () => {
    const content = serializeEnv(buildBaseEnvVars("cid", "sec", "u", true));
    expect(content).toMatch(new RegExp(`^${MIGRATED_MARKER}=1$`, "m"));
    for (const m of TOKEN_ID_MARKERS) {
      expect(content).not.toMatch(new RegExp(`^${m}=`, "m"));
    }
  });
});
