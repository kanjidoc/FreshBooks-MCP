# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-05-21

### Fixed

- `update_time_entry` no longer drops a time entry's associations. The FreshBooks
  timetracking `PUT` is a full replace, and the SDK's `transformTimeEntryRequest`
  serializes every field unconditionally — so a partial update reset
  `client_id` / `project_id` / `task_id` / `service_id` to `null`, silently
  losing the entry's links. (The 2.0.0 fix had rescued only `started_at`.) The
  handler now fetches the existing entry and sends it back complete, overriding
  only the caller's changes.
- `create_bill` line items now reach the API. The SDK's
  `transformBillLinesParsedRequest` reads only `unitCost` and `categoryId` per
  line, so the previous `amount` / `category` line fields were silently dropped —
  leaving every line with no value and no category. The `lines` schema now takes
  `unit_cost` (a Money object) and `category_id` (verified against the SDK
  source; not live-testable without the Accounts-Payable add-on).
- `create_other_income` and `update_other_income` now constrain `category_name`
  to the five values the FreshBooks API accepts — `advertising`,
  `in_person_sales`, `online_sales`, `rentals`, `other` — as a `z.enum`. The old
  free-text schema even gave `Other Income` as its example, a value the API
  rejects.

### Changed

- `create_service` no longer exposes a `billable` parameter. The SDK's
  `transformServiceRequest` serializes only the service name, so a `billable`
  flag passed on creation was silently ignored; services are always created
  billable. The tool description and `freshbooks_help` now state this.
- `delete_other_income` returns a human-readable confirmation
  (`Other income <id> deleted.`) instead of an empty `{}` body.

## [2.0.0] - 2026-05-21

### Fixed

- Repaired 11 of the 13 broken tools surfaced by a full audit (see `TOOL_AUDIT.md`). The four
  root causes were: an SDK method-signature mismatch (`create_item`), wrong property
  names handed to SDK models (credit notes, bill payments, bill vendors, journal
  entries), updates that didn't survive the SDK's request transform (`update_time_entry`,
  `update_other_income`, `update_project`), and reports using the wrong query mechanism.
- The three report tools (`report_payments_collected`, `report_profit_loss`,
  `report_tax_summary`) now honor the date range passed to them — previously they
  silently returned data for the current day only, with no error.
- `create_journal_entry` was reworked to build the single `details[]` array the SDK
  expects and to validate that credits and debits balance before the API call (the tool
  still cannot complete a create — see Known limitations).

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

### Known limitations

- **`create_credit_note` and `create_journal_entry` are non-functional**, blocked by bugs
  in `@freshbooks/api@4.1.0` — the latest SDK release. The SDK's request transforms for
  these two resources serialize the body incorrectly (a wrong wrapper key for credit
  notes; missing API-required fields for journal entries), and no newer SDK version is
  available. The tool-side code is correct — the defect is upstream. The list/get tools
  for credit notes and journal entries work normally. To be revisited when `@freshbooks/api`
  ships a fix; full diagnosis in `TOOL_AUDIT.md`.
- The **`bills` / `bill_payments` / `bill_vendors`** write tools require the FreshBooks
  Accounts-Payable add-on on your account; without it the API returns an access error.

## [1.0.0]

Initial release: an MCP server exposing 74 FreshBooks accounting tools (invoices,
clients, expenses, payments, bills, projects, time entries, reports, and more) to
AI assistants, built on the official FreshBooks Node.js SDK and the Claude Agent SDK.
