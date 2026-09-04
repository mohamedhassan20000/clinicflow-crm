# P8 — WhatsApp Inbox History, Human Handoff, Patient AI Understanding, and Attachments

Status: implemented, tested locally, **not deployed**.
Branch: `feat/p7-manual-qa-polish`.

---

## 1. Root causes

Each item below is what was actually wrong, not a restatement of the request.

### 1.1 No history was imported after QR linking

The worker never subscribed to Baileys' `messaging-history.set` event, and opened
its socket with `syncFullHistory: false`. The phone was pushing a history sync to
the newly linked device and the worker was discarding it unread. There was also no
way to represent an imported message in the application: `persist_whatsapp_inbound`
had no notion of a message that is old, so anything imported would have opened a
24-hour service window, reopened closed threads, notified staff, and been handed to
the patient agent — an import would have read as a flood of new patients.

### 1.2 AI replies looked truncated in the Inbox

`outbound_messages` deliberately stores only `body_preview`: a digit-masked string
capped at 120 characters by `buildBodyPreview` and at 160 by a column constraint
(§9.3 privacy design). The Inbox thread rendered that column. So a reply that WhatsApp
delivered in full appeared cut off at 120 characters to the staff member reading the
same conversation. The UI was innocent — the bubble already used
`whitespace-pre-wrap break-words` with no clamp. **The bug was that the full body was
never stored anywhere.**

The same column was also read back into `loadHistory`, so the agent's own memory of
what it had said was truncated too, which is a plausible contributor to the model
repeating itself across turns.

### 1.3 The patient AI demanded machine date formats

`verify_patient_identity` declared `date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`.
That leaves the model two options: silently reformat the patient's answer (a guess, in
the middle of an identity check), or push the requirement out to the patient. Both
happened. `check_availability` had the same problem with `ISO_DATE_RE`.

### 1.4 An unknown sender hit a dead end

Every scheduling tool called `authorizePatientConversation({ requireLinked: true })`,
which throws `patient_unlinked` when the conversation has no patient record. The tool
wrapper's guidance for that case was *"Escalate to clinic staff."* — so a person trying
to become a patient was told to go away. There was no reachable creation path either:
`createPatientMutation` requires an `AuthedUser` and a user-scoped RLS client, neither
of which exists in a webhook.

### 1.5 No per-conversation AI pause

The only gates were the clinic-wide `ai_reply_mode` and the one-way
`ai_escalated_at` flag. Staff could not take one conversation over, and there was no
protection against the AI and a staff member replying at the same moment.

### 1.6 Attachments were discarded

`messageText()` turned a media message into a `[image]` marker and nothing else. The
bytes were never fetched, there was no table to record them, and no bucket to hold them.

### 1.7 Conversations had no name

`conversations` had `participant_address` and a nullable `patient_id`. WhatsApp's
contact/push name was available on every stanza (`pushName`) and in the contact list,
and was dropped. An unlinked thread rendered as a bare phone number.

---

## 2. Architecture changes

```
  WhatsApp ──▶ worker ──HMAC callback──▶ /api/webhooks/whatsapp/linked-device ──▶ pipeline ──▶ Inbox
                 │                                                                    │
                 └── history.ts / media.ts (new)                   inbound_message_attachments (new)
                     · direct chats only                           conversations.display_name (new)
                     · sniffed mime types                          conversations.ai_paused_at (new)
                     · Supabase Storage upload                     outbound_messages.body (new)
```

**Worker.** Two new modules. `history.ts` interprets a `messaging-history.set` payload
into the same event vocabulary the live path already uses, reusing `classifyJid` so the
two can never disagree about what a patient conversation is. `media.ts` downloads,
size-checks, byte-sniffs and uploads one attachment, and never throws. The session
manager subscribes to the history event (buffering batches that arrive before the socket
reports its own number), learns contact names into a new `NameDirectory`, and fetches
attachments with bounded concurrency before handing the batch over.

**Callback contract.** Two new event kinds (`history_chat`, `history_progress`), and
three new optional fields on the existing ones (`displayName`, `historical`,
`attachments`). Batched at 100 events per POST so an import is a series of
ordinary-sized signed requests rather than one multi-megabyte one.

**Application.** Every field of the callback is rebuilt rather than passed through.
Historical events take a deliberately inert path: persisted, but no service window, no
status change, no notification, no agent turn. `history_chat` opens a thread through a
new RPC so a conversation the clinic only ever *sent* into still appears.

**Full outbound body.** `outbound_messages.body`, constrained by
`related_type = 'manual'` — inbox threads only. Reminders, invoice follow-ups and every
analytics path keep `body_preview` alone, so §9.3 is narrowed in scope rather than
weakened.

**Human input.** One deterministic module, `lib/ai/human-input.ts`, called by the tools.
The model passes the patient's words through untouched and receives a canonical value or
a specific reason. No language model is ever asked to normalize a date that an identity
check will be run against.

**Registration.** One `SECURITY DEFINER` boundary,
`register_patient_from_conversation`, owning duplicate detection, file numbering, the
patient row and the conversation link in one transaction. It takes no phone number and
no patient id.

**Attachments.** Private bucket `whatsapp-inbound` with *no* `authenticated` storage
policy at all: the only read path is a server-minted 5-minute signed URL for a path
already proved to be the caller's clinic.

---

## 3. Files changed

### New

| File | What it is |
| --- | --- |
| `supabase/migrations/20260818120000_p8_whatsapp_history_takeover_attachments.sql` | Every schema and RPC change below |
| `services/whatsapp-worker/src/history.ts` | History-sync interpretation, and the platform limits, documented |
| `services/whatsapp-worker/src/media.ts` | Attachment download, byte sniffing, size caps, safe paths |
| `lib/messaging/attachments.ts` | Signed-URL minting and bounded server-side reads |
| `lib/ai/human-input.ts` | Dates, times, phones, names, ids, emails as people write them |
| `lib/ai/tools/register-patient.ts` | The WhatsApp registration tool |
| `components/inbox/message-attachments.tsx` | Attachment rendering in the message bubble |
| `tests/unit/lib/p8-human-input.test.ts` | 53 cases |
| `tests/unit/lib/p8-linked-device-callback.test.ts` | 13 cases |
| `tests/unit/ai/p8-patient-registration-and-input.test.ts` | 22 cases |
| `tests/unit/components/p8-inbox-shell.test.tsx` | 13 cases |
| `tests/unit/integration/p8-whatsapp-history-attachments.test.ts` | 19 cases, real database |
| `services/whatsapp-worker/tests/history-import.test.ts` | 16 cases |
| `services/whatsapp-worker/tests/attachments.test.ts` | 18 cases |

### Modified

**Worker** — `src/config.ts` (history/attachment settings), `src/sessions.ts` (history
subscription, name learning, media ingestion, injectable downloader), `src/inbound.ts`
(names, media detection, history-aware staleness), `src/jids.ts` (`NameDirectory`),
`src/store.ts` (storage upload, history progress), `src/callback.ts` (event kinds,
batching), `tests/harness.ts`, `tests/inbound-messages.test.ts`.

**Messaging** — `lib/messaging/types.ts`, `lib/messaging/whatsapp-linked-device.ts`,
`lib/messaging/webhooks.ts`, `lib/messaging/send.ts`, `lib/messaging/inbox.ts`,
`lib/supabase/admin.ts`.

**Patient AI** — `lib/ai/patient-reply.ts` (takeover gate, send claim, full-body history,
attachment parts), `lib/ai/patient-authorization.ts`, `lib/ai/patient-tools.ts`,
`lib/ai/prompts/patient.ts`, `lib/ai/tools/verify-patient-identity.ts`,
`lib/ai/tools/check-patient-availability.ts`, `lib/ai/tools/create-preliminary-booking.ts`,
`lib/ai/tools/cancel-my-appointment.ts`.

**Inbox & actions** — `components/inbox/inbox-shell.tsx`, `actions/messaging.ts`,
`lib/validations/messaging.ts`, `messages/en.json`, `messages/ar.json`,
`types/database.ts`.

**Existing tests updated** — `tests/unit/lib/p7e-linked-device-adapter.test.ts`,
`tests/unit/lib/p7e-linked-device-inbound.test.ts`,
`tests/unit/components/p3c-inbox-shell.test.tsx`,
`tests/unit/components/p5b-inbox-suggestion.test.tsx`.

### Schema

- `conversations`: `display_name`, `ai_paused_at`, `ai_paused_by`, `ai_pause_reason`
- `outbound_messages`: `body` (constrained to `related_type = 'manual'`)
- `inbound_message_attachments`: new table, RLS-scoped to the clinic's inbox roles
- `whatsapp_linked_device_sessions`: `history_status`, `history_started_at`,
  `history_completed_at`, `history_chats_imported`, `history_messages_imported`
- Storage bucket `whatsapp-inbound` (private, 16 MB, mime allow-list)
- RPCs: `persist_whatsapp_inbound` (recreated with display name + historical flag +
  message id), `upsert_whatsapp_history_chat`, `set_conversation_ai_pause`,
  `register_patient_from_conversation`, `resolve_patient_ai_context` (recreated with
  `clinic_country`, `participant_address`, `ai_paused`)

---

## 4. Supported history-sync limits — stated, not papered over

This uses the only mechanism that exists in Baileys 6.7.24: the `messaging-history.set`
event, fed by the history sync the phone pushes to a newly linked device, requested with
`syncFullHistory: true`. There is no API for "give me all messages in this chat", and
nothing here pretends otherwise.

| Limit | Detail |
| --- | --- |
| **The phone decides the volume** | WhatsApp sends a bounded recent window per chat, not the archive. `syncFullHistory` asks for the larger of the two windows WhatsApp offers; how much actually arrives varies by account, platform, and how long the phone has been online. |
| **Primarily an initial-link event** | A device that is already paired and merely reconnecting typically receives `syncType: RECENT` or nothing. The import is written to be re-runnable and idempotent rather than one-shot. |
| **Media does not survive** | History messages reference media URLs WhatsApp has expired. History import carries **text only**; attachments come from live traffic. |
| **Retention window** | Chats and messages older than `WHATSAPP_HISTORY_MAX_AGE_DAYS` (default 365) are not carried. |
| **LID chats need an assertion** | A LID-addressed chat with no WhatsApp-asserted phone number is skipped, not guessed at — a LID's digits are an opaque server identifier. |
| **Nothing is fabricated** | If the phone sends no history, the session row records `history_status = 'unavailable'` with zero counts. There is no synthetic "success". |
| **Excluded by design** | Groups, broadcasts, status, newsletters, Meta AI and other first-party bots, via the same `classifyJid` the live path uses. |

Progress is visible per clinic on `whatsapp_linked_device_sessions`
(`history_status`, `history_chats_imported`, `history_messages_imported`).

---

## 5. Supported attachment types

Decided from the **file's leading bytes**, never the sender's `mimetype` or `fileName`.

| Kind | Stored | Notes |
| --- | --- | --- |
| Images | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`/`heif` | Rendered inline in the thread |
| Documents | `application/pdf`, `text/plain`, `.doc`, `.docx`, `.xls`, `.xlsx` | OOXML/OLE accepted only when the container matches the claim — `PK\x03\x04` alone cannot distinguish a `.docx` from any other zip |
| Audio / video / voice notes | **No** | Recorded as `rejected / kind_not_stored`; staff are told to open them on the clinic phone |
| Anything unrecognised | **No** | `rejected / unsupported_type` |

- Size cap: 10 MB (`WHATSAPP_ATTACHMENT_MAX_BYTES`), enforced against the declared length
  *and* the real byte count; the bucket's own 16 MB ceiling is the backstop.
- Path: `<clinicId>/<YYYY-MM>/<uuid>.<ext>` — built entirely from values the worker
  controls. The sender's filename survives only as a display label, with path separators
  flattened and bidi/control characters stripped.
- The AI may read `image/jpeg|png|webp|gif` and `application/pdf`, at most 2 files and
  4 MB each, from the newest inbound turn only, passed as data-URL message parts (never
  as a URL the model could repeat or follow). Everything else is described to the model
  in words so it says it cannot read the file rather than inventing contents.
- **The message always survives.** Every failure path produces an attachment row.

---

## 6. Human takeover behaviour

- **Control**: a "Pause AI / Resume AI" button in the conversation header, plus a
  Resume button on the paused banner. `aria-pressed` reflects state; the conversation
  list carries an "AI paused" badge.
- **Durable and tenant-scoped**: `conversations.ai_paused_at` / `ai_paused_by` /
  `ai_pause_reason`, flipped through `set_conversation_ai_pause` under a row lock, so two
  staff clicking at once produce one transition and one audit line (`changed = false`
  for the loser).
- **What it stops**: every automatic agent send. Auto mode drafts a suggestion instead
  of sending. Emergency safety copy, which normally sends regardless of mode, also does
  not auto-send under an explicit takeover — a staff member has the thread open, and an
  automatic message arriving mid-sentence is the exact collision this prevents. The
  escalation, the notification and the ready-to-send draft all still happen.
- **What it still allows**: suggestions. Staff keep the one-click approve flow.
- **Acting tools refuse too**: `create_preliminary_booking`, `cancel_my_appointment` and
  `register_patient` all fail closed with `human_takeover`.
- **Race protection**: the auto-send path takes the right to send with a conditional
  update (`ai_last_replied_at` set only `where ai_paused_at is null and ai_escalated_at
  is null`). A staff member who pauses while the model is still generating wins; the
  drafted reply is left for them.
- **Not a replacement**: clinic-level `ai_reply_mode` still decides whether the agent may
  speak at all. This is an additional gate.

---

## 7. Patient registration and booking flow

```
unknown number writes in
  └─ tools report `patient_unlinked` with guidance pointing at register_patient
     └─ assistant explains it needs a few details, asks conversationally
        └─ register_patient(full_name, national_id, date_of_birth, email)
           · every field normalized deterministically first
           · ambiguous DOB → one short question naming both months
           · unreadable field → asks about that field only
           └─ register_patient_from_conversation (SECURITY DEFINER, one transaction)
              · phone = the conversation's own participant_address (never an argument)
              · duplicate check on phone OR national_id
                  1 match  → link, no duplicate created
                  >1 match → stop, hand to staff
                  0 match  → CF-#### file number under an advisory lock, insert, link,
                             backfill patient_id onto the thread's messages/attachments
              └─ conversation now linked → booking continues without restarting
```

Booking is unchanged and deliberately so: `check_availability` (now understanding
"بكرا", "tomorrow", "18/8/2026") returns real slots, `create_preliminary_booking` goes
through `createPatientPendingBooking`, and the appointment stays in the existing
AI-pending state under the existing per-patient and per-slot caps, concurrency
protection, provenance and expiry rules. No availability is invented — the prompt
forbids stating a time not seen in a tool result, and the tool refuses a day it cannot
parse rather than picking one.

Required fields are ClinicFlow's existing ones (`patientSchema`): full name, national id,
date of birth, phone, email. Only the phone is supplied by the system.

---

## 8. Security invariants preserved

| Invariant | How |
| --- | --- |
| Clinic tenant isolation | Every new query is clinic-keyed; the new table joins `conversations(id, clinic_id)` and `patients(id, clinic_id)` composite FKs; the new table is registered in the `createClinicScopedAdminClient` allow-list; storage paths are prefix-checked against the caller's clinic on write *and* on read; RPCs raise `CONVERSATION_NOT_FOUND` across tenants. Covered by tests. |
| Callback HMAC verification | Untouched. Signature is checked over raw bytes before the body is read for meaning; history and attachment events ride the same verified channel. |
| Linked-device token auth | Untouched. |
| Encrypted WhatsApp auth state | Untouched. No new code reads `whatsapp_linked_device_auth`. |
| Patient identity verification | Strengthened. An unparseable or ambiguous date is refused *before* the rate-limited RPC is called, so a formatting difference can no longer burn an attempt or cause a lockout, and the alternative reading is never silently tried. |
| Booking caps and concurrency | Untouched — `createPatientPendingBooking` is the only path. |
| Message idempotency | History and live traffic share the unique `(clinic_id, provider_message_id)` index on `inbound_messages` and `(provider, provider_message_id)` on `outbound_messages`; attachments have their own unique index. Proven against a real database. |
| Audit / provenance | Takeover transitions log actor + direction only. `register_patient` logs the outcome only. |
| Human approval for privileged operations | Unchanged; takeover adds a gate, removes none. |
| **Never logged** | Worker history logs carry counts only; attachment logs carry kind/status/size only. No message body, phone number, JID, display name, filename, storage path, key material or credential is logged anywhere new. Postgres errors are reduced to SQLSTATE + primary message before reaching Sentry, because `details`/`hint` embed the offending values. |
| Untrusted input | Display names are stripped of bidi/control characters and length-bounded; sender filenames are flattened and never used to build a path; mime types are sniffed, not believed; attachments are named in the prompt as untrusted data. |

---

## 9. Tests and final results

All run locally against a reset local Supabase.

| Suite | Command | Result |
| --- | --- | --- |
| WhatsApp worker | `npm run whatsapp:worker:test` | **108 passed** (34 new) |
| Worker typecheck | `npm run whatsapp:worker:typecheck` | clean |
| Full unit suite (incl. messaging/inbox/patient AI) | `npm test` | **3195 passed / 386 files** |
| Full integration suite | `npm run test:integration` | **528 passed, 3 skipped / 58 files** |
| Adversarial / injection | `npm run test:ai-adversarial` | **136 passed** |
| Security suite | `vitest run tests/unit/security` | passed |
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | 0 errors (28 pre-existing warnings) |
| RTL gate | `npm run lint:rtl` | clean, 698 files |
| i18n gate | `npm run lint:i18n` | clean, 448 files |
| Message parity | `npm run i18n:missing` / `i18n:unused` | clean, 4129 keys |
| Production build | `npm run build` | compiled successfully |

New coverage maps to the request as follows: QR-linked history import and idempotency,
contact/display-name preservation, long Arabic AI message rendering, flexible DOB/date
parsing, ambiguous-date clarification, new-patient registration from WhatsApp,
conversation-to-new-patient linking, booking a real slot as AI-pending, human takeover
preventing auto-send, AI resume, inbound image/document ingestion, unsupported-attachment
handling, history + live deduplication, inbound/outbound behaviour across a worker
restart (the existing restore/reconcile suite, extended), and cross-clinic leakage.

**Not deployed.** No migration was pushed to a remote project and nothing was released.

---

## 10. Remaining limitations and risks

1. **History volume is WhatsApp's decision.** §4. A clinic may link and receive far less
   than they expect. The session row reports what actually arrived; there is no way to
   ask for more.
2. **History media is gone.** Imported conversations are text-only. Nothing can recover
   an expired media URL.
3. **Outbound history depends on the chat opening first.** An echo never creates a
   conversation on its own. The interpreter orders `history_chat` events ahead of their
   messages, so this holds in practice, but a payload delivering messages for a chat the
   phone never listed and that has no inbound message would be skipped.
4. **`e2e` was not run.** Playwright needs a running app on `PORT=3100`; the build smoke
   and the component suite were used instead. Worth running before release.
5. **`patient-documents-page.test.tsx` is flaky under full-suite load** — it timed out on
   one full run and passed in isolation and on the re-run. Pre-existing, unrelated to
   this work, but it will resurface in CI.
6. **`types/database.ts` was hand-edited surgically**, per the known drift between local
   regeneration and the committed remote-generated file. A future `npm run db:types`
   against the remote project will need the P8 objects to survive.
7. **Attachment retention has no policy yet.** Files accumulate in `whatsapp-inbound`
   with no scrub job; the existing AI retention machinery does not cover them.
8. **Two-digit years are resolved to the past** (`12/9/99` → 1999). Correct for a date of
   birth, wrong for a far-future appointment — appointment parsing should prefer explicit
   four-digit years, which the prompt encourages but does not enforce.
9. **Arabic month-name coverage is a curated list** (MSA, Egyptian and Levantine). A
   dialect spelling outside it falls through to the numeric parser or a clarification
   question — never to a wrong date.
10. **Date-order is derived from the clinic's country**, US being the only month-first
    entry. A US-resident patient writing to a non-US clinic will have `9/12` read as
    9 December; when the alternative reading is also valid the tool asks rather than
    assuming, so the failure mode is a question, not a wrong record.
