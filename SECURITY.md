# Security Policy

## Supported versions

Security fixes are provided for the 2.x release line.

## Reporting a vulnerability

Open an issue on [kanjidoc/FreshBooks-MCP](https://github.com/kanjidoc/FreshBooks-MCP/issues),
or contact the maintainer directly.

For sensitive reports, please do **not** include exploit details in a public issue —
open a minimal issue and request a private channel to share the details.

## Handling credentials

This server connects to a **live FreshBooks accounting account**. Treat its
credentials accordingly.

- `.env` holds your OAuth access and refresh tokens — the one file where
  credentials live. Those tokens grant full access to a real accounting account:
  its invoices, clients, payments, and financial reports.
- `.env` is listed in `.gitignore`. **Never commit or share it**, and never paste
  its contents into issues, pull requests, or logs. The MCP launcher configs
  (`.mcp.json`, the Claude Desktop / Claude Code configs) carry only the start
  command — no credentials.
- FreshBooks rotates the refresh token on every refresh. If you suspect a token has
  leaked, revoke the app's access in the FreshBooks Developer Portal and re-run
  `npm run setup` to obtain fresh credentials.
