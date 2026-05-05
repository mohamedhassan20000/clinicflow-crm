# Performance and Database Follow-ups

This note captures larger follow-up work identified during the Phase 4
performance and responsiveness pass. These items are intentionally not
implemented yet because they affect database transactions, auth/request
boundaries, or critical action semantics.

## Appointment Billing and Undo RPC

Current appointment completion touches appointment status, invoice totals,
appointment service lines, payment fields, and undo behavior from separate
application paths. The safer long-term design is a Postgres RPC that performs
completion and invoice writes in one transaction.

Recommended future shape:

- Add a `complete_appointment_with_billing` RPC that accepts the appointment ID,
  expected previous status, billing payload, and an idempotency key.
- Lock the appointment row with `FOR UPDATE` before validating status,
  clinic ownership, and related rows.
- Insert or replace appointment service lines and payment fields inside the
  same transaction.
- Record enough audit data to support a controlled undo without trusting
  client-supplied invoice snapshots.
- Add a matching `undo_appointment_completion` RPC that locks the appointment,
  validates the caller, restores the prior allowed status, and reverses related
  billing rows atomically.

Risk notes:

- This should be done with a migration and tested against production-like data.
- Avoid client-only undo state as the source of truth for financial reversal.
- Preserve current role checks in server actions even after moving the write
  operation into RPCs.

## Settlement RPC

Settlement currently records payment rows and updates appointment debt state as
multiple application-level operations. That can leave partial results if one
step succeeds and a later step fails.

Recommended future shape:

- Add a `settle_patient_outstanding` RPC that accepts patient ID, clinic ID,
  payment details, target appointment debts, and an idempotency key.
- Validate patient and appointment clinic ownership inside the transaction.
- Lock affected appointment rows before calculating remaining outstanding
  amounts.
- Insert settlement rows and update appointment outstanding values in one
  transaction.
- Return updated billing totals so the UI can refresh or optimistically update
  safely.

Risk notes:

- The RPC should define a deterministic ordering for paying multiple debts.
- Add database constraints or checks to prevent negative outstanding balances.
- Keep server action authorization as the first guard before calling the RPC.

## Middleware and Page-visibility Cache

The current protected-route path performs auth/profile/page-visibility work
during request handling. This is correct but can add latency across many
protected navigations and can leave page-visibility decisions dependent on
cache/cookie freshness.

Recommended future strategy:

- Migrate from the deprecated `middleware` convention to Next.js `proxy` when
  scheduling platform-maintenance work.
- Keep request interception focused on coarse auth redirects.
- Move heavier profile and role/page-visibility checks closer to protected
  server layouts or route handlers where possible.
- Version the page-visibility cache per clinic or per staff profile so settings
  changes can invalidate stale visibility cookies deterministically.
- After page-visibility settings are saved, refresh the current route and clear
  or update the visibility cache for the affected staff member.

Risk notes:

- Do not weaken route-level access while optimizing request latency.
- Treat page visibility as UX plus defense-in-depth; server actions and pages
  must still enforce role and clinic authorization.
- Test direct URL access, stale cookies, and role changes before shipping.

## Critical-action Idempotency

Client-side pending guards reduce accidental double clicks, but they do not
protect against duplicate requests from multiple tabs, retries, network
replays, or malicious clients. Critical writes need server-side idempotency and
guarded state transitions.

Recommended targets:

- Appointment status transitions, especially complete, cancel, no-show, and
  undo.
- Staff password reset, activation/deactivation, and soft delete/restore.
- Patient deposit creation and outstanding settlement.
- Permanent delete actions.

Recommended protections:

- Accept an idempotency key for critical write operations and store processed
  keys with the resulting operation ID.
- Use guarded updates that include the expected current status or deletion
  state in the `WHERE` clause.
- Add database constraints for financial invariants such as non-negative
  amounts and valid outstanding balances.
- Prefer transactional RPCs for multi-row writes that must succeed or fail
  together.

Risk notes:

- Idempotency keys should be scoped by clinic, actor, action, and target record.
- Avoid silently swallowing conflicting duplicate operations; return a clear
  success, replay, or conflict result.
- Add tests for duplicate submissions and concurrent updates before enabling
  retries around these actions.
