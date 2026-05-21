import * as dotenv from "dotenv";
import { join } from "node:path";

/**
 * Options for loading the single `.env` token store. Exported so the contract
 * below can be asserted in tests (`test/load-env.test.ts`).
 *
 * - `path` — absolute, so the server's working directory is irrelevant.
 * - `override: true` — `.env` wins over any FRESHBOOKS_* vars a launcher may
 *   have injected into the process. `.env` is the single source of truth, kept
 *   fresh by the refresh logic in freshbooks-client.ts; a stale token frozen
 *   into a launcher config is therefore harmless.
 * - `quiet: true` — load-bearing, NOT cosmetic. dotenv v17 prints an
 *   "injected env (N)" banner to stdout via `console.log`, and this process
 *   speaks the MCP JSON-RPC protocol over stdout. A single stray byte there
 *   corrupts the protocol stream, so the banner must be silenced. Do not remove.
 */
export const dotenvOptions = {
  path: join(__dirname, "..", ".env"),
  override: true,
  quiet: true,
};

// FreshBooks tokens live in exactly one file — `.env`, next to this package.
// Loaded here, by absolute path, before anything else can read process.env.
dotenv.config(dotenvOptions);
