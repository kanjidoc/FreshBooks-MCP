# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-05-21

### Fixed

- Repaired 13 broken tools surfaced by a full audit (see `TOOL_AUDIT.md`). The four
  root causes were: an SDK method-signature mismatch (`create_item`), wrong property
  names handed to SDK models (credit notes, bill payments, bill vendors, journal
  entries), updates that didn't survive the SDK's request transform (`update_time_entry`,
  `update_other_income`, `update_project`), and reports using the wrong query mechanism.
- The three report tools (`report_payments_collected`, `report_profit_loss`,
  `report_tax_summary`) now honor the date range passed to them — previously they
  silently returned data for the current day only, with no error.
- `create_journal_entry` now builds the single `details[]` array the SDK expects and
  validates that credits and debits balance before calling the API.

### Changed

- Removed unsafe `as any` casts from create/update handlers. Payloads are now typed
  against the SDK model interfaces, so a wrong property name is a compile error
  instead of a silently dropped field.

### Added

- Bundled standalone-safe OAuth token refresh into the repo, replacing the external
  Python skill: adaptive token-file resolution so it works on any OS, a single-flight
  guard to prevent concurrent refreshes, proactive refresh before token expiry, and a
  `npm run refresh-tokens` CLI.
- `freshbooks_help`, a self-documenting MCP tool that describes the server, its tools,
  and how to extend it — bringing the total to 75 tools.

## [1.0.0]

Initial release: an MCP server exposing 74 FreshBooks accounting tools (invoices,
clients, expenses, payments, bills, projects, time entries, reports, and more) to
AI assistants, built on the official FreshBooks Node.js SDK and the Claude Agent SDK.
