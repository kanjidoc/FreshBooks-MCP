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

- `.env` and `.mcp.json` hold OAuth access and refresh tokens. Those tokens grant
  full access to a real accounting account — its invoices, clients, payments, and
  financial reports.
- Both files are listed in `.gitignore`. **Never commit or share them**, and never
  paste their contents into issues, pull requests, or logs.
- FreshBooks rotates the refresh token on every refresh. If you suspect a token has
  leaked, revoke the app's access in the FreshBooks Developer Portal and re-run
  `npm run setup` to obtain fresh credentials.
