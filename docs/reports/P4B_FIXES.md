# ClinicFlow P4B Review Fixes

Date: 2026-07-18

## Review findings addressed

### M1 — failed and aborted stream finalization

Verified against the installed `ai@6.0.230` package rather than inferred SDK behavior:

- `handle-ui-message-stream-finish.ts` supplies UI stream finalizers with `isAborted` and `finishReason`.
- `stream-text.ts` routes provider/model failures through error chunks and routes tool output failures through the response error handler.
- The package abort-handling guidance requires `consumeSseStream: consumeStream` when server-side finalization must still run after the client aborts.

The chat route now reserves one usage unit before model work and releases that reservation when generation is aborted, the stream error handler observes a model/tool error, the finish reason is `error`, or no assistant text was completed. Those paths persist neither the submitted user message nor an assistant message. A first-turn conversation also remains virtual until successful persistence, so a failed or aborted first turn leaves no empty conversation row.

Successful completion remains one counted unit and persists the same user/assistant turn as before. A persistence reporting failure after a successfully delivered model response remains PHI-safe and does not retroactively convert a completed model turn into a free turn.

### M2 — concurrent usage-cap overshoot

The route now uses the existing database-backed `increment_usage` RPC as an atomic reservation boundary before model execution. The preliminary entitlement lookup still provides typed denial reasons, but the conditional database increment is authoritative when concurrent callers contend for the last unit. A caller that loses that race receives `usage_limit_reached` and never invokes the model.

A new service-role-only `release_usage` RPC atomically compensates failed or aborted reservations without allowing the counter to go below zero. The reservation's UTC billing-period start is carried through to compensation, so a turn spanning a month boundary cannot decrement the next month's counter. The route's per-request release closure is idempotent.

The remaining limitation is fail-closed leakage: if the server process terminates after reserving a unit, or the compensation RPC is unavailable, that unit can remain consumed even though the turn failed. This reduces the displayed/available allowance but cannot overshoot the cap. Eliminating it would require a durable per-turn reservation ledger and recovery workflow, which is outside P4B.

### L1–L6

- **L1:** Patient context now explicitly validates the same doctor assignment-or-department scope used by the patient surface, in addition to RLS and tenant/deletion checks.
- **L2:** A conversation/patient context mismatch now returns `400 invalid_request`; infrastructure and persistence failures remain `503 temporarily_unavailable`.
- **L3:** History loading fetches one sentinel row, keeps the newest 40 messages in chronological order, and shows a localized notice when older history was omitted.
- **L4:** `aria-live` was removed from the scrolling message history. One atomic, screen-reader-only status region announces thinking and completed-response state.
- **L5:** A successful client turn calls `router.refresh()` so the server-derived remaining count replaces the stale page value. Another already-open tab can remain cosmetically stale until its next refresh/navigation; realtime cross-tab synchronization was intentionally not introduced.
- **L6:** Client-generated conversation IDs are inserted with conflict-safe upsert during successful persistence, then re-selected through clinic/user/persona/status scope before messages are written. Concurrent first turns no longer fail on the same-ID insert race.

No low-severity finding was otherwise deferred.

## Intentionally deferred findings

None. Both Medium findings and all six Low findings were addressed within P4B scope.

One operational limitation remains, but it is not a deferred review finding: an abrupt process termination after a successful reservation, or an unavailable compensation RPC, can leave one usage unit consumed. Closing that failure mode would require a durable reservation ledger and recovery workflow, which would expand the data model and exceed the approved P4B fixes. The implemented posture remains fail-closed and cannot overshoot the clinic cap.

## Exact behavior changes

1. Authentication, role/entitlement authorization, rate limiting, and request validation still happen before model execution.
2. An atomic monthly usage unit is claimed before conversation/model work. Cap contention fails closed with HTTP 429.
3. Existing conversations are loaded only through tenant/user/doctor-persona scope. New conversation metadata is not persisted before a successful model turn.
4. Model errors, tool errors, aborts, error finish reasons, and empty completions release the claimed unit and persist no turn.
5. Successful text completions retain the claimed unit, conflict-safely materialize the conversation, and persist the user/assistant pair.
6. Sentry metadata contains clinic/conversation identifiers and error categories only; prompts, model output, tool payloads, patient names, and medical content are not logged.

## Files changed

Runtime and database:

- `app/api/agent/chat/route.ts`
- `lib/ai/conversations.ts`
- `lib/ai/usage.ts`
- `lib/supabase/admin.ts`
- `types/database.ts`
- `supabase/migrations/20260718170000_p4b_ai_usage_reservation.sql`

Assistant UI and localization:

- `app/(protected)/assistant/page.tsx`
- `app/(protected)/patients/[id]/page.tsx`
- `components/assistant/assistant-chat.tsx`
- `components/assistant/patient-assistant-launcher.tsx`
- `messages/en.json`
- `messages/ar.json`

Tests:

- `tests/unit/api/p4b-chat-route.test.ts`
- `tests/unit/ai/p4a-authorization.test.ts`
- `tests/unit/ai/p4b-conversations.test.ts`
- `tests/unit/components/p4b-assistant-chat.test.tsx`
- `tests/unit/db/p4b-ai-usage-reservation-migration.test.ts`
- `tests/unit/integration/p1b-billing-entitlements.test.ts`

## Tests added or updated

- Successful stream: reserves, streams, persists one user/assistant pair, and retains the reservation.
- Abort: releases once and persists nothing.
- Model error: observes the stream error, releases once, and persists nothing.
- Tool error: observes the tool/stream error, releases once, and persists nothing.
- Atomic cap race: the database winner consumes the last unit and the loser is denied without model execution.
- Compensation: release is service-role-only, atomic, non-underflowing, and tied to the original billing period.
- Conversation hardening: patient mismatch, doctor scope, virtual first-turn state, and concurrent same-ID persistence.
- UI hardening: localized truncation notice and a single bounded live region.

## Validation results

- Focused P4B unit tests: **6 files / 36 tests passed**.
- Full non-integration unit suite: **156 files / 869 tests passed** in one run.
- Full local Supabase integration suite: **18 files / 152 tests passed**. This includes AI tool RLS, concurrent usage reservation, compensation, and authenticated-RPC denial coverage. Existing multiple-GoTrue-client warnings were emitted.
- Local migration application: passed without a database reset. The local P4A schema already existed but its migration-history row was missing, so that existing P4A version was marked applied before applying the P4B compensation migration.
- TypeScript (`pnpm typecheck`): passed.
- ESLint (`pnpm lint`): passed with 25 pre-existing warnings and no errors.
- Production build (`pnpm build`): passed. Next.js emitted the existing middleware-to-proxy deprecation warning.
- RTL logical-properties gate: passed (369 files checked; 10 existing exceptions).
- i18n literal gate: passed (292 files checked; 14 existing exceptions).
- Locale key parity: passed (2,570 messages); unused-message check passed.
- Local database lint: passed with two pre-existing unused-variable warnings in billing functions.
- P4B Playwright regression: **1 Chromium test passed**. The server emitted existing unrelated dashboard/profile warnings.
- `git diff --check`: passed.

No commit, push, or pull request was created.

## Final implementation summary

P4B now counts only successfully completed assistant turns, enforces the monthly AI cap through an atomic database reservation, and compensates failed or aborted streams without persisting orphaned chat messages. Patient-context validation, error classification, long-history disclosure, screen-reader announcements, remaining-count refresh, and concurrent first-turn persistence were hardened without adding tools, expanding AI capabilities, changing authorization/RLS policies, or entering P4C/P5 scope.

All focused, full unit, live integration, production-build, localization/RTL, database-lint, and browser-acceptance validations required for P4B pass. The implementation is ready to proceed to the next sub-phase.
