# P5B — Inbox AI Integration & Booking Flows

**Date:** 2026-07-27
**Branch:** `feat/p5a-patient-tools-booking` (P5B layered on the delivered P5A + review fixes)
**Status:** Implemented and validated.
**Roadmap:** `docs/AI_AGENT_PLAN.md` — P5/P5B (§6.2, §5.4, §6.5, §6.6, §6.7, §9.4, §12-HP).
**Builds on:** `docs/reports/P5A_IMPLEMENTATION.md`, `docs/reviews/P5A_REVIEW.md`, `docs/reports/P5A_FIXES.md`.

---

## 1. Scope delivered

P5B connects the P5A patient AI foundation to the live P3 WhatsApp inbox without weakening any existing boundary:

- inbound WhatsApp message → certified P5A patient agent, invoked from the existing webhook;
- per-clinic **suggest** and **auto** reply modes, with `auto` behind its own `ai.patient_auto` entitlement gate;
- deterministic **human escalation / handoff** (emergency, explicit human request, medical, complaint, low confidence) with ar/en canned safety copy and a local emergency number by clinic country;
- **booking confirmation flow** — the agent creates only P5A pending bookings and tells the patient staff will confirm; staff confirmation reuses the shipped `updateAppointmentStatus` → `notifyAppointmentEvent` path;
- inbox **suggested-reply** approve / edit / dismiss UX + an escalation banner with a "return to AI" control;
- **FAQ content management UI** and a **reply-mode setting** in a new `/settings/patient-ai` surface;
- inbox notification emitters for AI suggestions and escalations;
- unit, integration (live DB), security/RLS, messaging, and UI tests, plus ar/en copy and RTL-safe UI.

No P5A tool-authorization change, no `pro_ai` catalog change beyond what P5A shipped, no P6 work, and no unrelated refactor was made.

## 2. Reply-mode resolution and the auto safety gate

`lib/ai/patient-reply-mode.ts` resolves the mode a turn actually runs in, fail-closed:

- new `clinics.ai_reply_mode` column (`off` / `suggest` / `auto`, default `off` — patient AI is opt-in);
- `off`, no active subscription, no `ai_assistant`, or no `ai.patient_suggest` → **off** (no drafting);
- clinic column `auto` **without** `ai.patient_auto` → **downgraded to suggest** — the §P5/§12 safety gate: the clinic toggle can never turn on automatic replies by itself;
- `auto` is honored only when `ai.patient_auto` is entitled (still `false` on the P5A `pro_ai` catalog, so `auto` is inert until an operator enables it per clinic).

The same gate is enforced twice: in the orchestrator at runtime and in the `setPatientAiReplyMode` settings action, which refuses `auto` without the entitlement.

## 3. Patient reply orchestrator

`lib/ai/patient-reply.ts` (`runPatientInboundAiReply`) is the single wiring point between the webhook and the agent. It is strictly best-effort — every failure degrades to a human and never fails the webhook (§6.7):

1. resolve effective mode; `off` → no-op.
2. load the conversation; skip if not `open` or already escalated (an escalated thread stays with the human until staff clear it).
3. deterministic escalation pre-check on the raw inbound message (`lib/ai/patient-escalation.ts`), before any model call:
   - **emergency** → send the ar/en safety response immediately (local emergency number by `clinics.country` + clinic phone), regardless of mode;
   - **human request / medical / complaint** → escalate; `auto` sends a canned handoff, `suggest` leaves it as a one-click staff suggestion;
   - each escalation stamps `conversations.ai_escalated_at` + `ai_escalation_reason` (once) and emits an `ai_escalation` staff notification.
4. otherwise run the certified P5A patient agent (`createPatientAgent`) through the shared P4.5 execution/budget lifecycle (`prepareAiExecution`, `surface: patient_messaging`, persona `patient`, task `patient_booking` when `ai.scheduling` is entitled else `patient_faq`). The conversation UUID remains the content-free patient actor key.
5. empty / failed model output → escalate `low_confidence`.
6. **suggest** → record a `pending` `ai_suggested_replies` row + emit `ai_suggestion`; **auto** → send through the single `sendMessage` boundary and record the row as `sent` with the outbound id; a failed auto-send leaves the draft pending and escalates.

The agent's outbound reply is written only to `outbound_messages` (never `inbound_messages`), so there is no reply loop — the webhook only fires the agent on inbound turns.

## 4. Webhook wiring

`lib/messaging/webhooks.ts` calls `runPatientInboundAiReply` once per newly-persisted inbound message (never on replays), inside a `try/catch` that captures to Sentry and never fails the webhook. The existing `inbox_message` staff notification remains the guaranteed fallback, so a disabled mode, missing entitlement, or agent failure always leaves staff aware of the message.

## 5. `ai_suggested_replies` and escalation state (migration)

`supabase/migrations/20260728120000_p5b_inbox_ai_booking.sql` (additive, applies cleanly on the full stack):

- `clinics.ai_reply_mode` (`off`/`suggest`/`auto`, default `off`);
- `conversations.ai_escalated_at`, `ai_escalation_reason` (bounded enum-in-check), `ai_last_replied_at`;
- `ai_suggested_replies` — one row per AI draft (`pending`/`sent`/`dismissed`/`superseded`), with a partial unique index enforcing **one pending suggestion per conversation** (a new turn supersedes the prior draft), a same-clinic composite FK to `conversations`, and `updated_at`;
- RLS: **read-only** for the inbox roles (`admin`/`receptionist`), exactly matching the conversation read policy. There is **no authenticated write policy** — every write goes through the reviewed service-role paths (the orchestrator records suggestions; the approve/dismiss actions mutate through the clinic-scoped admin client), the same posture as `conversations`/`outbound_messages`;
- the table is added to the `supabase_realtime` publication so drafts and auto-sends appear live in the inbox under RLS.

`types/database.ts` was hand-updated surgically (per the local-regen-drift note) for the new table and columns.

## 6. Inbox UI

`components/inbox/inbox-shell.tsx` and `lib/messaging/inbox.ts`:

- the pending suggestion for the selected conversation is loaded (RLS client) and rendered as a card with **Approve & send**, **Edit** (send an edited body), and **Dismiss**;
- an **escalation banner** shows the (localized) handoff reason with a **Return to AI** control;
- `loadInboxData` now also surfaces per-conversation `identity_verified_at` (fixing the previously-hardcoded verified badge) and escalation state;
- the realtime subscription includes `ai_suggested_replies`.

Server actions in `actions/messaging.ts`:

- `approveAiSuggestion` — claims the pending suggestion (so two staff cannot double-send), sends through the single `sendMessage` boundary (window rules, usage caps, `outbound_messages` record — identical to a manual reply), and records the outcome; releases the claim on any send failure;
- `dismissAiSuggestion`, `clearConversationEscalation` — role-gated (`admin`/`receptionist`) inbox controls.

## 7. FAQ content management + reply-mode settings

- new `/settings/patient-ai` page (primary-admin + `ai.patient_suggest`-gated), nav entry, and `PatientAiSettingsPanel` client component;
- reply-mode selector (`auto` disabled without `ai.patient_auto`) and full clinic-FAQ CRUD (`clinic_faq`, admin-only, service-role writes — the same posture as message templates);
- `actions/patient-ai.ts` (`setPatientAiReplyMode`, `savePatientFaq`, `deletePatientFaq`) and `lib/ai/patient-faq-settings.ts` loader; `clinic_faq` added to the clinic-scoped admin allow-list.

## 8. Preserved boundaries

- **P5A tool authorization** — unchanged; the orchestrator only *drives* the certified agent and mounts nothing new.
- **P3 messaging** — all sends (agent, auto, approved suggestion) go through the single `sendMessage` boundary; the 24-hour window, usage caps, and `outbound_messages` recording are untouched.
- **P4/P4.5 AI platform & billing** — patient turns reserve/reconcile against the shared immutable ledger via `prepareAiExecution`; one AI turn = one `ai_messages` unit; the conversation UUID stays the content-free actor key.
- **Tenant isolation / RLS** — `ai_suggested_replies` is read-only to the owning clinic's inbox roles and service-role-write-only; the scoped admin client keeps every write clinic-bound; `clinics` (no `clinic_id` column) is read/written by primary key through dedicated admin helpers, keeping the scoped-client allow-list invariant intact.
- **Audit / idempotency** — escalations and replies write content-minimized `agent_tool:*` audit rows; the webhook de-dupes replays; the single-pending index and the approve-claim prevent duplicate drafts/sends.

## 9. Files changed

### Added
- `supabase/migrations/20260728120000_p5b_inbox_ai_booking.sql`
- `lib/ai/patient-reply.ts`
- `lib/ai/patient-reply-mode.ts`
- `lib/ai/patient-escalation.ts`
- `lib/ai/patient-faq-settings.ts`
- `actions/patient-ai.ts`
- `app/(protected)/settings/patient-ai/page.tsx`
- `components/settings/patient-ai-settings.tsx`
- `tests/unit/ai/p5b-patient-escalation.test.ts`
- `tests/unit/ai/p5b-patient-reply.test.ts`
- `tests/unit/db/p5b-inbox-ai-migration.test.ts`
- `tests/unit/integration/p5b-inbox-ai-reply.test.ts`
- `tests/unit/components/p5b-inbox-suggestion.test.tsx`
- `docs/reports/P5B_IMPLEMENTATION.md`

### Modified
- `lib/messaging/webhooks.ts` (agent wiring)
- `lib/messaging/inbox.ts` (suggestion + escalation + identity surfacing)
- `lib/messaging/patient-copy.ts` (canned escalation copy)
- `actions/messaging.ts` (approve/dismiss/clear-escalation actions)
- `components/inbox/inbox-shell.tsx` (suggestion card + escalation banner)
- `components/settings/settings-nav.tsx` (Patient AI nav entry)
- `components/notifications/notifications-list.tsx` (new notification types)
- `lib/notifications/emit.ts` (`ai_suggestion`, `ai_escalation` types)
- `lib/supabase/admin.ts` (`getClinicAiReplyContext`, `setClinicAiReplyMode`, allow-list: `ai_suggested_replies`, `clinic_faq`)
- `types/database.ts` (new table + columns)
- `messages/en.json`, `messages/ar.json`, `messages/action-errors/en.json`, `messages/action-errors/ar.json`
- `tests/unit/components/p3c-inbox-shell.test.tsx` (new required inbox fields)

## 10. Test coverage

- deterministic escalation detection (emergency/human/medical/complaint) in ar/en, priority ordering, and non-escalation of ordinary logistics; emergency-number-by-country mapping;
- effective reply-mode resolution incl. the `auto`→`suggest` downgrade without `ai.patient_auto` and off-without-entitlement;
- canned copy carries the emergency + clinic phone and degrades gracefully with no phone;
- orchestrator behavior with a mocked LLM: disabled/skip logic, suggest records-pending-and-notifies-without-sending, auto sends-and-records, emergency-always-sends-even-in-suggest, human-request escalation, low-confidence escalation, already-escalated/closed skip, agent-throw degradation, and FAQ-task routing without scheduling;
- live-DB integration: a real suggest run records a pending suggestion linked to the inbound message; an emergency stamps the conversation handoff reason; `ai_suggested_replies` tenant isolation (owning inbox reads, cross-tenant denied) and service-role-write-only posture (authenticated + anonymous inserts rejected);
- migration/type-surface assertions;
- inbox UI: suggestion card render + approve action, escalation banner + return-to-AI, and no cross-conversation suggestion leakage.

## 11. Validation results

| Check | Result |
|---|---|
| Clean local migration-stack rebuild (incl. P5B) | Pass |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 24 pre-existing warnings in unrelated files |
| `pnpm lint:i18n` | Pass — 320 files; 14 documented exceptions |
| `pnpm lint:rtl` | Pass — 466 files; 10 documented exceptions |
| `pnpm i18n:missing` | Pass — 3,041 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| Full test suite (unit + live integration/RLS) | Pass — 270 files, 2,066 tests |
| Focused P5B suite (escalation/reply/migration/integration/UI) | Pass — 5 files, 42 tests |
| `pnpm build` | Pass — production build; 70 pages (adds `/settings/patient-ai`) |
| `git diff --check` | Pass |

## 12. Explicit non-goals (kept out)

No P6 work; no prompt-injection/eval suite (P6A); no payments over WhatsApp; no rescheduling negotiation; no change to P5A tool authorization, booking caps/TTL, or identity gating; no `ai.patient_auto` catalog enablement (it remains operator-gated per clinic); no unrelated refactor. Review, commit, push, merge, and P6 were intentionally not performed.
