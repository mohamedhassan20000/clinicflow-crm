# P3 Phase Review — Messaging Layer, Inbox, Reminders & Notifications (P3A–P3D)

**Status:** ALL FINDINGS RESOLVED (pending re-review sign-off)
**Sub-phase:** P3 (final phase review across P3A, P3B, P3C, P3D)
**Review cycle:** 3
**Branch:** `feat/p3a-messaging-core` (all work uncommitted)
**Cycle 1:** 2026-07-17, performed by Codex (chat-only; this file backfills it — findings below carry the original substance with stable IDs assigned retroactively)
**Cycle 2:** 2026-07-17, re-review after the SMS/Unifonic removal — scope strictly limited to verifying the cycle-1 findings against the current implementation; no new architectural review was performed
**Cycle 3:** 2026-07-17, fix cycle for the remaining open findings (P3-H2, P3-H3, P3-M1, P3-M2, P3-M3, P3-L1). Minimal production-safe fixes only; no re-architecture, no product-decision changes. Resolution evidence recorded per finding below and summarized in the cycle-3 section.

---

## Cycle-2 verdict

**CHANGES REQUIRED.** Of the seven cycle-1 findings, **P3-H1 is resolved** by the SMS-removal work (email is now genuinely provisioned and usable without WhatsApp). The remaining **two high, three medium, and one low finding are all still valid** — none of them were touched by the SMS removal, and the removal introduced no new instance of any of them. No finding was invalidated by the channel-set change except where noted inside P3-M1 (the SMS leg of the duplicate scenario no longer exists; the WhatsApp→Email leg remains).

Commit/PR readiness: **No.** The open high- and medium-severity findings plus their regression coverage remain the gate.

---

## Cycle-3 verdict

**ALL FINDINGS RESOLVED.** The six open findings (P3-H2, P3-H3, P3-M1, P3-M2, P3-M3, P3-L1) received minimal, production-safe fixes with the regression coverage each finding named. P3-H1 remains resolved from cycle 2 and was not revisited. The WhatsApp + Email-only product decision and the inert `sms`/`sms_messages` billing vocabulary were left untouched. All automated delivery still flows through the `sendMessage()` lifecycle, and tenant isolation and the adapter boundary are preserved.

**Design summary (one line each):**

- **P3-H2** — `list_reminder_candidates` RPC now filters the bounded window in SQL to appointments with ≥1 *actionable* offset (due, unsent, not under a fresh claim), so fully-reminded rows can no longer occupy the 1,000-row window.
- **P3-H3** — the claim RPC writes a recoverable **lease** (`{state:"claimed",at}`), not a permanent "sent" marker; only `finalize_appointment_reminder` (called after a successful dispatch) records a send, and a stale claim past a 15-minute lease is re-claimable — a crash between claim and dispatch can no longer suppress a reminder.
- **P3-M1** — the 360dialog adapter distinguishes **ambiguous** outcomes (timeout / 2xx-without-id) from definite rejections; `sendMessage` leaves the row `queued` (no failed finalize) on ambiguous, and the automated sender stops instead of falling back to Email, so no WhatsApp+Email duplicate. Definite failures still fall back to Email.
- **P3-M2** — notification dedup is now DB-enforced: a partial unique index `(recipient_id, dedupe_key) WHERE read_at IS NULL` plus a `SECURITY DEFINER` `emit_clinic_notifications` RPC inserting `ON CONFLICT DO NOTHING`; the composite recipient FK keeps tenant isolation explicit.
- **P3-M3** — submit/edit/delete/webhook transitions are single guarded conditional `UPDATE`s (`… WHERE approval_status IN (…)`), the "submitting" state is claimed before the provider call and reverted on provider failure, webhook writes are gated on both `provider_template_id` and the legal source states (so a stale/late event cannot regress newer state), and approved/registered WhatsApp templates are deleted at 360dialog before the local delete.
- **P3-L1** — a shared `noBidiControls` refinement rejects the Unicode bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F/U+061C) at the messaging/template validation boundary; normal Arabic/English text passes.

**Verification (cycle 3, current tree):**

- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors (26 pre-existing warnings, none in Phase-3 files)
- `npm run i18n:missing` / `npm run i18n:unused` — pass (`validation.unsafeText` added to en/ar and referenced)
- `npm test` — **799/799** (146 files; +31 over cycle 2's 768)
- `npm run test:integration` (local Supabase) — **130/130** (17 files; +6 over cycle 2's 124), including the >1,000-row starvation guard and the concurrent notification-dedup race
- `npm run test:e2e:p3c` — 1/1
- `supabase db reset` — all migrations apply from a clean database

**Residual risks:**

- An **ambiguous** WhatsApp reminder whose message *was* actually delivered leaves the lease claimed; after the 15-minute lease expires a later cron run may re-send that one reminder on the same channel. This is the intended at-least-once trade-off for P3-M1 (retry same channel, never cross-channel) and is far less harmful than a WhatsApp+Email duplicate. The delivery callback repairs the `outbound_messages` row but not the reminder lease.
- If `finalize_appointment_reminder` fails (a DB error *after* a successful send), the lease stays claimed and the reminder could re-send once after the lease window — the same bounded at-least-once behavior.
- Hourly cron granularity is unchanged; the 15-minute lease sits comfortably inside it.

Commit/PR readiness: **Pending re-reviewer sign-off.** Nothing was committed, pushed, merged, or opened as a PR.

---

## Findings

### High severity

**P3-H1 — Email fallback is not actually provisioned** — ✅ RESOLVED (cycle 2)
- *Cycle-1 claim:* `sendMessage()` returned `NO_ACTIVE_CHANNEL` for any clinic without a `clinic_channels` row, and the only production path creating one was the 360dialog WhatsApp connect flow — so a clinic without WhatsApp could never send reminders by email (or SMS, then still in scope).
- *Cycle-2 verification:* `lib/messaging/send.ts` now auto-provisions a tenant-scoped Resend email channel (`provisionEmailChannel`, `lib/messaging/send.ts:99–121`) whenever the preference includes `email` and no active email row exists (`lib/messaging/send.ts:184–188`); the upsert carries the explicit `clinic_id` (fixed 2026-07-17 — it previously failed typecheck). `lib/messaging/automated-send.ts` walks exactly `["whatsapp", "email"]` and reaches the email attempt whenever the patient has an email address, with no WhatsApp channel, template, or phone required. Covered by `tests/unit/lib/p3a-messaging-send.test.ts` (tenant-scoped email provisioning with no pre-existing channel row) and `tests/unit/lib/p3d-automated-send.test.ts` ("uses Email directly when no WhatsApp template or phone is available", "tries WhatsApp first and Email second", "stops after a successful WhatsApp send"). Full unit (768), integration (124), and P3C e2e suites pass on the current tree.

**P3-H2 — Reminder query can permanently starve appointments past the first 1,000** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* `listReminderCandidateAppointments` selected the earliest 1,000 upcoming confirmed appointments platform-wide with no exclusion of already-fully-reminded rows; the runner filtered those in memory only, so fully-reminded rows kept occupying the window and starved later appointments.
- *Cycle-3 fix:* `listReminderCandidateAppointments` (`lib/supabase/admin.ts`) now calls a new `list_reminder_candidates(p_now, p_horizon, p_limit)` `SECURITY DEFINER` RPC (`supabase/migrations/20260717150000_p3d_reminders_notifications.sql`). The RPC joins `clinics` for each tenant's `reminder_offsets` and admits an appointment only when it has **at least one actionable offset** — due (`scheduled_at - offset <= now`), and `reminder_offset_actionable` (unsent and not under a fresh claim). Fully-reminded rows fail the `EXISTS` predicate and never enter the bounded window, so later eligible appointments surface across runs as earlier ones finalize. The exclusion is in SQL, not in-memory. *Regression:* `tests/unit/integration/p3d-reminders-notifications.test.ts` → "list_reminder_candidates starvation guard (P3-H2)" inserts 1,000 fully-reminded due rows plus one later-scheduled eligible row and asserts the eligible one is returned while none of the reminded rows are.

**P3-H3 — A process interruption after claiming a reminder loses it permanently** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* `claim_appointment_reminder` wrote the offset directly into `reminders_sent` as a de-facto "sent" marker before any send, and the runner released it only on a normally-returned failed result — so a crash/timeout between claim and dispatch left a permanent marker for a reminder that never went out.
- *Cycle-3 fix:* the marker is now a recoverable **lease**. `claim_appointment_reminder` writes `{"state":"claimed","at":<iso>}`; a claim is re-claimable once older than a 15-minute lease (`reminder_offset_actionable`), so a crashed run's reminder is recovered on a later cron pass. A send is recorded **only** by the new `finalize_appointment_reminder` (`{"state":"sent"}` + legacy `reminder_sent_at`), which the runner calls **after** a successful dispatch (`lib/messaging/reminders.ts`). `release_appointment_reminder` removes only a `claimed` entry (definite failure → retry); a `sent` entry is terminal. Concurrency safety is preserved: the fresh-claim check runs under the same `FOR UPDATE` row lock. *Regression:* `tests/unit/integration/p3d-reminders-notifications.test.ts` → "reminder claim → finalize → release lease (P3-H3)" covers claim-is-a-lease (no legacy stamp), finalize-promotes-and-blocks-reclaim, release-frees-and-reclaims, and **stale-claim recovery past the lease window** plus the concurrent second-claim block; `tests/unit/lib/p3d-reminders.test.ts` covers the runner finalizing on success and recovering a stale claim.

### Medium severity

**P3-M1 — Ambiguous provider failures can produce cross-channel duplicates** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* the 360dialog adapter collapsed a timeout into the same `{ ok: false }` shape as a definitive rejection, and the automated sender advanced to Email on any failure — so a lost response after provider acceptance produced a WhatsApp+Email duplicate.
- *Cycle-3 fix:* `ProviderSendResult`'s failure variant gains an `ambiguous?: boolean` (`lib/messaging/types.ts`). The 360dialog `send` marks thrown fetch errors (timeout/network) **and** a 2xx-without-message-id as `ambiguous: true`, while a definite HTTP rejection stays unambiguous (`lib/messaging/whatsapp-dialog360.ts`). `sendMessage` no longer finalizes an ambiguous outcome as `failed`: it leaves the `outbound_messages` row `queued` (writing only the error note under a `status = 'queued'` guard) and returns a new `PROVIDER_SEND_AMBIGUOUS` code (`lib/messaging/send.ts`) so the delivery callback can still repair the row via the client reference. `sendAutomatedPatientMessage` stops on `PROVIDER_SEND_AMBIGUOUS` instead of falling back to Email (`lib/messaging/automated-send.ts`); the reminders runner keeps the claim and stays silent on ambiguous (lease-expiry retries the same channel). Definite failures still fall back to Email. *Regression:* `tests/unit/lib/p3b-dialog360-adapter.test.ts` (definite→unambiguous, timeout→ambiguous, 2xx-no-id→ambiguous); `tests/unit/lib/p3d-automated-send.test.ts` (definite failure → Email fallback; ambiguous → no fallback; success → stop); `tests/unit/lib/p3a-messaging-send.test.ts` (ambiguous leaves the row queued, no failed finalize, no usage tick); `tests/unit/lib/p3d-reminders.test.ts` (ambiguous keeps the claim, no release/emit).

**P3-M2 — Unread-notification deduplication is race-prone** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* `emitClinicNotification` deduplicated with a SELECT-then-INSERT and no DB constraint, so concurrent emitters could both see no unread row and double-insert.
- *Cycle-3 fix:* `notifications` gains a `dedupe_key text` column and a partial unique index `notifications_recipient_dedupe_unread_idx (recipient_id, dedupe_key) WHERE read_at IS NULL` (`supabase/migrations/20260717150000_p3d_reminders_notifications.sql`). A new `SECURITY DEFINER` `emit_clinic_notifications` RPC inserts one row per recipient in a single statement with `ON CONFLICT (recipient_id, dedupe_key) WHERE read_at IS NULL DO NOTHING` and returns the inserted count. `lib/notifications/emit.ts` now computes a deterministic key (`type|link|sorted dedupeData`) and calls the RPC via `emitClinicNotificationRows` — the SELECT-then-INSERT is gone. Tenant isolation stays explicit: the RPC takes `p_clinic_id` and the composite `(recipient_id, clinic_id)` FK rejects any cross-clinic recipient. *Regression:* `tests/unit/integration/p3d-reminders-notifications.test.ts` → "emit_clinic_notifications atomic dedupe (P3-M2)" fires three concurrent emits and asserts exactly one unread row, that a fresh notification is allowed once the prior is read, and that a foreign-clinic recipient is rejected; `tests/unit/lib/p3d-notification-emit.test.ts` covers the key derivation and RPC wiring.

**P3-M3 — Template state transitions are not enforced atomically** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* four sub-parts — unconstrained resubmit + provider-before-DB ordering; read-then-write edit/delete racing webhooks; approved templates deletable locally without provider deletion; webhooks applying provider states unconditionally.
- *Cycle-3 fix* (all in `actions/messaging.ts`, `lib/messaging/webhooks.ts`, `lib/messaging/whatsapp-dialog360.ts`):
  - **Submit** claims the transition first with one conditional `UPDATE … WHERE channel='whatsapp' AND approval_status IN ('draft','rejected')` (sets `submitted`); only then calls the provider. A provider failure reverts to `draft` (guarded on `approval_status = 'submitted'`); success persists the provider id with a short retry, so a DB blip no longer strands an untracked provider template and a resubmit cannot double-register.
  - **Edit** is one guarded `UPDATE … WHERE approval_status IN ('draft','rejected')` returning the row; a locked template matches nothing (a follow-up existence probe only picks the right error message). No read-then-write window.
  - **Delete** deletes the provider template at 360dialog first (`deleteDialog360Template`, 404 = already gone) whenever a WhatsApp template carries a `provider_template_id`, then performs a guarded local `DELETE … WHERE approval_status <> 'submitted'`. Approved/registered templates are no longer removed locally while still present at the provider.
  - **Webhook** `persistTemplateStatus` gates on a legal-transition map and writes one conditional `UPDATE … WHERE provider_template_id = <id> AND approval_status IN (<legal sources>)`; a stale/late event or a template edited back to draft (provider id detached) matches nothing and is safely ignored rather than regressing newer state.
  - Provider operations stay behind the existing `lib/messaging/whatsapp-dialog360.ts` adapter.
- *Regression:* `tests/unit/actions/p3d-template-actions.test.ts` (guarded edit lock vs not-found, draft/rejected edit detaches provider id, submit guarded-claim + provider-failure revert + resubmit refusal, delete provider-first + provider-failure aborts local delete + submitted-delete refusal, plus a bidi-body rejection); `tests/unit/lib/p3d-webhook-template-status.test.ts` (legal transition applied gated on provider id + source states, stale event ignored as no-op, cross-clinic rejected).

### Low severity

**P3-L1 — Planned Unicode bidi validation was not implemented** — ✅ RESOLVED (cycle 3)
- *Cycle-1/2 claim:* the plan requires bidi-correctness validation (§7.4); `lib/validations/messaging.ts` validated names/variables/placeholders only.
- *Cycle-3 fix:* `lib/validations/messaging.ts` adds `hasUnsafeBidiControls` and a `noBidiControls` zod refinement (message key `validation.unsafeText`, added to `messages/en.json` + `messages/ar.json`) applied at the **shared** validation boundary — the template `name`/`body` and the inbox reply `body`/`templateParameters`, so it covers server actions, not just the UI. It rejects the embedding/override/isolate controls and the deprecated marks (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F/U+061C) while leaving normal Arabic/English text, digits, tatweel, and whitespace untouched. *Regression:* `tests/unit/lib/p3d-bidi-validation.test.ts` (all twelve controls flagged; Arabic/English/digit/newline content accepted; schema-level rejection of a bidi body and acceptance of Arabic) plus a bidi-body case in `tests/unit/actions/p3d-template-actions.test.ts`.

---

## Verification (cycle 2, current tree)

- `npx tsc --noEmit` — clean
- `npm test` — 768/768 (143 files)
- `npm run test:integration` (local Supabase) — 124/124 (17 files)
- `npm run test:e2e:p3c` — 1/1
- `npm run lint` — 0 errors; no warnings in Phase 3 files
- Finding-by-finding source inspection at the file:line references above

## Checklist

| ID | Severity | Status | Blocks merge |
|---|---|---|---|
| P3-H1 | High | ✅ Resolved (cycle 2 — SMS removal + email auto-provisioning) | — |
| P3-H2 | High | ✅ Resolved (cycle 3 — SQL candidate exclusion) | — |
| P3-H3 | High | ✅ Resolved (cycle 3 — recoverable lease + finalize) | — |
| P3-M1 | Medium | ✅ Resolved (cycle 3 — ambiguous-outcome, no cross-channel fallback) | — |
| P3-M2 | Medium | ✅ Resolved (cycle 3 — partial unique index + atomic emit RPC) | — |
| P3-M3 | Medium | ✅ Resolved (cycle 3 — guarded transitions + provider-first delete) | — |
| P3-L1 | Low | ✅ Resolved (cycle 3 — shared bidi validation) | — |

All seven findings are resolved. The fix cycle changed no product decision and no billing vocabulary, kept automated delivery on `sendMessage()`, and preserved tenant isolation and the adapter boundary. Nothing is committed; all work remains on `feat/p3a-messaging-core` pending re-reviewer sign-off.
