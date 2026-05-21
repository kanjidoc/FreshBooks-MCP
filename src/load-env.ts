import * as dotenv from "dotenv";
import { join } from "node:path";

// FreshBooks tokens live in exactly one file — `.env`, next to this package.
// Load it by absolute path so the server's working directory is irrelevant,
// and let it win (`override: true`) over any FRESHBOOKS_* vars a launcher may
// have injected into the process. `.env` is the single source of truth, kept
// fresh by the refresh logic in freshbooks-client.ts; anything a launcher
// config froze in is therefore harmless.
dotenv.config({ path: join(__dirname, "..", ".env"), override: true });
