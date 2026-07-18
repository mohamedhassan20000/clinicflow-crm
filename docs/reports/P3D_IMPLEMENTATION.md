# P3D Implementation Report — Reminders, Follow-ups, Templates & Notification Center

**Date:** 2026-07-17  
**Branch:** `feat/p3a-messaging-core` (continued in place, as with P3B/P3C)  
**Plan reference:** `docs/AI_AGENT_PLAN.md` §7 (7.1–7.6), P3D execution split (§8)  
**Status:** Complete; ready for review  
**Scope:** P3D only

## Outcome

P3D delivers the automated-send and staff-awareness layer defined in the plan:

- **Vercel Cron routes** (§7.1): `GET /api/cron/reminders` and `GET /api/cron/invoice-followups`, both `CRON_SECRET`-bearer-guarded (fx-rates precedent), registered in `vercel.json` (hourly at `:00` / `:30`). Failures return 503 with no internal detail and report to Sentry.
- **Confirmed-appointment reminders** (§7.2): per-clinic `clinics.reminder_offsets int[] DEFAULT '{24,3}'` (validated 1–168h, 1–5 entries) generalizing the dormant `reminder_lead_hours`; per-offset `appointments.reminders_sent jsonb` markers; sends through `lib/messaging/send.ts` in the clinic's language and timezone; legacy `reminder_sent_at` still stamped on the first send.
- **Invoice follow-up sequences** (§7.3): `followup_sequences` state machine (D0 → D+3 → D+7 anchored on the invoice date, max 3 messages) created when `updateAppointmentStatus` completes billing with an outstanding balance, advanced only by the cron, stopping on **settled / cancelled / opted_out / completed**.
- **Template management UI** (§7.4): `/settings/templates` (Admin/Manager, existing settings CRUD pattern) — create/edit/delete per-clinic templates in either language, variables validated against the allowed set, WhatsApp submission through the P3B `submitWhatsAppTemplate` sync with `draft → submitted → approved/rejected` tracked from the P3B webhook.
- **Notification center** (§7.5 + the approved P3D UX requirement): `notifications` table (tenant- and user-scoped, RLS'd), a **bell with an unread badge in the authenticated clinic header** that **navigates to the dedicated `/notifications` page**, read/unread state with per-item **mark as read** and **mark all as read**, Supabase Realtime badge refresh, existing design system throughout. Emitters wired: new inbound patient message (assignee, or Admin+Receptionist fan-out), reminder send failure, follow-up send failure — each deduped while unread.

All P3A–P3C behavior (channel abstraction, entitlements/usage caps, 24-hour-window enforcement, webhook lifecycle, inbox) is preserved; automated sends go through the same `sendMessage()` boundary as manual replies.

## Key design decisions (for review)

1. **Idempotency is a recoverable claim-before-send lease** *(revised in cycle 3 — P3-H3)*. `claim_appointment_reminder` writes a `{state:"claimed",at}` lease on one `(appointment, offset)` under a row lock before any dispatch, so overlapping cron runs cannot double-send. A send is recorded **only** by `finalize_appointment_reminder` after a successful dispatch; a definite failure **releases** the claim (retry next run, with a per-appointment-deduped admin alert); an **ambiguous** provider outcome keeps the claim (no cross-channel fallback, no alert); and a claim left stale by a crash becomes re-claimable after a 15-minute lease, so a reminder is never permanently suppressed. See the cycle-3 addendum.
2. **Multiple overdue offsets send one message.** After cron downtime, all overdue offsets are claimed but only the nearest produces a message — a patient never receives a burst of stale reminders.
3. **Channel fallback lives in `lib/messaging/automated-send.ts`.** `sendMessage` owns entitlements/caps/recording, but the recipient address differs per channel and WhatsApp business-initiated sends require an approved template, so the runner tries WhatsApp → Email explicitly. WhatsApp uses the clinic's approved `appointment_reminder` / `invoice_followup` template (clinic-language variant preferred); email uses built-in ar/en copy in `lib/messaging/patient-copy.ts` (content data, clinic-locale — never a staff UI locale). The email attempt provisions its tenant-scoped Resend channel through `sendMessage` when no channel row exists.
4. **Minimal PHI (§5.4):** reminder bodies carry patient name, clinic, doctor, date/time only; follow-up bodies state that a balance exists **without any amount**, and no diagnosis/notes ever enter a message.
5. **Notifications fan out to concrete recipients at emit time, deduped in the database** *(dedup hardened in cycle 3 — P3-M2)*. The schema keeps the plan's nullable `recipient_id` (role-broadcast rows remain possible later), but P3D emitters always materialize per-recipient rows so read state is a per-row `read_at`. Deduplication is enforced by a partial unique index `(recipient_id, dedupe_key) WHERE read_at IS NULL` and a single-statement `emit_clinic_notifications` RPC (`ON CONFLICT DO NOTHING`), replacing the original SELECT-then-INSERT — concurrent emitters can no longer double-insert. See the cycle-3 addendum.
6. **Fail-closed write posture (P3A precedent):** `notifications` has recipient-only SELECT RLS and **no authenticated write policies** — emit and mark-as-read go through reviewed service-role paths always constrained to the caller's own rows. `followup_sequences` has RLS enabled with **no policies at all** (cron/server state only; P3D ships no UI that reads it).
7. **Follow-up send failures count as the attempt** (no claim revert): dunning is bounded-messages-first, and the admin is notified. Reminder failures, by contrast, release and retry — a reminder that never arrives has no value later, but one that arrives late still does.
8. **The templates settings page reads through the clinic-scoped service-role boundary** because the settings surface is Admin/Manager while the P3C content-table RLS is Admin/Receptionist (the `/settings/messaging` precedent). Submitted/approved templates are locked against edit (provider desync) and submitted ones against delete; editing a rejected template returns it to `draft` and detaches `provider_template_id`.

## Migration

`supabase/migrations/20260717150000_p3d_reminders_notifications.sql` (new file; the P3A migration is untouched):

- `clinics.reminder_offsets` + `valid_reminder_offsets()` check; `appointments.reminders_sent` + object check; `idx_appointments_reminder_offsets` partial index (the baseline `idx_appointments_reminder` filters on `reminder_sent_at IS NULL`, which stops matching after the first offset fires); `appointments (id, clinic_id)` unique anchor for composite FKs.
- `followup_sequences` (unique per appointment, tenant-composite FK, step 0–3, stopped-reason consistency check, partial due index; deny-all RLS).
- `notifications` (tenant-composite recipient FK, in-app-path-only `link` check, `data jsonb` for render inputs, unread/recency indexes; recipient-only SELECT policy; added to the `supabase_realtime` publication).
- `claim_appointment_reminder` / `release_appointment_reminder` — SECURITY DEFINER, `SET search_path = ''`, `service_role`-only EXECUTE (P3A/P3C RPC conventions).

`supabase db reset` — pass; all migrations apply from a clean database. `types/database.ts` extended by hand in generated style (the `db:types` script targets the remote project).

## Files

### Added

- `app/api/cron/reminders/route.ts`, `app/api/cron/invoice-followups/route.ts`
- `app/(protected)/notifications/page.tsx`, `app/(protected)/notifications/loading.tsx`
- `app/(protected)/settings/templates/page.tsx`
- `components/notifications/notification-bell.tsx`, `components/notifications/notifications-list.tsx`
- `components/settings/message-templates-manager.tsx`
- `lib/messaging/reminders.ts`, `lib/messaging/followups.ts`, `lib/messaging/automated-send.ts`, `lib/messaging/patient-copy.ts`
- `lib/notifications/emit.ts`, `lib/notifications/queries.ts`
- `actions/notifications.ts`
- `supabase/migrations/20260717150000_p3d_reminders_notifications.sql`
- Tests: `tests/unit/api/p3d-cron-routes.test.ts`, `tests/unit/lib/p3d-automated-send.test.ts`, `tests/unit/lib/p3d-reminders.test.ts`, `tests/unit/lib/p3d-followups.test.ts`, `tests/unit/actions/p3d-template-actions.test.ts`, `tests/unit/actions/p3d-notification-actions.test.ts`, `tests/unit/components/p3d-notification-bell.test.tsx`, `tests/unit/integration/p3d-reminders-notifications.test.ts`
- `docs/reports/P3D_IMPLEMENTATION.md`

### Updated

- `actions/appointments.ts` (billing-completion hook → `ensureInvoiceFollowupSequence`, best-effort, never fails billing)
- `actions/messaging.ts` (template CRUD: `saveMessageTemplate`, `deleteMessageTemplate`)
- `lib/messaging/webhooks.ts` (inbound-message notification emitter)
- `lib/supabase/admin.ts` (table classifications: `notifications`, `followup_sequences`; reviewed cron boundaries: `listReminderCandidateAppointments`, `listDueFollowupSequences`, `getClinicReminderSettings`, `claimAppointmentReminder`, `releaseAppointmentReminder`)
- `lib/validations/messaging.ts` (`messageTemplateSchema` with §7.4 variable allow-list + placeholder validation, delete/notification-id schemas)
- `lib/supabase/middleware.ts` (`/notifications` protected prefix)
- `app/(protected)/layout.tsx` (unread count + bell in the header slot)
- `components/settings/settings-nav.tsx`, `components/settings/settings-page-header.tsx` (Templates entry)
- `messages/en.json`, `messages/ar.json`, `messages/action-errors/en.json`, `messages/action-errors/ar.json`
- `vercel.json` (two new crons)
- `types/database.ts`

## Tests added

- **Cron routes (10):** missing/wrong/unset secret → 401 without running; correct secret runs and reports the summary; a throwing run returns 503 and reaches Sentry.
- **Automated delivery:** WhatsApp is attempted first, email fallback is attempted second, email works directly without a WhatsApp template/phone, and a successful WhatsApp send stops fallback.
- **Reminders (6):** claims every due offset but sends one message; already-marked offsets skipped (idempotency); outside-window appointments untouched; a lost claim race sends nothing; all-channel failure releases claims and emits one deduped admin notification; the approved clinic-language WhatsApp template and variable values reach dispatch.
- **Follow-ups (7):** settled and cancelled stops without sending; D0 claim advances the step and schedules D+3 from the invoice date; third message stops with `completed`; claim race skips; all-channel failure emits a per-appointment-deduped admin notification; `ensureInvoiceFollowupSequence` upserts idempotently.
- **Template actions (8):** clinic-scoped draft creation; WhatsApp name contract, undeclared placeholders, and out-of-allow-list variables rejected; submitted/approved edit lock; rejected-edit returns to draft and detaches the provider id; submitted-delete refusal.
- **Notification actions (4):** mark-as-read constrained to the caller's own unread row; malformed id rejected without writing; write failure surfaced; mark-all scoped to the caller.
- **Bell component (3):** navigates to `/notifications`, exact badge count with accessible name, 99+ cap.
- **Integration, local Supabase (12):** recipient-only notification reads (same clinic is not enough), cross-clinic and anonymous denial, authenticated write/mark-as-read denial at the RLS layer; `followup_sequences` invisible and unwritable for every authenticated session; claim RPC true-then-false with marker/stamp verification, release-and-reclaim, cross-clinic refusal, authenticated-caller refusal; `{24,3}` default, out-of-range offsets rejected, stopped-without-reason rejected.

## Validation

- `supabase db reset` — pass; all migrations apply from a clean database.
- `supabase db lint --local --level warning` — pass; only the two pre-existing `v_service_id` warnings in legacy billing RPCs.
- Full unit/component suite — **142 files, 769 tests passed** (was 136/731 after P3C).
- Full integration suite — **17 files, 124 tests passed** (was 16/112).
- `pnpm typecheck` — pass.
- `pnpm lint` — pass; 0 errors, 26 pre-existing warnings (none added).
- `pnpm lint:rtl`, `pnpm lint:i18n`, `pnpm i18n:missing`, `pnpm i18n:unused` — all pass.
- `pnpm build` — pass; `/notifications`, `/settings/templates`, `/api/cron/reminders`, `/api/cron/invoice-followups` all in the production route output.
- `git diff --check` — pass.

## Deferred / out of scope (per the P3 execution split)

- **AI escalation and subscription-event notification emitters** (§7.5 list) arrive with their features (P5B, billing phase); the notification center renders unknown types generically already.
- **Patient opt-out capture** has no schema anywhere in P3; the `opted_out` stop reason is supported by the state machine for staff/ops use, but no patient-facing opt-out flow was added (belongs to the patient-channel AI phases).
- **Cross-device durable read receipts for the inbox** remain the P3C device-local model; the notification center's `read_at` is per-recipient-row and fully durable.
- **Operator delivery-health widgets** (P1D placeholders) and fleet-scale delivery alerting remain P6B.
- Hourly cron granularity means an offset can fire up to ~1h late; per-minute cron is a paid-plan toggle documented in §7.1 and needs no code change.
- Production must provision `CRON_SECRET` (already in `.env.example`) alongside the P3A/P3B messaging env vars; a live provider smoke of the automated sends remains an operational deployment check.

## Cycle-3 review fixes (2026-07-18)

The P3 phase review (`docs/reviews/P3_PHASE_REVIEW.md`) opened six findings against the automated-send and awareness layer. All are resolved with minimal changes; the product decisions, the `sendMessage()` lifecycle, tenant isolation, and the adapter boundary are unchanged. The P3D migration was amended in place (it exists only on this uncommitted branch), so `supabase db reset` still applies everything from clean.

- **P3-H2 (reminder starvation).** New `list_reminder_candidates(p_now, p_horizon, p_limit)` `SECURITY DEFINER` RPC replaces the raw earliest-1,000 select in `listReminderCandidateAppointments`. It admits only appointments with ≥1 **actionable** offset via an `EXISTS` over the clinic's `reminder_offsets` and the shared `reminder_offset_actionable(entry, now)` predicate, so fully-reminded rows never occupy the bounded window.
- **P3-H3 (interrupted claim loss).** `reminders_sent` entries are now `{state,at}` leases. `claim_appointment_reminder` writes `claimed`; the new `finalize_appointment_reminder` writes the terminal `sent` (and the legacy `reminder_sent_at`) only after a successful dispatch; `release_appointment_reminder` frees a `claimed` entry only. A stale claim past the 15-minute lease (`REMINDER_CLAIM_LEASE_MS`, mirrored in `reminder_offset_actionable`) is re-claimable. `lib/messaging/reminders.ts` finalizes on success, releases + alerts on definite failure, and keeps the claim silently on ambiguous.
- **P3-M1 (ambiguous WhatsApp → duplicate).** `ProviderSendResult` failure gains `ambiguous?`. The 360dialog `send` flags timeouts and 2xx-without-id as ambiguous; `sendMessage` leaves the row `queued` and returns `PROVIDER_SEND_AMBIGUOUS`; `sendAutomatedPatientMessage` stops rather than falling back to Email. Definite failures still fall back.
- **P3-M2 (notification dedupe race).** `notifications.dedupe_key` + partial unique index + `emit_clinic_notifications` RPC (`ON CONFLICT DO NOTHING`); `lib/notifications/emit.ts` computes a deterministic key and calls the RPC through `emitClinicNotificationRows`.
- **P3-M3 (template transitions).** Submit/edit/delete are single guarded conditional `UPDATE`/`DELETE`s; submit claims `submitted` before the provider call and reverts on failure; delete removes the provider template first (`deleteDialog360Template`); the webhook `persistTemplateStatus` gates on `provider_template_id` + legal source states. (Primary code in `actions/messaging.ts`, `lib/messaging/webhooks.ts`, `lib/messaging/whatsapp-dialog360.ts` — the P3B surfaces; recorded here for the consolidated cycle.)
- **P3-L1 (bidi validation).** `noBidiControls`/`hasUnsafeBidiControls` in `lib/validations/messaging.ts`, applied to template and inbox-reply text; `validation.unsafeText` added to en/ar.

**Migration delta (`supabase/migrations/20260717150000_p3d_reminders_notifications.sql`):** `reminder_offset_actionable`, `finalize_appointment_reminder`, `list_reminder_candidates`, `emit_clinic_notifications` functions; `notifications.dedupe_key` column + `notifications_recipient_dedupe_unread_idx`; `claim`/`release` reminder RPCs rewritten for lease semantics. `types/database.ts` extended by hand for the new columns/functions.

**Tests added/updated:** `tests/unit/lib/p3d-reminders.test.ts` (lease/finalize/ambiguous/stale recovery), `tests/unit/lib/p3d-automated-send.test.ts` (definite→fallback, ambiguous→stop, success→stop), `tests/unit/lib/p3a-messaging-send.test.ts` (ambiguous leaves row queued), `tests/unit/lib/p3b-dialog360-adapter.test.ts` (ambiguity classification), `tests/unit/lib/p3d-notification-emit.test.ts` (dedupe key + RPC), `tests/unit/lib/p3d-webhook-template-status.test.ts` (transition guard), `tests/unit/lib/p3d-bidi-validation.test.ts`, `tests/unit/actions/p3d-template-actions.test.ts` (rewritten for guarded transitions + provider-first delete + bidi), `tests/unit/integration/p3d-reminders-notifications.test.ts` (lease RPCs, >1,000-row starvation guard, concurrent notification dedupe).

**Cycle-3 validation:** `tsc --noEmit` clean; `lint` 0 errors; `npm test` 799/799; `test:integration` 130/130; `test:e2e:p3c` 1/1; `supabase db reset` clean.

## Repository state

Nothing was committed, pushed, merged, or opened as a pull request. All P3A–P3D work remains uncommitted on `feat/p3a-messaging-core` for review.

---

## Addendum — 2026-07-18 event-driven revision

Supersedes the cron-centric notification model above where they conflict. Roadmap: `docs/AI_AGENT_PLAN.md` §7.1–§7.3c (2026-07-18 revision) and the new **P7 — System Templates & Document Engine**.

**What changed**

- **Event-driven appointment notifications (§7.2a).** Immediate WhatsApp+Email on appointment **created / confirmed / rescheduled / cancelled**, dispatched inline from the appointment mutations via `lib/messaging/appointment-notifications.ts` → the existing `sendAutomatedPatientMessage` boundary (WhatsApp-first, Email fallback). Wired into `createAppointment` (created), `updateAppointmentStatus` (confirmed/cancelled), and `confirmAndDisplaceConflicts` (confirmed). Best-effort; recorded on `outbound_messages`.
- **Daily reminders (§7.2b).** `runAppointmentReminders` rewritten from the per-offset hourly model to **one reminder per confirmed appointment scheduled today or tomorrow** (clinic-local calendar dates), driven by a single daily morning cron. New crash-safe lease on `appointments.reminders_sent -> 'daily'` (RPCs `claim/finalize/release_daily_reminder`, `list_daily_reminder_candidates`). `clinics.reminder_offsets` is retained as inert legacy vocabulary.
- **Reminder settings (§7.2b).** New `clinics.reminders_enabled` (default true) excludes a clinic from the daily run at the SQL layer. New `ReminderSettingsCard` on `/settings/messaging` + `updateReminderSettings` action, with a description explaining the daily WhatsApp+Email behavior (en/ar).
- **Event-driven invoice delivery (§7.3a).** On billing completion, `deliverIssuedInvoice` sends the invoice immediately via WhatsApp+Email. **Template-agnostic** (`compose summary → render message → send`) using the existing appointment/billing representation — the professional document, PDF/print, and serial numbering are deferred to **P7**. The former D0 cron notice is removed.
- **Single daily cron.** The hourly `reminders`/`invoice-followups` crons are replaced by one daily morning cron (`vercel.json`: `fx-rates` + `/api/cron/reminders` at `0 6 * * *`, within the Hobby 2-cron limit). The reminders route now runs both jobs via `Promise.allSettled`; the `invoice-followups` route is deleted. Dunning shifts to **D+3 → D+7** (2 messages).

**Migration:** the P3D flow ships as a single squashed migration `supabase/migrations/20260718120000_p3d_event_driven_notifications.sql` (see the 2026-07-19 addendum for its final contents; the 20260717 migration is untouched).

**Validation:** `tsc --noEmit` clean; eslint 0 errors; unit `805/805`; P3D + P3A integration suites pass against a fresh `supabase db reset` local DB.

**Known remaining P3 item:** the `rescheduled` event emitter is implemented and ready, but has **no trigger yet** — the product has no appointment-reschedule flow / `rescheduled` status today (deferred to a later migration per §7.2a). When that flow lands, it calls `notifyAppointmentEvent({ …, event: "rescheduled" })` — no other change needed.

---

## Addendum — 2026-07-19 messaging flow refinements

Four approved product-flow changes on top of the event-driven direction. Roadmap: §7.2a, §7.3a, §7.3b, §7.6a (2026-07-19 revision).

**1. Independent channels.** `lib/messaging/automated-send.ts` was rewritten from a WhatsApp-first fallback into `dispatchPatientMessage`, which attempts **Email whenever the patient has an address** and **WhatsApp only when the clinic has an active integration** (`hasActiveWhatsAppChannel`), independently — one channel never blocks the other, and partial success is normal. Applies to appointment notifications, reminders, invoice delivery, and dunning.

**2. Manual invoice send.** The automatic `deliverIssuedInvoice` call was removed from `updateAppointmentStatus`. New action `sendInvoiceToPatient(appointmentId)` (admin/receptionist) + a **"Send to patient"** button with a confirmation dialog (`components/appointments/send-invoice-button.tsx`, mounted in the completed-invoice view of `appointment-payment-row.tsx`). `deliverIssuedInvoice` now returns the per-channel result so the UI reports what was delivered. The template-agnostic `compose → render → send` seam is unchanged (P7 still plugs in).

**3. Configurable overdue-invoice reminders.** Hardcoded D+3/D+7 replaced by per-clinic config (`clinics.invoice_followups_enabled`, `invoice_followup_first_days`, `invoice_followup_second_days`, `invoice_followup_email_subject`, `invoice_followup_email_body`). `runInvoiceFollowups` reads them (paused clinics are skipped, not stopped); the email subject/body override the built-in copy, WhatsApp uses the clinic's `invoice_followup` template. New `InvoiceFollowupSettingsCard` + `updateInvoiceFollowupSettings` action on `/settings/messaging` (en/ar).

**4. Per-channel idempotency.** New `message_dispatches` ledger + `claim/finalize/release_message_dispatch` RPCs. Each `(clinic, dedupe_key, channel)` is claimed before send, finalized only on provider acceptance, released on definite failure; a duplicate is never sent and only the failed channel retries. This **replaces** the intermediate `reminders_sent 'daily'` lease idea — idempotency is now per channel.

**Migration (squashed):** because none of this P3D work had shipped, the two working migrations were squashed into one — `supabase/migrations/20260718120000_p3d_event_driven_notifications.sql`. It contains `clinics.reminders_enabled`, the `clinics.invoice_followup_*` columns, the `message_dispatches` table + RPCs, and the final `list_daily_reminder_candidates`. The short-lived `claim/finalize/release_daily_reminder` RPCs are never created (they were only ever an uncommitted intermediate step). The 20260717 migration is untouched.

**Validation:** `tsc --noEmit` clean; eslint 0 errors; RTL + i18n gates pass; unit `806/806`; P3D + P3A integration suites pass against a fresh `supabase db reset` local DB.
