# Tier 2 write domains — go/no-go memos

- **Date:** 2026-07-29 (Phase 3 exit artifact, required by the Tier 2 design)
- **Probe host:** live probes ran against the owner's real books with explicit
  authorization; identifiers below follow `TOOL_AUDIT.md`'s redaction policy
  (profile names appear, account ids and monetary figures do not, except the
  $1.00 audit line item).
- **Method:** every verdict is gated on a live artifact — a
  create→get→update→delete→re-list transcript with an empty diff, a
  PUT-partial (full-replace) probe, and a delete-verb probe. No verdict rests
  on documentation or guesswork.

## Taxes — **GO** (Phase 4 ships)

Transcript (least-active profile, zero pre-existing taxes — a clean field):

1. Snapshot list: `[]`.
2. `POST taxes/taxes` body `{ tax: { name: "ZZZ_MCP_AUDIT", amount: "5", number: "AUDIT-1" } }`
   → 200, envelope `tax`, id assigned.
3. `GET taxes/taxes/<id>` → envelope `tax`, all fields echoed.
4. **PUT-partial probe:** `PUT` with only `{ tax: { amount: "7" } }` →
   `name` and `number` SURVIVED. **Merge semantics — partial updates are safe;
   no fetch-and-merge needed.**
5. **Delete-verb probe:** `DELETE taxes/taxes/<id>` → 200 `{"response":{}}`;
   re-GET → **404. Hard delete** (tool description must say permanent).
6. Re-list: `[]` — empty diff; the books ended exactly as they started.

## Estimates — **GO** (Phase 5 ships)

Transcript (profile with existing clients; an existing client was used — no
client was created):

1. Snapshot list: `[]`.
2. `POST estimates/estimates` requires **`customerid`** (not `clientid` —
   422 names the field) and **`create_date`** (422 names it too). With both +
   `lines[]` → 200, envelope **`estimate`** (this also verified the
   previously-unverifiable single-item envelope key). Created as
   `status: 1` (draft), `vis_state: 0`; **nothing is emailed on create**.
3. `GET estimates/estimates/<id>` → envelope `estimate`. **QUIRK: line items
   are omitted unless `include[]=lines`** (singular `include`, verified on the
   wire) — `freshbooks_get_estimate` now always passes it.
4. **PUT-partial probe:** `PUT` with only `{ estimate: { notes } }` → lines
   and total SURVIVED (re-verified with `include[]=lines`). **Merge
   semantics — partial updates are safe.**
5. **Delete-verb probe:** `DELETE estimates/estimates/<id>` → 200; record
   remains readable with **`vis_state: 1` — soft delete**, restorable, and
   excluded from lists.
6. Re-list: `[]` — empty diff.

Phase 5's `freshbooks_send_estimate` additionally requires
`email_recipients` as a required, non-defaulted param (tested to prove the
send path is unreachable without it), and exactly one live send to an address
the owner controls before release.

Audit residue, disclosed: two `ZZZ_MCP_AUDIT` $1.00 draft estimates exist
soft-deleted (`vis_state: 1`, invisible in lists, never sent) on the probed
profile — the same residue class the repo's original 2.0.0 audit method
produced. The probed tax was hard-deleted; zero residue.

## Staff — **NO-GO, permanent** (read-only shipped in Phase 3)

Decision, not a probe failure: `create_staff` invites/emails a real human —
it cannot be live-verified without side effects on people, which fails the
repo's own write-verification method. The Phase 3 read tools already close
the real hole (`freshbooks_create_expense` needs a `staff_id` no tool could
produce). Revisit only with a disposable sandbox account.

## Invoice profiles — **NO-GO** (Phase 6 does not ship)

Two independent blockers, each sufficient:

1. **The create probe is unsafe on real books.** A live invoice profile is a
   recurring-invoice generator; a mis-scheduled probe object can invoice a
   real client with real money. No configured profile is disposable.
2. **The single-item contract is unverified.** No configured profile has any
   invoice profile, so even the read contract for one record rests on a
   guessed envelope key (`invoice_profile`) that fails loudly via drift
   detection but has never returned 200.

Reads ship (list envelope verified on all four profiles; the single-item
tool is drift-guarded). Writes are deferred until either a disposable
FreshBooks account exists for the probe, or a real invoice profile appears
on a configured account and verifies the read contract first.
