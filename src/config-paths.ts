import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Absolute path to the Claude Desktop MCP config file for the current OS.
 *
 * This file is OPTIONAL — a user may run only Claude Code, or have a fresh clone
 * where it does not exist yet. Callers must treat a missing file as normal.
 *
 * Path conventions:
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   Linux:   ~/.config/Claude/claude_desktop_config.json
 */
export function resolveDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}
