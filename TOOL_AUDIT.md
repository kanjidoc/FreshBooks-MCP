# FreshBooks MCP — Tool Audit & Remediation Guide

**Audit date:** 2026-05-21
**Audited build:** commit `37f2748` (running `dist/index.js`, verified live)
**Account used:** a private FreshBooks test account (account/business identifiers redacted for the public repo)
**Scope:** all 74 MCP tools — behavioral (live API calls) + static (source vs. `@freshbooks/api@4.1.0` SDK)
**Method:** `/systematic-debugging` — every bug below was reproduced and root-caused before a fix was written. No symptom patches.

---

## 1. How to read this document

This is a **fix guide for a future Claude Code session**. It is self-contained: a fresh
session can execute Section 9 top-to-bottom without re-investigating.

- **Section 4** — pass/fail status of every tool.
- **Section 5** — the 13 broken tools, grouped by the **4 shared root causes**. Each has the
  symptom (with the real error string observed), the root cause, and the exact fix.
- **Section 6** — the *systemic* reason these bugs existed and shipped: the `as any` casts.
  Fixing this prevents the whole bug class from recurring.
- **Section 9** — an ordered remediation plan.
- **Section 10** — how to verify each fix.

**Severity key:** 🔴 Critical (tool non-functional or silently wrong) · 🟠 High (tool partly
works but silently drops valid input) · 🟡 Medium (completeness) · ⚪ Low (cosmetic / meta).

---

## 2. Executive summary

**13 of 74 tools are broken.** The other 61 work correctly and have solid error handling.

| # | Tool(s) | Severity | One-line cause |
|---|---------|----------|----------------|
| 1 | `create_item` | 🔴 | SDK `items.create` is `(accountId, data)`; tool passes `(data, accountId)` |
| 2 | `create_credit_note` | 🔴 | Sends `clientid`; SDK model field is `clientId` |
| 3 | `report_payments_collected` | 🔴 | Date range sent as `search[...]`; reports need flat `start_date` — **silently returns today only**. Also ignores `currency_code`. |
| 4 | `report_profit_loss` | 🔴 | Same date-range bug — **silently returns today only** |
| 5 | `report_tax_summary` | 🔴 | Same date-range bug — **silently returns today only** |
| 6 | `create_bill_payment` | 🔴 | Sends `type`; SDK model field is `paymentType` |
| 7 | `update_bill_payment` | 🟠 | Same `type`/`paymentType` mismatch — payment type silently not updated |
| 8 | `create_journal_entry` | 🔴 | Builds `creditEntries`/`debitEntries`; SDK reads a single `details[]` array |
| 9 | `update_time_entry` | 🔴 | SDK serializes `started_at: null` when omitted; API rejects it |
| 10 | `update_other_income` | 🔴 | API needs full record (`amount`+`date`); tool sends neither and exposes neither |
| 11 | `update_project` | 🔴 | Projects API requires `title` on every PUT; tool omits it |
| 12 | `create_bill_vendor` | 🟠 | Sends `fName`/`lName`/`email`; SDK reads `primaryContactFirstName`/`...LastName`/`...Email` |
| 13 | `update_bill_vendor` | 🟠 | Same contact-field mismatch as #12 |

**The most dangerous are #3–#5.** They do not error. They return `ok` with believable,
all-zero data — every report silently runs for *today only* regardless of the dates passed.
In an accounting tool, silent wrong numbers are worse than a crash.

**Root causes — only four**, and all 13 bugs map onto them:

- **A. SDK method-signature mismatch** — #1
- **B. Wrong property name handed to the SDK model** — #2, #6, #7, #8, #12, #13
- **C. Updates that don't survive the SDK's request transform** — #9, #10, #11
- **D. Reports use the wrong query mechanism** — #3, #4, #5

All of class **B** (and #1) were invisible to the TypeScript compiler because every
`create`/`update` payload is cast `as any`. See **Section 6** — that cast is the real
enabling defect.

---

## 3. Audit method

1. **Static pass.** Read all 17 `src/tools/*.ts` files, `freshbooks-client.ts`,
   `query-helpers.ts`, `date-helpers.ts`, `server.ts`, and cross-checked every SDK call
   against `node_modules/@freshbooks/api/dist/APIClient.js` and the per-model
   `transform*Request` functions in `dist/models/`.
2. **Behavioral pass.** Called all 74 tools live against the test account. Read-only tools
   run as-is; write tools created real `ZZZ_MCP_AUDIT`-prefixed records that were then
   deleted (reverted). Reverting confirmed via `visState: 1`.
3. **Root-cause pass.** For every failure, traced the bad value back through the tool → SDK
   model transform → HTTP payload, and confirmed against the live error string and (for
   `other_income`) the FreshBooks API reference.

**Account limitation:** the test account does not have the Bills / Accounts-Payable add-on.
The 14 `bill` / `bill_payment` / `bill_vendor` tools could not have their *happy paths*
exercised live (`"You do not have access to bill vendors"`). Their `list`/`get`/error paths
were verified live; their request construction was verified by static SDK review — which is
how bugs #6, #7, #12, #13 were still found.

---

## 4. Results — all 74 tools

✅ works · ❌ broken (see Section 5) · ⚠️ code-correct but happy-path blocked by the missing AP add-on

| Domain | list | get | create | update | delete |
|---|---|---|---|---|---|
| Invoices | ✅ | ✅ | ✅ | ✅ | ✅ |
| Clients | ✅ | ✅ | ✅ | ✅ | ✅ |
| Expenses | ✅ | ✅ | ✅ | ✅ | ✅ |
| Payments | ✅ | ✅ | ✅ | ✅ | ✅ |
| Time entries | ✅ | ✅ | ✅ | ❌ #9 | ✅ |
| Items | ✅ | ✅ | ❌ #1 | ✅ | — |
| Other incomes | ✅ | ✅ | ✅ | ❌ #10 | ✅ |
| Bills | ✅ | ✅ | ⚠️ | — | ✅ |
| Bill payments | ✅ | ✅ | ❌ #6 | ❌ #7 | ✅ |
| Bill vendors | ✅ | ✅ | ❌ #12 | ❌ #13 | ✅ |
| Credit notes | ✅ | ✅ | ❌ #2 | ✅ | ✅ |
| Projects | ✅ | ✅ | ✅ | ❌ #11 | ✅ |
| Services | ✅ | ✅ | ✅ | — | — |
| Reports | `payments_collected` ❌ #3 · `profit_loss` ❌ #4 · `tax_summary` ❌ #5 |
| Tasks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Expense categories | ✅ | ✅ | — | — | — |
| Journal entries | `create` ❌ #8 · `list_accounts` ✅ · `list_details` ✅ |

The 61 ✅ tools were confirmed working — list/get against real records, and full
create→update→delete cycles for clients, expenses, payments, time entries, other incomes,
projects, tasks, invoices, plus `create_service`. Error handling is uniformly good: every
not-found / no-access case returned a clean `isError` message, never a crash.

---

## 5. The bugs — root causes & fixes

> Line numbers are as of commit `37f2748`; the quoted code is authoritative if lines have moved.

### Root cause A — SDK method-signature mismatch

The FreshBooks SDK is **not internally consistent**. `create` has three different shapes:
`invoices`/`clients`/`expenses`/`tasks`/… use `create(data, accountId)`; **`items` uses
`create(accountId, data)`**; project resources use `create(data, businessId)`. A wrapper
cannot assume — it must match each resource. `create_item` assumed wrong.

#### 🔴 #1 — `create_item` (`src/tools/items.ts`)

**Symptom (live):** `Failed to create item: Account not found`

**Root cause:** `node_modules/@freshbooks/api/dist/APIClient.js` defines
`items.create = (accountId, data) => ...` — accountId **first**. The tool calls it
data-first, so the SDK uses the item object as the URL's account segment
(`/accounting/account/[object Object]/items/items`) and sends the account-ID string as the body.

```ts
// items.ts — createItem handler, current (WRONG):
const response = await client.items.create(itemData as any, accountId);
// FIX — match the SDK signature (accountId, data):
const response = await client.items.create(accountId, itemData as any);
```

`updateItem` already calls `client.items.update(accountId, args.item_id, updateData)`
correctly — no change there.

---

### Root cause B — wrong property name handed to the SDK model

The SDK's job is to translate a **camelCase model object** into the API's snake_case JSON.
The wrapper must always hand the SDK the **camelCase property the model interface declares**.
Five tools hand it the wrong name; `JSON.stringify` then silently drops the resulting
`undefined`, so the field never reaches the API.

#### 🔴 #2 — `create_credit_note` (`src/tools/credit-notes.ts`)

**Symptom (live):** `Failed to create credit note: 'clientid' is a required field.`

**Root cause:** `transformCreditNoteRequest` reads `creditNote.clientId` and emits the API
field `clientid`. The tool sets `clientid` on the input object, so `creditNote.clientId` is
`undefined` and no client is sent.

```ts
// credit-notes.ts — createCreditNote handler, current (WRONG):
const creditNoteData: Record<string, unknown> = {
  clientid: args.client_id,
  lines,
};
// FIX — the SDK model property is clientId:
const creditNoteData: Record<string, unknown> = {
  clientId: args.client_id,
  lines,
};
```

#### 🔴 #6 / 🟠 #7 — `create_bill_payment` & `update_bill_payment` (`src/tools/bill-payments.ts`)

**Symptom (live, create):** `Failed to create bill payment: 'payment_type' is a required field.`
— observed *even though* `type: "Check"` was passed.

**Root cause:** `transformBillPaymentsRequest` reads `payment.paymentType` → emits
`payment_type`. Both handlers set `.type` instead of `.paymentType`, so the payment type is
dropped. For `create` that is fatal (FreshBooks requires `payment_type`). For `update` it
fails silently — amount/date/note update, but the type never changes.

```ts
// createBillPayment handler — current (WRONG):
if (args.type !== undefined) paymentData.type = args.type;
// FIX:
if (args.type !== undefined) paymentData.paymentType = args.type;

// updateBillPayment handler — current (WRONG):
if (args.type !== undefined) updateData.type = args.type;
// FIX:
if (args.type !== undefined) updateData.paymentType = args.type;
```

**Also (🟡):** FreshBooks requires `payment_type` on create, but the schema marks `type`
optional. Make it required for `create_bill_payment`:

```ts
// createBillPayment schema:
type: z.enum([
  "Check","Credit","Cash","Bank Transfer","Credit Card","Debit","PayPal",
  "2Checkout","VISA","MASTERCARD","DISCOVER","AMEX","DINERS","JCB","ACH","Other",
]).describe("Payment method type (required by FreshBooks)"),
```

(Use the same enum `create_payment` already uses, instead of the current free `z.string()`.)

#### 🟠 #12 / 🟠 #13 — `create_bill_vendor` & `update_bill_vendor` (`src/tools/bill-vendors.ts`)

**Symptom:** contact first name, last name, and email are silently dropped on every create
and update. (Not live-reproducible — account lacks the AP add-on — found via SDK review.)

**Root cause:** `transformBillVendorsRequest` reads `vendor.primaryContactFirstName`,
`vendor.primaryContactLastName`, `vendor.primaryContactEmail`. Both handlers set `fName`,
`lName`, `email`. (`vendorName`, `accountNumber`, `city`, `province`, `country`,
`postalCode`, `phone`, `currencyCode` are mapped correctly — only the contact fields are wrong.)

```ts
// createBillVendor & updateBillVendor handlers — current (WRONG):
if (args.first_name ...) vendorData.fName  = args.first_name;
if (args.last_name  ...) vendorData.lName  = args.last_name;
if (args.email      ...) vendorData.email  = args.email;
// FIX — use the SDK model property names:
if (args.first_name ...) vendorData.primaryContactFirstName = args.first_name;
if (args.last_name  ...) vendorData.primaryContactLastName  = args.last_name;
if (args.email      ...) vendorData.primaryContactEmail     = args.email;
```

Apply to both handlers (create uses `if (args.x)`, update uses `if (args.x !== undefined)` —
keep each file's existing guard style).

#### 🔴 #8 — `create_journal_entry` (`src/tools/journal-entries.ts`)

**Symptom:** ledger lines never reach the API. Not live-tested (no `delete_journal_entry`
tool — confirmed by static analysis only, by your instruction).

**Root cause — structural, not just a rename.** `transformJournalEntryRequest` reads exactly
one line container: `entry.details`. It does **not** read `creditEntries` or `debitEntries`.
Each `details[]` element is passed through `transformDetailParsedRequest`, which reads only
`detail.credit`, `detail.debit`, and `detail.subAccountId`:

```js
// SDK dist/models/Detail.js
function transformDetailParsedRequest(detail) {
  return { credit: detail.credit, debit: detail.debit, sub_accountid: detail.subAccountId };
}
```

So the tool is wrong on three axes: (a) wrong container (`creditEntries`/`debitEntries` vs
`details`), (b) wrong line key (`accountNumber` vs `subAccountId` — a *numeric sub-account
ID*, not an account-number string), (c) wrong amount type (`credit`/`debit` are `number` in
the SDK's `Detail` interface, not strings).

**Fix — redesign the schema and handler.** Keep the credit/debit split in the *tool input*
(it is intuitive), but merge into one `details[]` array internally.

```ts
// journal-entries.ts — createJournalEntry schema, replace credit_entries/debit_entries items:
credit_entries: z.array(z.object({
  sub_account_id: z.number().int().describe(
    "Sub-account ID — get it from freshbooks_list_journal_entry_accounts (the subAccountId field)"),
  amount: z.string().describe("Credit amount, e.g. '500.00'"),
})).min(1).describe("Credit lines"),
debit_entries: z.array(z.object({
  sub_account_id: z.number().int().describe(
    "Sub-account ID — get it from freshbooks_list_journal_entry_accounts (the subAccountId field)"),
  amount: z.string().describe("Debit amount, e.g. '500.00'"),
})).min(1).describe("Debit lines"),
// and add an optional date:
entry_date: z.string().optional().describe("Journal entry date in YYYY-MM-DD format (defaults to today)"),

// createJournalEntry handler, replace the entryData construction:
const entryData: Record<string, unknown> = {
  description: args.description,
  currencyCode: args.currency_code,
  details: [
    ...args.credit_entries.map((e) => ({ credit: Number(e.amount), subAccountId: e.sub_account_id })),
    ...args.debit_entries.map((e)  => ({ debit:  Number(e.amount), subAccountId: e.sub_account_id })),
  ],
};
if (args.entry_date) entryData.userEnteredDate = parseLocalDate(args.entry_date);
```

Add `import { parseLocalDate } from "../date-helpers";` to the file.

**Note on `Number()`:** the SDK's `Detail` interface types `credit`/`debit` as `number`, so
the conversion is required by the SDK contract — this is the one place the "amounts as
strings" rule cannot hold. Fine for normal amounts; document the caveat in the tool description.

**Recommended 🟡 addition** — the description promises "credit and debit totals must
balance," so enforce it before the API call (use `big.js`, already a dependency):

```ts
import Big from "big.js";
const creditTotal = args.credit_entries.reduce((s, e) => s.plus(e.amount), new Big(0));
const debitTotal  = args.debit_entries.reduce((s, e) => s.plus(e.amount), new Big(0));
if (!creditTotal.eq(debitTotal)) {
  return {
    content: [{ type: "text" as const, text:
      `Journal entry does not balance: credits ${creditTotal} vs debits ${debitTotal}` }],
    isError: true,
  };
}
```

---

### Root cause C — updates that don't survive the SDK's request transform

A FreshBooks PUT through this SDK is **not reliably a partial update**. Two distinct
failures, same family:

- The SDK transform serializes a required field **unconditionally** — when the update
  payload omits it, the SDK emits a bad value (`null`, or crashes).
- The FreshBooks endpoint itself **requires** a field on every PUT.

This is the exact defect commit `7242255` already fixed for `update_expense` (the SDK's
`transformExpenseRequest` calls `transformDateRequest(expense.date)` unconditionally). The
fix it used — **fetch the existing record, merge the caller's changes, send the complete
object** — is the correct, by-the-book pattern. Three sibling tools still have the defect.

#### 🔴 #9 — `update_time_entry` (`src/tools/time-entries.ts`)

**Symptom (live):** `Failed to update time entry: none is not an allowed value`

**Root cause:** `transformTimeEntryRequest` serializes `started_at` unconditionally:

```js
started_at: entry.startedAt ? entry.startedAt.toISOString() : null,
```

`updateTimeEntry` never sets `startedAt`, so the SDK sends `started_at: null`. The
timetracking API (Python) rejects null → `"none is not an allowed value"`.

**Fix — fetch and preserve `startedAt`:**

```ts
// updateTimeEntry handler, before building updateData:
const existing = await client.timeEntries.single(businessId, args.time_entry_id);
if (!existing.ok || !(existing.data as any)?.startedAt) {
  return {
    content: [{ type: "text" as const, text:
      `Could not load time entry ${args.time_entry_id} to preserve its start time: ${existing.error?.message ?? "no startedAt on returned entry"}` }],
    isError: true,
  };
}

const updateData: Record<string, unknown> = {
  startedAt: (existing.data as any).startedAt,           // a Date from the SDK — preserved
  duration:  args.duration ?? (existing.data as any).duration,
  isLogged:  (existing.data as any).isLogged,
};
if (args.note !== undefined)     updateData.note = args.note;
if (args.billable !== undefined) updateData.billable = args.billable;
```

#### 🔴 #11 — `update_project` (`src/tools/projects.ts`)

**Symptom (live):** `Failed to update project: An internal error has occurred.` — and the
**same call with `title` added succeeded** (confirmed during the audit). Root cause proven.

**Root cause:** the Projects API requires `title` on every PUT. `updateProject` makes
`title` optional and omits it when not supplied.

**Fix — fetch and preserve `title` when the caller doesn't change it:**

```ts
// updateProject handler:
let title = args.title;
if (title === undefined) {
  const existing = await client.projects.single(businessId, args.project_id);
  if (!existing.ok || !(existing.data as any)?.title) {
    return {
      content: [{ type: "text" as const, text:
        `Could not load project ${args.project_id} to preserve its title: ${existing.error?.message ?? "no title on returned project"}` }],
      isError: true,
    };
  }
  title = (existing.data as any).title;
}

const projectData: Record<string, unknown> = { title };
if (args.description !== undefined) projectData.description = args.description;
if (args.due_date !== undefined)    projectData.dueDate = args.due_date;
if (args.budget !== undefined)      projectData.budget = args.budget;
```

#### 🔴 #10 — `update_other_income` (`src/tools/other-incomes.ts`)

**Symptom (live):** `Failed to update other income: There was an error accessing your
account data.` — reproduced with `{note}` only and again with `{source, category_name, note}`.

**Root cause:** the FreshBooks `other_income` PUT requires the full record — notably
`amount` and `date`. The FreshBooks API reference's own *update* example sends `amount`,
`date`, and `source`. `update_other_income` sends none of `amount`/`date` and **does not
even expose them as parameters**, so a valid update is impossible.

**Fix — add `amount` and `date` to the schema, then fetch-and-merge:**

```ts
// updateOtherIncome schema — add:
amount: z.object({
  amount: z.string().describe("Amount as a string, e.g. '500.00'"),
  code: z.string().default("USD").describe("Currency code, e.g. 'USD'"),
}).optional().describe("Updated income amount"),
date: z.string().optional().describe("Updated income date in YYYY-MM-DD format"),

// updateOtherIncome handler — fetch existing, then send a complete object:
const existing = await client.otherIncomes.single(accountId, args.other_income_id);
if (!existing.ok) {
  return {
    content: [{ type: "text" as const, text:
      `Could not load other income ${args.other_income_id} to update it: ${existing.error?.message ?? "unknown error"}` }],
    isError: true,
  };
}
const cur = existing.data as any;
const updateData: Record<string, unknown> = {
  amount:       args.amount ? { amount: args.amount.amount, code: args.amount.code } : cur.amount,
  date:         args.date ? parseLocalDate(args.date) : cur.date,   // cur.date is a Date from the SDK
  categoryName: args.category_name ?? cur.categoryName,
  source:       args.source ?? cur.source,
  note:         args.note ?? cur.note,
};
```

Add `import { parseLocalDate } from "../date-helpers";` to `other-incomes.ts`.

> The fetch-and-merge approach is robust regardless of the exact required-field set: it
> always sends a complete, valid record. Verify the precise field list against
> <https://www.freshbooks.com/api/other_income> if FreshBooks tightens it later.

---

### Root cause D — reports use the wrong query mechanism

#### 🔴 #3 / #4 / #5 — `report_payments_collected`, `report_profit_loss`, `report_tax_summary` (`src/tools/reports.ts`)

**Symptom (live):** every report passed `2024-01-01 → 2026-05-21` returned data scoped to
`2026-05-21 → 2026-05-21` (today only). No error — `ok: true` with all-zero / empty data.
The P&L response's own `downloadToken` JWT decodes to `"start_date":"2026-05-21"`.

**Root cause:** all three tools build the date range with
`buildQueryBuilders({ dateRange: {...} })`. `dateRange` routes through the SDK's
`SearchQueryBuilder.between()`, which emits `search[date_min]=...&search[date_max]=...`.
That `search[...]` form is correct for accounting **list** endpoints — but the **reports**
endpoints expect flat `start_date=...&end_date=...` params. The `search[...]` params are
ignored, so the report falls back to its default range (today).

**Fix — use `search` instead of `dateRange`.** This is not a workaround: in the SDK's
`SearchQueryBuilder.build()`, an `equals` param on a non-accounting resource type (reports
use `'AccountingReportsResource'`) is emitted as a plain `&key=value`. So
`buildQueryBuilders({ search: { start_date, end_date } })` produces exactly
`&start_date=...&end_date=...` — the form the reports API wants.

```ts
// reports.ts — reportProfitLoss & reportTaxSummary, replace:
const queryBuilders = buildQueryBuilders({
  dateRange: { key: "date", min: args.start_date, max: args.end_date },
});
// with:
const queryBuilders = buildQueryBuilders({
  search: { start_date: args.start_date, end_date: args.end_date },
});
```

`report_payments_collected` has a **second bug**: its schema declares `currency_code` but the
handler never reads it. Fix both at once:

```ts
// reports.ts — reportPaymentsCollected, replace the queryBuilders block with:
const queryBuilders = buildQueryBuilders({
  search: {
    start_date: args.start_date,
    end_date: args.end_date,
    ...(args.currency_code ? { currency_code: args.currency_code } : {}),
  },
});
```

Leave `buildQueryBuilders`' `dateRange` branch in place — `list_invoices` and
`list_expenses` use it legitimately for accounting list filters.

---

## 6. The systemic fix — remove the `as any` blindfold

Every bug in **Root cause A and B** (#1, #2, #6, #7, #8, #12, #13 — **7 of 13**) shares one
enabler: the payload handed to the SDK is cast `as any`.

```ts
const response = await client.invoices.create(invoiceData as any, accountId);
const response = await client.creditNotes.create(creditNoteData as any, accountId);
const response = await (client as any).journalEntryAccounts.list(accountId, queryBuilders);
```

`as any` switches off the one check that would have caught `clientid`, `type`,
`creditEntries`, and `fName` at **compile time**: TypeScript verifying the payload against
the SDK's exported model interface. The SDK ships those interfaces — `Invoice`,
`CreditNote`, `BillPayment`, `BillVendor`, `JournalEntry`, `Detail`, etc.

**Recommended preventive fix (do this after the 13 functional fixes, verify build still passes):**

1. Replace `Record<string, unknown>` / object-literal payloads with the SDK model type, e.g.
   `import CreditNote from "@freshbooks/api/dist/models/CreditNote";` then
   `const creditNoteData: Partial<CreditNote> = { clientId: args.client_id, lines };`.
   `Partial<>` is appropriate for update payloads and for create payloads the SDK completes.
2. Drop the `as any` at each call site. If TypeScript then complains, the complaint *is* a
   latent bug — fix the property name, don't re-add the cast.
3. For `journal-entries.ts`, the `(client as any).journalEntryAccounts` /
   `journalEntryDetails` casts exist only because those resources are missing from the
   SDK's `Client` type declaration (they exist at runtime — both tools work). Replace the
   blanket `client as any` with a narrow typed shim so the rest of `client` stays typed:
   ```ts
   type JournalEntryListResources = {
     journalEntryAccounts: { list: (a: string, q?: unknown[]) => Promise<any> };
     journalEntryDetails:  { list: (a: string, q?: unknown[]) => Promise<any> };
   };
   const jeClient = client as unknown as JournalEntryListResources;
   ```

This is the "consider the entire functionality, no workarounds" fix: it makes the next
`clientid`-style typo a red build, not a silently shipped bug.

---

## 7. Lower-severity / completeness issues

| Sev | Tool | Issue | Suggested fix |
|---|---|---|---|
| 🟡 | `update_payment` | Schema exposes only `note` and `type`; the SDK's `transformPaymentUpdateRequest` also supports `amount` and `date`, so payment amount/date cannot be corrected. | Add optional `amount` (Money) and `date` params; map to `updateData.amount` / `updateData.date` (`parseLocalDate`). The SDK update transform serializes `date` conditionally, so no fetch-merge needed. |
| 🟡 | `create_client` | All fields optional; description says "at minimum provide a first name or organization" but nothing enforces it. An empty call sends `{}`. | Add a Zod `.refine()` requiring at least one of `first_name` / `organization`. |
| 🟡 | `create_invoice`, `create_bill`, `create_credit_note` | `lines` arrays accept `[]` despite "at least one line item". | Add `.min(1)` to each `lines` schema. |
| 🟡 | `create_journal_entry` | No `.min(1)` on entries; no balance check. | Covered by the #8 fix above (`.min(1)` + `big.js` balance check). |
| 🟡 | `create_bill` | `lines[].category` is sent as a string, but `transformBillLinesParsedRequest` reads `line.categoryId` (numeric). Bill line category may not map. Not verifiable here (account lacks AP add-on). | When the AP add-on is available, verify against `dist/models/BillLines.js` and switch to a numeric `category_id` if needed. |
| 🟡 | `update_credit_note` | `status` is sent as the model's `status` field; FreshBooks' user-visible credit-note status is `display_status`. The string values in the description ("draft","sent") likely belong in `displayStatus`. Untestable here (no credit notes; create was broken). | Verify against a real credit note after #2 is fixed; map to `displayStatus` if appropriate. |
| ⚪ | `delete_time_entry`, `delete_project` | FreshBooks `DELETE` returns no body; the tool returns `JSON.stringify(undefined)` → `""`. The caller sees a blank result and cannot tell success from failure. | On `response.ok` with empty data, return a confirmation string, e.g. `Time entry <id> deleted.` |
| ⚪ | infra | `withAutoRefresh()` is exported from `freshbooks-client.ts` but not wired into any tool handler — a mid-session token expiry (401) will not self-heal. | Wrap each handler's SDK call in `withAutoRefresh(() => ...)`, or document that it is intentionally deferred. |

---

## 8. Documentation & project meta issues

| Sev | Issue | Fix |
|---|---|---|
| ⚪ | `package.json` `test` script is `echo "Error: no test specified" && exit 1` — there is **no test suite**, yet `CLAUDE.md` states `npm test` "runs the test suite." | Either add tests or correct `CLAUDE.md`. Given this audit, a regression test per fixed tool would be high-value. |
| ⚪ | `CLAUDE.md` describes `src/types.ts` ("Shared TypeScript types and interfaces"). The file does **not exist**. | Remove the reference, or create the file. `src/` actually contains `date-helpers.ts` (also undocumented in the structure list). |
| ⚪ | `CLAUDE.md`'s project-structure block predates `src/date-helpers.ts`. | Add `date-helpers.ts` to the documented structure. |

---

## 9. Recommended remediation plan (ordered)

Work in this order — cheap/isolated first, structural last. After **each** step, run
`npm run build` (the project compiles with `tsc`; a clean build is the first gate).

1. **#1 `create_item`** — swap the two args in `items.ts`. (1 line)
2. **#2 `create_credit_note`** — `clientid` → `clientId` in `credit-notes.ts`. (1 line)
3. **#6/#7 bill payments** — `type` → `paymentType` in both handlers; make `create`'s `type`
   a required enum. (`bill-payments.ts`)
4. **#12/#13 bill vendors** — `fName`/`lName`/`email` → `primaryContact*` in both handlers.
   (`bill-vendors.ts`)
5. **#3/#4/#5 reports** — `dateRange` → `search` in all three handlers; wire up
   `currency_code` in `report_payments_collected`. (`reports.ts`)
6. **#9 `update_time_entry`** — fetch-and-preserve `startedAt`. (`time-entries.ts`)
7. **#11 `update_project`** — fetch-and-preserve `title`. (`projects.ts`)
8. **#10 `update_other_income`** — add `amount`/`date` params + fetch-and-merge.
   (`other-incomes.ts`)
9. **#8 `create_journal_entry`** — schema redesign (`sub_account_id`, `details[]`, optional
   `entry_date`) + balance check. (`journal-entries.ts`)
10. **Section 6 — systemic** — type the payloads against SDK model interfaces, delete the
    `as any` casts, fix anything the compiler then flags.
11. **Section 7 / 8** — completeness items and doc corrections, as scoped.
12. **`npm run build`**, then **restart the MCP server** so the new `dist/` is loaded
    (the running `node dist/index.js` process holds the old code in memory — quit/reopen
    Cursor or Claude Desktop, or relaunch the MCP server).
13. Verify per **Section 10**.

Steps 1–9 are independent — they can be done and committed individually. Suggested commits
mirror the existing `fix:` style, e.g. `fix: correct items.create argument order`.

---

## 10. Verification checklist

After rebuilding and restarting, confirm each fix with a live call (use
`ZZZ_MCP_AUDIT`-prefixed test data and revert, exactly as this audit did):

| Bug | Verification |
|---|---|
| #1 | `create_item` → returns an item with an `id`; then `update_item` it. (No `delete_item` tool — clean up in the FreshBooks UI.) |
| #2 | `create_credit_note` (any active client, one line) → returns a credit note; `get`, `update`, `delete` it. |
| #3 | `report_payments_collected` `2024-01-01 → 2026-05-21` → response `startDate`/`endDate` echo the **passed** range, not today; payments appear. |
| #4 | `report_profit_loss` same range → non-zero income/expenses; `downloadToken` JWT decodes to the passed dates. |
| #5 | `report_tax_summary` same range → `totalInvoiced` reflects real history. |
| #6/#7 | Requires the Bills/AP add-on. With it: `create_bill_payment` succeeds; `update_bill_payment` changes the type. |
| #8 | `create_journal_entry` with a balanced $1 debit / $1 credit using real `sub_account_id`s from `list_journal_entry_accounts` → succeeds; confirm via `list_journal_entry_details`. (Delete in the FreshBooks UI — no delete tool.) |
| #9 | Create a time entry, `update_time_entry` its `duration`/`note` → succeeds (no "none is not an allowed value"); delete it. |
| #10 | Create an other-income, `update_other_income` its `note` only → succeeds; delete it. |
| #11 | Create a project, `update_project` its `description` only → succeeds (no "internal error"); delete it. |
| #12/#13 | Requires the AP add-on. With it: `create_bill_vendor` with a contact name/email → `get_bill_vendor` shows them populated. |

A clean `npm run build` plus `npm run lint` is the compile-time gate; the table above is the
behavioral gate.

---

## 11. Cleanup note

This audit created and reverted real records (all `ZZZ_MCP_AUDIT`-prefixed). Every
revertible record was soft-deleted (`visState: 1`) — verified: `list_clients`,
`list_projects` etc. show no active test records. **Two records remain** and must be
removed by hand in the FreshBooks web UI (Settings → Services), because no MCP tool can
delete them:

- **Service `ZZZ_MCP_AUDIT Service`** (id `26252490`) — created by `create_service`, which
  has no `delete_service` counterpart.
- **Service `ZZZ_MCP_AUDIT Task`** (id `26252489`) — a *side effect*: FreshBooks
  auto-creates a linked project-service whenever a billable task is created. `delete_task`
  soft-deleted the task itself, but the linked service shadow persists.

The second item is also a minor **behavioral finding** (⚪ Low): `create_task` silently
creates a second record (a project-service) that `delete_task` does not clean up. This is
inherent FreshBooks task/service coupling, not an MCP defect — but worth knowing, because a
`create_task` is not fully reversible via the MCP alone.

No other test data persists. Account totals and the real `Adjustment` item (id `1338131`,
whose description was temporarily changed and reverted to `""`) are unaffected.

---

## 12. v2.0 remediation outcome (2026-05-21)

All fixes in this document were applied on the `v2.0` branch and re-verified live.
**Outcome: 11 of the 13 tools fully fixed and verified working.** The two exceptions were
found, during verification, to be broken *deeper than this audit first diagnosed* — inside
the `@freshbooks/api@4.1.0` SDK (the latest release), not just the wrapper:

- **#2 `create_credit_note`** — the `clientid`→`clientId` fix was necessary but not
  sufficient. The SDK's `transformCreditNoteRequest` wraps the body in `credit_notes`
  (plural); the API requires `credit_note` (singular) — every other resource transform
  uses the singular key. The response transform is broken the same way, and `create_date`
  is API-required. A custom `client.call` with the singular wrapper was verified to create
  a credit note, confirming the SDK as the root cause.
- **#8 `create_journal_entry`** — the `details[]` redesign was correct, but the SDK's
  `transformJournalEntryRequest` omits the API-required `name` field and emits
  `user_entered_date` where the API expects `date`.

Per the owner's decision, these two `create` tools ship in v2.0 **documented as known
limitations** (see `CHANGELOG.md`) rather than patched with custom transforms — the defect
is upstream and belongs in `@freshbooks/api`. Their `list`/`get` tools are unaffected.
