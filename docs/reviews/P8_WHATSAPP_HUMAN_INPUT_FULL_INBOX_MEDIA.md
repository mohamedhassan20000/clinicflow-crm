# P8B — Human input understanding, the linked account as a real inbox, and the outbound-media foundation

Status: **delivered locally and not deployed.** Sections 1–10 are implemented; the final
§§3–8 implementation, verification results and remaining risks are recorded in §10.
Branch: `feat/p7-manual-qa-polish`. **Not deployed.**

This report is written to be useful to whoever picks the rest up, so it is explicit about
what exists, what does not, and why the split fell where it did.

---

## 0. What was delivered, against the request

| § | Request | Status |
| --- | --- | --- |
| 1 | Human-like patient input understanding | **Done** — general contextual layer, 62 new tests |
| 2 | Linked WhatsApp behaves as a real inbox | **Done** — staging model removed, full history admitted |
| 3 | Start a new WhatsApp conversation | **Done** — contact picker and international-number entry, with no patient creation |
| 4 | Message templates / quick replies in the composer | **Done** — existing template backend reused; rendered linked-device text remains editable |
| 5 | Staff outbound images / documents / files | **Done** — private storage-reference pipeline for uploads and authorized ClinicFlow documents |
| 6 | Voice notes | **Done** — Chrome/Safari capture with server-side ffmpeg OGG/Opus conversion and `ptt: true` |
| 7 | Outbound media architecture & security | **Done** — typed claim/send/finalize path with tenant and document reauthorization |
| 8 | Inbox UX | **Done** — upload/send/error/retry states, previews, accessibility and Arabic/English support |
| 9 | History durability | **Done** — the H2 spool is untouched and re-verified |
| 10 | Provider compatibility | **Done** — no Meta/360dialog path was altered |
| 11 | Testing | **Done** — worker, unit, integration, adversarial/security, lint, typecheck, i18n/RTL and production build green |
| 12 | Report | This document |

**The connection layer was not redesigned.** No change was made to QR pairing, socket
creation, browser identity, auth or Signal-key persistence, the start/logout epoch
protection, reconnect/reconcile, `getMessage`/retry recovery, callback signing, worker
ownership, or encryption. The worker gained isolated contact persistence and typed media
send branches; its existing text and connection tests remain green. The final worker suite
is 140 tests.

---

## 1. Root causes found

### 1.1 The assistant re-asked for information it already had

The reported conversation:

```
patient   12/9/2000
clinic    September or December?
patient   سبتمبر
patient   نعم 2000
clinic    (asks again)
```

The date parser was correct on every one of those messages. The defect was that **each
tool call started from nothing**. `verify_patient_identity` received one string, parsed
it, and returned; `سبتمبر` is not a date, so the only outcome available to it was to fail
and re-ask. There was nowhere to record that a question had been asked, what the competing
readings were, or that the answer had already been settled.

So this is not a date-parsing bug and a date-specific patch would not have fixed it. It is
the absence of conversational state.

### 1.2 The P8/H4 staging rule contradicted the product

P8 admitted a history chat into the Inbox only when its number matched exactly one active
patient. Every other chat was **staged**: number, WhatsApp name and a message count, with
the message bodies deliberately never written. Staff accepted or dismissed each one.

That was a defensible rule for an inbox whose contract is "this is the clinical record".
It is the wrong rule for the contract the product now states — when a clinic links *its
own* WhatsApp account, ClinicFlow is that account's workspace. A workspace that hides most
of the account's conversations, and silently destroys their contents so that accepting one
later recovers nothing, is not one.

### 1.3 The conversation list could not reach beyond 100 threads

`get_inbox_conversation_summaries` returned the 100 most recent conversations and the
client filtered them. That was a complete list when the Inbox only held traffic since the
clinic joined. With an account's history imported it is a window onto a much larger set,
and a thread that scrolled out of it became unreachable — the filter box could only filter
what the server had already sent.

### 1.4 The conversation list preview was the redacted one

`get_inbox_conversation_summaries` built its preview from `outbound_messages.body_preview`
— the digit-masked, 120-character column — even though P8 had added the full `body`. The
thread view was fixed in P8; the list beside it still showed `••••`.

---

## 2. Existing functionality reused

Nothing was rebuilt that already worked.

- **`lib/ai/human-input.ts`** (P8) already read one complete answer in any human format —
  Arabic-Indic digits, Arabic and English month names, every separator, relative days,
  spoken times, E.164 normalization. §1 is a layer *on top of* it, not a replacement. One
  function was exported from it (`parseMonthName`); nothing else changed.
- **`persist_whatsapp_inbound` / `upsert_whatsapp_history_chat`** were edited in place
  rather than replaced. The advisory lock, the replay handling, the unique-violation
  re-raise (P8/M1), the "no service window from history" rule and the "never reopen a
  closed thread" rule are all carried across verbatim.
- **The H2 delivery spool** (`whatsapp_history_delivery_batches`,
  `record_whatsapp_history_delivery`, `claim_whatsapp_history_batches`) was not touched at
  all. Completion still requires both "the phone said it sent its last batch" and "the
  spool is empty".
- **`clear_conversation_identity_on_patient_change`** was extended rather than duplicated:
  the new collected-state columns are cleared on exactly the edge that already clears the
  identity stamps.
- **`register_patient_from_conversation`** and `verify_patient_conversation_dob` — the
  P8/C1 identity rules — were **not modified**. §1 resolves values strictly before them.
- **`createClinicScopedAdminClient`'s allow-list** was used as-is for the new tables.

---

## 3. §1 — The contextual extraction and normalization layer

### 3.1 Shape

Three pieces of state, all per-conversation, all normalized:

```
collected   values already established, canonical      { date_of_birth: "2000-09-12", … }
pending     the ONE question currently outstanding     { field, kind, candidates, partial }
message     what the patient just said, untouched
```

`lib/ai/collected-state.ts` (pure, 8 fields, no I/O) decides what an answer means.
`lib/ai/patient-input.ts` (server-only) reads the state, calls the resolver, persists the
result, and returns something a tool can hand the model.

Fields covered: `date_of_birth`, `appointment_date`, `appointment_time`, `full_name`,
`phone`, `national_id`, `email`, `gender`. Adding one is a parser branch — the state,
merge, persistence and clarification machinery is field-agnostic.

### 3.2 The resolution order, which is the whole design

1. **A complete answer wins outright.** Someone who rewrites the value has corrected
   themselves; a fresh unambiguous reading replaces both the pending question and any
   earlier value.
2. **Otherwise resolve against the outstanding question.** This is the `سبتمبر` case: not
   a date, but a decisive answer to the one that was asked. A month name, a month number,
   a day, a bare "yes" (confirms the reading offered first), a bare "no" (rules it out).
3. **Otherwise check what is already established.** This is the `نعم 2000` case: a
   fragment that agrees with what is on file. Nothing is asked; the stored value is
   returned with `fromMemory: true`.
4. **Only then give up**, naming why.

Partial answers are a fourth outcome, not a failure: `12/9` with no year returns
`incomplete` with `{day: 12, month: 9}` parked in `pending`, and the next message
completes it.

### 3.3 Rules that do not bend

- **Never guess.** A fragment leaving more than one reading alive returns `ambiguous`
  again rather than picking. Re-sending the identical ambiguous date does not wear the
  check down — it re-asks.
- **A contradiction is a question, not a merge.** "1999" after a date established as 2000
  returns `conflict` naming both, and **writes nothing**. The established value survives
  until the patient says which is right.
- **Nothing here is identity evidence.** `parseCollectedData` rebuilds the jsonb column
  key by key against a fixed field list, so a `patient_id`, `clinic_id` or
  `identity_verified` key cannot survive a read even if one were written. There is a test
  asserting exactly that.
- **A refusal is free.** Resolution runs entirely before `verify_patient_conversation_dob`
  is called, so our own inability to read a date can never consume a rate-limited attempt
  or lock a patient out. This property already existed in P8 and is preserved by keeping
  the resolution step separate from the check step in one shared helper.

### 3.4 Persistence

`conversations.ai_collected_data jsonb` + `ai_pending_clarification jsonb`, written only
by `set_conversation_ai_state` (service-role, clinic-scoped, `CONVERSATION_NOT_FOUND`
across tenants). `collected` is **merged** (`||`), never replaced, so a turn that settles
a date cannot erase a name. `pending` is singular and replaced. Both are size-capped by
check constraints (8 KB / 4 KB).

The persist call is fire-and-forget on the failure path: if the bookkeeping write fails,
the *value* is still correct for this turn and the worst outcome is that the assistant
asks again later — which is exactly the pre-P8B behaviour. Losing a correct answer to a
failed bookkeeping write would be strictly worse.

### 3.5 Tools wired

`verify_patient_identity`, `register_patient` and `check_availability` now all go through
`resolvePatientDate` / `resolvePatientInput`. Their model-facing reason strings
(`ambiguous_date`, `unrecognized`, …) were **kept identical** — the resolver is generic
but the tool contract is the model's, and renaming it would be churn with no behaviour
behind it. `register_patient` gained one genuinely new outcome, `conflicting_details`,
which asks the sharper question instead of re-collecting everything.

---

## 4. §2 — The history and privacy model change

### 4.1 What changed

`upsert_whatsapp_history_chat` no longer decides admission. The patient-number test
survives but only as an **attribution** rule — it decides whether the thread arrives
already *linked*, exactly as it does for a live inbound message. It no longer decides
whether the thread exists.

`persist_whatsapp_inbound` lost its staging branch and its `staged` OUT column. A
historical message whose chat was never listed now opens the thread itself, still inert in
every way that matters: no service window, no reopen of a closed thread, no status churn,
no notification, no agent turn.

### 4.2 What did not change — the invariant that replaces H4

Separation, not exclusion:

| Property | How it holds |
| --- | --- |
| An unlinked chat's messages carry no patient | `inbound_messages.patient_id` is copied from the conversation, which is null. One line, tested. |
| An unlinked chat's attachments carry no patient | Same source. Tested. |
| No patient is created because a chat exists | There is no statement in the migration that touches `public.patients`. Tested by count. |
| A thread is not identity verification | `register_patient_from_conversation` and `verify_patient_conversation_dob` are unmodified. C1's adversarial suite still passes. |
| Groups/status/broadcast/newsletters | Still refused a layer earlier by the worker's `classifyJid`. Unmodified. |
| Tenant isolation | Every statement is clinic-keyed; cross-clinic leakage tested. |

### 4.3 Retiring the staging model cleanly

Rather than leaving two competing history models:

- `whatsapp_history_pending_chats` — **dropped**, after a backfill that promotes every
  still-pending row into a real unlinked conversation. Those chats' message bodies are
  gone for good; they were never written, which is precisely what made the old rule
  unrecoverable.
- `decide_whatsapp_history_chat` — dropped.
- `decideHistoryChat` action, `historyChatDecisionSchema`, and
  `components/settings/whatsapp-history-review-card.tsx` — deleted.
- `readHistoryImportView` no longer reads a review list.
- Replaced by `components/settings/whatsapp-history-import-card.tsx`: progress and counts
  only, with the partial/unavailable warning kept, because WhatsApp decides how much
  history it sends and the honest answer is sometimes "less than you expected".

### 4.4 Callback contract

`historyStaged` was removed from `CallbackSummary` on both sides. The worker's
`readSummary` defaults every absent field to zero, so a worker and an application on
either side of this change interoperate without a coordinated deploy.

### 4.5 List reachability and preview (1.3, 1.4)

`get_inbox_conversation_summaries` gained `p_search` (matching participant number and
WhatsApp display name, server-side), raised its ceiling to 300, and now builds its preview
from `coalesce(om.body, om.body_preview, '')`. One supporting index,
`conversations_channel_recent_idx`, for the ordering the RPC actually uses.

`loadInboxData` accepts a `search` argument and passes it through. **The Inbox UI does not
yet expose it** — that is part of the unbuilt §8.

---

## 5. WhatsApp / Baileys limitations — original P8B state

This section records the original P8B state. **P8C §11 supersedes the media and unresolved
LID bullets below**, and removes ClinicFlow's former 365-day cutoff so WhatsApp's supplied
window is the only age limit.

- **The phone decides the volume.** `syncFullHistory: true` asks for the larger of the two
  windows WhatsApp offers. How much arrives varies by account, platform and how long the
  phone has been online. There is no "give me all messages in this chat" API.
- **Primarily an initial-link event.** A reconnecting paired device typically receives
  `syncType: RECENT` or nothing.
- **History media bytes usually do not survive.** P8C retains safe unavailable-file
  metadata; it does not claim expired bytes.
- **LID chats without a WhatsApp-asserted phone number remain pending**, not skipped or
  guessed at, until an explicit mapping becomes available.

Now that every chat is admitted rather than a patient-matched subset, a clinic will see
more conversations than before but *not* more history per conversation. The import card
reports what actually arrived; nothing synthesises a success.

---

## 6. §3, §5, §7 — what exists, and what a follow-up still has to build

The schema and the security boundaries are in place and verified. The behaviour is not.

### 6.1 Built

**`open_whatsapp_conversation(clinic, participant, display_name, actor)`** — takes an
E.164 number and never a patient id; cannot create a patient; idempotent (an existing
thread is returned and reopened); applies the same single-active-patient attribution as
the inbound path; refuses a non-E.164 address and an actor from another clinic. Verified
against the local database.

**`whatsapp_contacts`** + `upsert_whatsapp_contacts(clinic, jsonb)` — the linked device's
address book, so "New conversation" can offer a person rather than 13 digits. Rebuilt field
by field from the jsonb, E.164-validated, deduplicated within a batch, blank names never
overwriting stored ones. Staff-readable, service-role-writable.

**`outbound_message_media`** + the `whatsapp-outbound` bucket + `claim_outbound_media` /
`finalize_outbound_media` — one row per prepared file, covering all five sources (device
image, device document, existing patient document, existing issued document, voice note).
Two decisions worth carrying forward:

- **Existing ClinicFlow documents are referenced, not copied.** `bucket` is a three-entry
  allow-list (`whatsapp-outbound`, `patient-assets`, `clinic-documents`) rather than a
  constant, so sending a patient's stored ID scan records where it already is. Copying it
  would double the storage, split the retention story and create a second copy of a
  patient's file with no lifecycle attached.
- **A draft is a claim, not a URL.** The client never learns a storage path; it would
  upload through a server action and receive an id. `claim_outbound_media` moves exactly
  one draft to `sending`, so a prepared file can never be attached to two messages.

Constraints enforce that uploads/voice notes live only in our own bucket, that our own
bucket's paths are clinic-prefixed, that a voice note is audio, and that a `sent` row
names its message.

**`lib/supabase/admin.ts`** gained `isSendableStoragePath` — the single place that decides
whether a stored object may leave the building over WhatsApp — plus the upload, sign,
download and remove helpers built on it. Record-level authorization (may this staff member
see this patient's file?) is explicitly *not* here; it belongs in the action that prepares
the send, and this is the second check that holds even if the first is wrong.

### 6.2 Not built

- No upload server action, so no MIME sniffing of staff uploads, no size enforcement at
  the boundary, no rejection of malformed files.
- No `OutboundMessageInput.media`, so `sendMessage` cannot carry one.
- No worker `/messages` media branch. **Note for whoever builds it:** the worker's HTTP
  server caps request bodies at 64 KB (`MAX_BODY_BYTES` in `src/server.ts`), so media must
  be passed as `{bucket, storagePath}` for the worker to download with its service role —
  not as base64. The bucket allow-list above is designed for exactly that.
- No document-picker authorization path.
- No composer UI: no attach control, no template picker, no voice recorder, no previews,
  no progress, no per-attachment error/retry.
- No `New conversation` action or dialog.
- No provider-aware refusal for Meta/360dialog media (they must reject rather than
  silently degrade).
- Voice notes: no recording lifecycle, and **no decision made** on the ogg/opus question.
  Baileys wants `audio/ogg; codecs=opus` with `ptt: true`; Chrome and Safari's
  `MediaRecorder` produce WebM/Opus. Either the worker transcodes (ffmpeg in the worker
  image — an infrastructure change, not a connection-layer one) or PTT is Firefox-only.
  This should be decided before any UI is written, because it determines whether the
  feature can ship at all.

### 6.3 §4 — template inspection findings (no code written)

The request asked for inspection before implementation. What actually exists:

- `message_templates` — clinic-scoped, `(clinic_id, channel, name, language)` unique, with
  `variables jsonb`, `approval_status` and `provider_template_id`. RLS: admin/receptionist
  read.
- Full CRUD in `actions/messaging.ts` (`saveMessageTemplate`, `deleteMessageTemplate`),
  with the conditional-UPDATE lock on submitted/approved templates.
- `components/settings/message-templates-manager.tsx` — the Settings UI already exists.
- `sendInboxReply` already accepts `templateId` + `templateParameters`, and
  `lib/messaging/send.ts` already renders `{{1}}`/`{{name}}` substitution and already
  applies the correct provider rule: Meta requires an approved provider binding, a linked
  device only refuses an explicitly *rejected* template.

**Conclusion: no schema and no backend work is needed for §4.** What is missing is
entirely in the Inbox: `loadInboxData` filters templates to `approval_status = 'approved'`
(which hides a linked device's usable drafts), and the composer only offers a template
when the service window is closed, sending it directly rather than rendering it into the
textarea for editing. Both are UI-layer changes.

---

## 7. Security and tenant protections

| Invariant | How it holds |
| --- | --- |
| Tenant isolation | Every new RPC is clinic-keyed and raises across tenants; new tables carry `clinic_id` with composite FKs to `conversations(id, clinic_id)`, `profiles(id, clinic_id)`, `outbound_messages(id, clinic_id)`; storage paths are prefix-checked. Verified against the database. |
| No medical-record contamination | `inbound_messages.patient_id` / `inbound_message_attachments.patient_id` come from the conversation only. Tested. |
| No implicit patient creation | No statement in the migration touches `public.patients`. Tested by count. |
| Identity checks unweakened | C1's rules are unmodified; the full adversarial suite (136) passes. |
| Collected state cannot become an authorization input | Rebuilt against a fixed field list on every read; a `patient_id` key cannot survive. Tested. |
| Collected state does not outlive its subject | Cleared by the existing trigger whenever `patient_id` changes. |
| No existence oracle | `duplicate_review` and `identity_mismatch` still map to byte-identical guidance. Unmodified. |
| Storage | `whatsapp-outbound` is private with **no** `authenticated` policy, matching `whatsapp-inbound`. `isSendableStoragePath` is the only gate, and refuses `..` and absolute paths. |
| Write paths | `outbound_message_media` and `whatsapp_contacts` have no authenticated write policy at all. |
| Callback HMAC / worker token / encrypted auth state | Untouched. |
| Never logged | No new logging was added anywhere. |

---

## 8. Tests and exact results

All against a local Supabase reset from empty.

| Suite | Command | Result |
| --- | --- | --- |
| WhatsApp worker | `npm run whatsapp:worker:test` | **129 passed, 0 failed** |
| Worker typecheck | `npm run whatsapp:worker:typecheck` | clean |
| Full unit suite | `npm test` | **3245 passed / 388 files**; 5 failures in 4 files, all of which **pass in isolation** — see below |
| Full integration suite | `npm run test:integration` | **548 passed, 3 skipped / 58 files** |
| Adversarial / injection | `npm run test:ai-adversarial` | **136 passed** |
| Security | `vitest run tests/unit/security` | passed |
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | 0 errors (28 pre-existing warnings) |
| RTL gate | `npm run lint:rtl` | clean, 701 files |
| i18n gate | `npm run lint:i18n` | clean, 449 files |
| Message parity | `i18n:missing` / `i18n:unused` | clean, 4147 keys |
| Production build | `npm run build` | compiled successfully |

**The 5 full-suite failures** are in `patient-avatar-pages`, `p49a-launcher-behavior`,
`patient-trash`, `p46a-review-fixes` and `patient-documents-page`. Re-run together in
isolation: **63 passed, 0 failed** in 9 seconds, against 30–50 seconds per file under full
load. This is the pre-existing full-suite timeout flakiness recorded as item 5 of the P8
report, now affecting a few more files. It is unrelated to this work and no test was
loosened to accommodate it.

### New tests

**`tests/unit/lib/p8b-collected-state.test.ts` — 34 cases**, written as *conversations*
rather than strings, because a case that passes message-by-message and still loops is
exactly the reported bug:

- the exact reported exchange, `12/9/2000 → سبتمبر → نعم 2000`, asserting resolution on
  message two and *memory* on message three;
- the same exchange in English;
- `ديسمبر` selecting the other reading;
- all five separators (`/ - . space`, Arabic-Indic) resolving identically;
- unambiguous dates never asked about, in four spellings;
- asked exactly once, then four different follow-ups all answered from state;
- `12/9` → `1998` completing across two messages;
- a bare "no" selecting the reading not offered first;
- contradictory year and contradictory month → `conflict`, **nothing written**;
- a complete rewrite accepted as a correction;
- an off-topic fragment leaving the question outstanding;
- fragmented registration (name, Arabic-Indic national id, email, date) collected without
  re-asking, and the "already established — do not ask again" summary;
- fragmented appointment preferences (`بكرا` + `الساعة ٥ العصر`), and a bare hour asked
  about once then answered;
- state read off the wire rebuilt and refused (unknown keys, wrong types, malformed dates,
  out-of-day times, a pending clarification for a different field);
- **identity protections**: no patient id or verification flag survives a read; a
  resolution carries nothing but a value; an undecidable date stays undecided under
  repetition; an affirmation cannot invent a value that was never given; a future date of
  birth refused; a US clinic's `9/12` read the American way.

**`tests/unit/integration/p8-whatsapp-history-attachments.test.ts`** — the P8/H4 staging
suite (7 cases) was **replaced**, not deleted, by a P8B §2 suite (9 cases) documenting the
new invariant against the real database: a patient chat imported already linked; a
non-patient chat imported *unlinked* with its WhatsApp name and no service window; message
bodies stored with a null `patient_id`; no patient created; attachments carrying no
patient; a live message from an unknown number still opening a thread; replay writing
nothing twice; cross-clinic isolation.

`tests/unit/ai/p8-patient-registration-and-input.test.ts` (28 cases) passes unchanged —
the tool contract was deliberately preserved.

---

## 9. Remaining risks and trade-offs

1. **Sections 3–8 are not delivered.** The Inbox has no New-conversation action, no
   template picker, no attachments, and no voice notes. The schema underneath them is
   applied, so a follow-up starts from working boundaries rather than from nothing — but
   the migration ships tables and RPCs with no product on top of them, which is a real
   (if small) cost if the follow-up is delayed.
2. **The search parameter is server-side but not surfaced.** `loadInboxData` accepts
   `search`; the UI still filters client-side over the first 100 rows. With history
   imported, older threads are reachable by the API and not yet by a user. This is the
   most user-visible gap left by stopping here.
3. **Privacy posture changed deliberately.** The clinic's own phone contains personal
   conversations, and every receptionist with Inbox access can now read them. That is the
   explicit product decision in the request, and it is defensible for an account the
   clinic chose to link — but it is a genuine widening, and clinics should be told before
   they link rather than after.
4. **The staging backfill is one-way.** Promoted chats arrive with metadata and no
   history; the bodies were never written. A re-link re-imports whatever WhatsApp still
   offers, which may be nothing.
5. **Dismissed chats lose their tombstone.** Chats staff previously dismissed are dropped
   with the table and will reappear on the next import. There were no deployed clinics, so
   no real dismissal is being reversed, but the behaviour is worth knowing.
6. **`types/database.ts` was spliced, not regenerated.** The committed file is generated
   against the remote project and differs from a local regeneration by ~1000 lines of
   ordering/nullability/`graphql_public` noise. Only the P8B blocks were carried across,
   by a scripted brace-matched splice. A future `npm run db:types` against the remote will
   need the P8B objects to survive.
7. **Voice-note encoding is undecided** — see §6.2. It gates §6 entirely.
8. **Attachment retention still has no policy**, now for two buckets rather than one.
9. **Two-digit years still resolve to the past**, correct for a birth date and wrong for a
   far-future appointment. Unchanged from P8.
10. **Arabic month coverage is still a curated list** (MSA, Egyptian, Levantine). A
    spelling outside it falls through to the numeric parser or a clarification — never to
    a wrong date.
11. **e2e was not run.** Playwright needs the app on `PORT=3100`; the build smoke and the
    component suite were used instead.

**Not deployed.** No migration was pushed to a remote project and nothing was released.

---

## 10. Final §§3–8 implementation (2026-08-20)

This section supersedes the earlier §§3–8 gap analysis and risk items 1, 2 and 7 above.
The implementation was added on top of the existing P8B groundwork without replacing the
linked-device connection lifecycle or either provider's existing text-send behavior.

### 10.1 Files changed for §§3–8

Application and server boundary:

- `actions/messaging.ts`
- `app/(protected)/inbox/page.tsx`
- `components/inbox/inbox-shell.tsx`
- `components/inbox/inbox-composer.tsx`
- `components/inbox/new-conversation-dialog.tsx`
- `components/inbox/message-attachments.tsx`
- `lib/messaging/inbox.ts`
- `lib/messaging/outbound-media.ts`
- `lib/messaging/send.ts`
- `lib/messaging/types.ts`
- `lib/messaging/whatsapp-linked-device.ts`
- `lib/supabase/admin.ts`
- `lib/validations/messaging.ts`
- `messages/en.json`, `messages/ar.json`
- `messages/action-errors/en.json`, `messages/action-errors/ar.json`
- `next.config.ts`
- `types/database.ts`

Database and worker:

- `supabase/migrations/20260819120000_p8b_whatsapp_full_inbox_media.sql`
- `supabase/migrations/20260820100000_p8b_outbound_media_claim_provenance.sql`
- `services/whatsapp-worker/src/config.ts`
- `services/whatsapp-worker/src/server.ts`
- `services/whatsapp-worker/src/sessions.ts`
- `services/whatsapp-worker/src/store.ts`
- `services/whatsapp-worker/src/outbound-media.ts`
- `services/whatsapp-worker/Dockerfile`
- `services/whatsapp-worker/.env.example`
- `services/whatsapp-worker/README.md`

Verification coverage:

- `services/whatsapp-worker/tests/harness.ts`
- `services/whatsapp-worker/tests/contacts-persistence.test.ts`
- `services/whatsapp-worker/tests/outbound-media-http.test.ts`
- `services/whatsapp-worker/tests/outbound-media-send.test.ts`
- `tests/unit/components/p8b-inbox-composer.test.tsx`
- `tests/unit/db/p8b-whatsapp-full-inbox-media-migration.test.ts`
- `tests/unit/integration/p8-whatsapp-history-attachments.test.ts`
- `tests/unit/lib/p7e-linked-device-adapter.test.ts`
- `tests/unit/lib/p8b-outbound-media.test.ts`
- the existing Inbox fixtures in `p3c-inbox-shell.test.tsx`,
  `p5b-inbox-suggestion.test.tsx` and `p8-inbox-shell.test.tsx`

### 10.2 Architecture and text-path preservation

The browser never sends media bytes or storage coordinates to the WhatsApp worker. The
flow is:

1. The Inbox calls a clinic-authenticated server action with a browser `File` or an opaque
   ClinicFlow document identifier.
2. The action validates the actor, conversation, active provider, size and actual file
   signature. A device upload goes to the private `whatsapp-outbound` bucket; an existing
   document remains in its already-private bucket.
3. The server creates an `outbound_message_media` draft and returns only its opaque UUID
   to the browser.
4. Send atomically claims that UUID for the same clinic and conversation, reauthorizes its
   path and source record, and passes a typed storage reference to the existing
   linked-device adapter.
5. The worker validates the typed reference, repeats the tenant-aware path check, downloads
   the object with its service role, and hands a `Buffer` to Baileys.
6. The server finalizes the claim against the outbound message, or records a deterministic
   failure. Ambiguous provider results remain attached for reconciliation instead of being
   made retryable and risking a duplicate send.

The worker HTTP limit remains exactly **64 KiB**. The media request contains metadata only;
there is no base64 or multipart worker payload. `sendMessage` omits the `media` JSON member
entirely for text sends, so the linked-device text body and Meta/360dialog path preserve
their previous wire shape and behavior. Media is intentionally available only for the
active `linked_device` provider.

### 10.3 New conversations and contact history

Staff with the existing Inbox mutation roles can start a conversation from a persisted
`whatsapp_contacts` entry or a manually entered international phone number. The
`open_whatsapp_conversation` RPC normalizes/idempotently opens the thread within the
caller's clinic. Neither the action nor the RPC inserts into or updates `patients`; the UI
states this explicitly.

The worker upserts contact names and participant addresses from both live contact events
and imported history. Conversation search is now surfaced as a server-side Inbox query,
so threads beyond the visible page remain reachable.

### 10.4 Template reuse

No template table, CRUD action, provider binding or settings surface was duplicated. The
Inbox reads the existing clinic-scoped `message_templates` records and sends through the
existing `templateId` / `templateParameters` contract.

For a linked device, non-rejected templates act as quick replies: variables are rendered
into the composer and the resulting text stays editable before send. For Meta/360dialog,
the existing approved-template and closed-service-window rules remain authoritative; the
composer does not expose the new linked-device media path for those providers.

### 10.5 Uploads and existing ClinicFlow documents

Device uploads are capped at **10 MiB** and signature-sniffed before storage. Images use
Baileys' image send shape; other supported files use the document shape with a sanitized
filename and typed MIME value. The server calculates a SHA-256 digest for newly uploaded
bytes.

The ClinicFlow document chooser appears only for a patient-linked conversation. It lists
RLS-readable, non-deleted `patient_documents` plus issued generated `documents`. Selection
creates a reference to the existing private object rather than copying it. Preparation and
send are deliberately separate authorization points: send confirms the conversation is
still linked to that patient, the source record still exists in the same clinic and is
still sendable, and its current storage path matches the claimed record.

### 10.6 Voice-note pipeline

The composer uses `MediaRecorder` with the browser's supported audio container: Chrome's
WebM/Opus and Safari's MP4-family recording are accepted. Recording has visible elapsed
time, stop/cancel controls, a five-minute automatic stop, and an audio preview before send.
Microphone access is scoped to self by `Permissions-Policy`.

The upload follows the same private-storage draft path as every other attachment. At send
time the worker pipes the bounded input through ffmpeg and produces OGG/Opus using
`libopus`, then sends it through Baileys as `audio/ogg; codecs=opus` with `ptt: true`.
Transcoding has a 30-second timeout and bounded output; ffmpeg input/output use pipes, not
shell interpolation or shared filenames. The Debian worker runtime installs ffmpeg before
dropping to the existing non-root `node` user. A built-image smoke test confirmed ffmpeg
5.1.9 and `libopus` are present and the image config remains `User=node`.

### 10.7 Inbox behavior, accessibility and localization

The new composer presents one clear attachment state at a time: uploading, ready,
sending, failed/retryable or removed. Images and voice notes have local previews; document
attachments show their sanitized name, type and size. A failed deterministic send stays
actionable without silently reusing a consumed claim, while an ambiguous provider result
does not invite a duplicate retry.

The new-conversation dialog, contact/manual-number modes, template and document selectors,
recording controls, previews, errors and statuses have English and Arabic messages. The UI
uses logical layout properties and direction-aware behavior, labeled controls, live status
regions, keyboard-operable dialogs/listboxes and visible focus handling. Message history
renders outbound image, document and voice attachments from short-lived signed URLs.

### 10.8 Security boundaries

- Only authenticated admins and receptionists can open threads or prepare/send/discard
  media; all operations are clinic-scoped.
- The private `whatsapp-outbound` bucket has no authenticated client policy. Upload,
  download and deletion occur only through trusted server/worker boundaries.
- The browser receives a draft UUID, never an arbitrary bucket/path capability. The worker
  accepts only the three approved buckets and exact tenant-prefixed paths.
- `claim_outbound_media` is single-use and service-role-only. Its provenance-bearing return
  contract is preserved for databases where the foundation migration had already run by
  the forward-only `20260820100000` migration.
- Existing documents must pass both their own authenticated RLS at selection time and an
  explicit same-clinic/same-patient/same-record/path check at send time.
- Cross-tenant contact reads, conversation opens, media claims, document references and
  direct storage uploads are denied and covered by real-database tests.
- No patient is automatically created, and no connection secret, auth state, media bytes or
  signed storage URL is logged.
- QR pairing, browser identity, auth/Signal persistence, reconnect/reconcile,
  `getMessage`/retry, callback signing, epoch cancellation, history spool and encryption
  remain unchanged.

### 10.9 Final verification results

All required gates passed on the final tree:

| Gate | Final result |
| --- | --- |
| Targeted media/UI/security tests | Passed, including 44 real-database P8 integration cases |
| WhatsApp worker tests | **140 passed, 0 failed** |
| Worker typecheck and worker build | Clean |
| Application unit tests | **3,263 passed / 391 files, 0 failed** |
| Full integration suite | **553 passed, 3 skipped / 57 files passed, 1 skipped** |
| AI adversarial/injection suite | **136 passed, 0 failed** |
| Focused security suite | **58 passed / 5 files, 0 failed** |
| Application typecheck | Clean |
| Lint | **0 errors**; 28 pre-existing warnings in unrelated files |
| Hardcoded-string gate | Clean: 451 files, 41 declared exceptions |
| English/Arabic message parity | Clean: 4,191 keys |
| RTL gate | Clean: 704 files, 17 declared exceptions |
| Production application build | Successful on Next.js 16.2.6; 84 static pages generated |
| Worker container build/runtime | Successful; non-root image and ffmpeg/libopus smoke-tested |
| Relevant diff whitespace check | Clean |

The production build still reports the repository's existing Next.js middleware
deprecation notice and whole-project file-tracing/font warning. Neither is introduced by
the Inbox/media work. No test was relaxed, skipped or removed to obtain these results.

### 10.10 Remaining risks

1. A real linked phone/manual browser smoke remains necessary before release: the Baileys
   media shapes, contact events and conversion code are covered with a fake socket and a
   real ffmpeg image, but this work did not send a test attachment to a live WhatsApp
   account or grant a real browser microphone.
2. ffmpeg increases the worker image and its patch surface. The base image rebuild process
   must continue to pick up Debian security updates, and production capacity should be load
   tested for concurrent 10 MiB downloads/transcodes.
3. Draft cleanup is immediate on explicit removal and deterministic upload-send failure,
   but there is no scheduled expiry job for abandoned browser drafts. A retention policy
   is still needed for both inbound and outbound private media.
4. Existing-document safety relies on the current ingestion metadata and storage path.
   Send time reauthorizes the record and path, but it does not redownload and byte-sniff
   every existing patient document before handing it to the worker.
5. Imported history still depends on what WhatsApp makes available on a future relink; P8's
   one-way staging/backfill caveat is unchanged.
6. `types/database.ts` remains a targeted splice rather than a fresh remote regeneration,
   as documented above. The two P8B migrations must be applied in order when this branch is
   eventually promoted.
7. Meta and 360dialog outbound media are deliberately out of scope. Their text and approved
   template behavior is protected by regression tests; adding cloud-provider media later
   should be a separate provider-specific change.
8. Playwright was not run because it is not part of the requested gate list and requires a
   separately hosted app/browser fixture. Component interaction, full unit/integration
   suites and production compilation are green.

**Not deployed.** The follow-up migration was exercised only against local Supabase, the
worker image was built only as a local verification artifact, and no remote environment or
linked account was changed.

---

## 11. P8C incident fix — audible voice notes and lossless LID history (2026-08-21)

Status: **fixed and verified locally; not deployed.** The existing QR pairing, browser
identity, auth persistence, reconnect/ownership, retry/`getMessage`, text send, image and
document send paths were left in place. The current linked session was not cleared,
relinked, restarted, or used by a second worker.

### 11.1 Exact voice-note root cause and fix

The successful WhatsApp send did not prove that the browser captured sound. The composer
accepted any nonempty `MediaRecorder` Blob. A browser can write a valid, nonempty WebM or
MP4 container while its selected track supplies silence. The worker then correctly
converted those silent samples into a structurally valid 48 kHz mono OGG/Opus stream and
Baileys correctly sent it with `ptt: true`; WhatsApp therefore received a valid but silent
voice note. ffmpeg was not the initiating defect.

The repaired pipeline now has two independent audio gates:

1. The browser requires a secure context, requests a real audio input with
   `navigator.mediaDevices.getUserMedia`, and verifies that the returned stream contains a
   live, enabled audio track. Permission denied, no-device and unavailable-device failures
   have separate localized messages.
2. An `AudioContext`/`AnalyserNode` provides a live RMS level meter while recording. On
   stop, the exact Blob that would be uploaded is decoded locally. The follow-up calibration
   and format-independent fallback are recorded in §11.7. Cancel discards the Blob and no
   known-silent recording can become a media draft.
3. The worker validates the downloaded *source* with ffprobe/ffmpeg before transcoding,
   then validates the converted output again. Both must contain an audio stream, decoded
   samples and audible energy. The output remains mono 48 kHz Opus in OGG and is handed to
   Baileys as `audio/ogg; codecs=opus`, `ptt: true`.

Only aggregate levels and stage/reason codes are logged. Audio samples, Blob contents and
storage URLs are not logged.

### 11.2 Exact missing-history root cause and fix

Contact/name persistence and message persistence were separate paths. That is why the
Inbox could show a real WhatsApp name while the conversation still had no preview.

The worker's history interpreter required a phone-number JID before producing a chat or
message callback. For a LID-only chat, its in-memory directory had no mapping yet, so the
interpreter incremented `unresolvedChats` and omitted both the chat and its messages. The
durable spool began only *after* interpretation; consequently an unresolved record never
entered the spool and could not be retried when a mapping arrived later. The installed
Baileys 6.7.24 history helper also does not expose the decoded
`phoneNumberToLidMappings` array on its emitted history event, while the worker was not
learning the direct `Conversation.pnJid`/`lidJid` pairs that are available in some batches.

The repair changes the ordering and persistence contract:

- Every safe PN/LID assertion is learned before history interpretation. Assertions are
  accepted from live message stanza pairs, phone-number-share events, direct history
  conversation fields, and the newer optional Baileys history mapping field.
- Mappings are persisted per clinic in `whatsapp_lid_mappings` and hydrated before a
  restored socket starts. A LID identity is immutable: a contradictory assertion fails
  closed rather than moving messages between people. LID digits are never interpreted as
  or converted into a phone number.
- A resolvable 1:1 message continues through the normal history chat/inbound/outbound-echo
  persistence path.
- An unresolved LID chat/message now becomes a signed callback event inside the existing
  durable history batch, then a service-role-only pending row. The provider message ID,
  direction, timestamp, text and supported historical attachment metadata are retained.
- When WhatsApp later asserts the mapping, pending rows are read chronologically and
  persisted through the same idempotent inbound/outbound functions used for resolved
  history. The resulting conversation may remain an ordinary unlinked WhatsApp
  conversation; no patient is created. Provider message identity prevents duplicates.
- Resolved pending rows keep their audit identity/conversation link but have body and
  attachment metadata scrubbed. Replaying either the pending event or the mapping cannot
  reopen it or create a second message.
- The existing Inbox summary RPC already selects the latest real inbound or full outbound
  body. Once reconciliation writes the message, that body becomes the list preview and
  the same persisted row appears in the opened thread. “No message preview” remains only
  for a conversation for which no usable message has been persisted.
- ClinicFlow's former 365-day filter was removed. No message WhatsApp supplies is rejected
  merely for age; WhatsApp's own finite companion-history window is the only time bound.

Historical media bytes are not claimed when WhatsApp no longer makes them downloadable.
The message instead carries rejected `historical_media_unavailable` metadata, so the UI
can represent that a file existed without pretending the file is retrievable.

### 11.3 Durable metrics and diagnostics

Each final history callback batch now carries count-only metrics, and the session row
records these fields separately:

- chats received from the Baileys batch;
- messages received from the Baileys batch;
- messages actually persisted (the existing imported counter);
- provider-ID replays/deduplicated messages;
- messages currently pending LID resolution;
- messages that were genuinely unsupported and could not be represented.

Metric application is idempotent through `whatsapp_history_delivery_batches.metrics_recorded`.
Logs contain clinic-scoped counts and reason codes only—never bodies, phone numbers or
LIDs. A final sync remains `partial` while unresolved messages exist and `unavailable`
only when WhatsApp supplied neither an importable chat nor message.

### 11.4 Files changed by P8C

Browser/application:

- `components/inbox/inbox-composer.tsx`
- `lib/messaging/browser-audio.ts`
- `lib/messaging/types.ts`
- `lib/messaging/whatsapp-linked-device.ts`
- `lib/messaging/webhooks.ts`
- `lib/supabase/admin.ts`
- `messages/en.json`, `messages/ar.json`
- `types/database.ts`

Worker:

- `services/whatsapp-worker/src/outbound-media.ts`
- `services/whatsapp-worker/src/jids.ts`
- `services/whatsapp-worker/src/inbound.ts`
- `services/whatsapp-worker/src/history.ts`
- `services/whatsapp-worker/src/callback.ts`
- `services/whatsapp-worker/src/store.ts`
- `services/whatsapp-worker/src/sessions.ts`

Database, tests and report:

- `supabase/migrations/20260821120000_p8c_whatsapp_voice_history_reconciliation.sql`
- `services/whatsapp-worker/tests/harness.ts`
- `services/whatsapp-worker/tests/contacts-persistence.test.ts`
- `services/whatsapp-worker/tests/history-delivery.test.ts`
- `services/whatsapp-worker/tests/history-import.test.ts`
- `services/whatsapp-worker/tests/inbound-messages.test.ts`
- `services/whatsapp-worker/tests/outbound-media-send.test.ts`
- `services/whatsapp-worker/tests/outbound-media-transcode.test.ts`
- `tests/unit/components/p8b-inbox-composer.test.tsx`
- `tests/unit/lib/p8c-browser-audio.test.ts`
- `tests/unit/lib/p8-linked-device-callback.test.ts`
- `tests/unit/db/p8c-whatsapp-voice-history-reconciliation-migration.test.ts`
- `tests/unit/integration/p8-whatsapp-history-attachments.test.ts`
- this report

### 11.5 Verification results

| Verification | Result |
| --- | --- |
| Browser recorder/component + decoded-PCM tests | **29 focused application tests passed** across four focused files; silence and too-short audio refused, audible PCM accepted, Blob inspection precedes upload |
| Real media toolchain | Generated audible WebM/Opus fetched through the worker's storage boundary, converted by the production ffmpeg path, revalidated as audible 48 kHz mono Opus, and observed at the fake Baileys boundary as OGG + `ptt: true`; a nonempty silent WebM was rejected |
| Full worker regression suite | **148 passed, 0 failed**, including QR, session persistence, start/logout race, reconnect ownership, retry/`getMessage`, text, image and document paths |
| Local database migration | Applied successfully to the running local Supabase stack; no reset was used |
| Real-database WhatsApp integration | **47 passed, 0 failed**; immutable mapping and idempotent metric RPCs passed; an unresolved LID message survived durably, a later asserted mapping created an unlinked conversation, preserved body/direction/timestamp, kept `patient_id = null`, generated the actual Inbox preview, appeared as one message, and deduplicated replay |
| Application typecheck | Clean |
| Worker typecheck | Clean |
| Production application build | Successful on Next.js 16.2.6; 84 static pages generated |
| Focused ESLint | 0 errors (the two new test warnings were removed) |
| i18n hardcoded-string gate | Clean: 451 files, 41 documented exceptions |
| English/Arabic message parity | Clean: 4,203 base leaf messages |
| Relevant diff whitespace check | Clean |

The real linked test account was inspected **read-only and count-only** before deployment.
It was connected, had 10 delivered history batches, and still reported an unfinished
history stream (`history_final_batch_seen = false`). The old counters showed 9 imported
history chats and 95 imported message decisions. Across 13 WhatsApp conversations, only
3 had any persisted message rows and 10 had none; the database contained 40 inbound and
54 WhatsApp outbound rows for that clinic. This independently reproduces the reported
“names/chats exist, messages/previews missing” state. The one-row difference between the
old session import counter (95) and the 94 current rows cannot be classified from the old
schema, which did not record received/deduplicated/pending/unsupported counts separately.

No post-fix real-account counts are claimed: obtaining them requires the new migration and
worker code to run, which would be a deployment/restart and was explicitly out of scope.

### 11.6 Browser/device and WhatsApp limitations

- This environment cannot grant a physical microphone to browser automation. Therefore a
  real human microphone recording and real WhatsApp handset playback were not performed.
  Browser permission/track/Blob behavior is component-tested, decoded PCM is tested with
  real sample arrays, and the stored WebM-to-Baileys pipeline uses the production ffmpeg
  implementation, but a manual microphone-to-phone smoke remains required before release.
- WhatsApp decides the finite history sent to a newly linked companion. ClinicFlow now
  imports all safe 1:1 records Baileys emits and retains unresolved ones, but it cannot
  request or fabricate messages WhatsApp never supplies. Some historical `fromMe` LIDs may
  arrive with no PN assertion at all; those correctly remain pending until WhatsApp later
  supplies an explicit mapping. This limitation is also discussed by Baileys maintainers:
  <https://github.com/WhiskeySockets/Baileys/discussions/2551>.
- Current Baileys history/mapping behavior is tracked from the project sources rather than
  guessed from LID digits:
  <https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/history.ts> and
  <https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/process-message.ts>.

### 11.7 Browser false-silence follow-up (2026-08-21)

Status: **fixed and verified locally; not deployed.** This follow-up changed only the browser
microphone/recorder path, its English/Arabic UI copy, focused tests and this report. It did
not change the worker, QR/session/reconnect/history/provider code, database, linked identity
or WhatsApp account.

#### Root-cause classification

The reported `recordingSilent` message is emitted only after `MediaRecorder` produced a
nonempty Blob and `decodeAudioData` returned an `AudioBuffer`; a decode failure takes the
separate `recordingUnreadable` path. However, the old build did not record track mute state,
decoded sample count or PCM aggregates. It therefore collapsed these two cases into the same
boolean and cannot retroactively prove which one occurred on the user's historical Blob:

- **A:** a live/enabled but muted or wrong default track decoded to silence; or
- **B:** real speech decoded, but its whole-clip RMS was diluted by silence below the gate.

The actionable browser defect was reproduced as **B** with deterministic PCM: 100 ms of
quiet speech at peak `0.0012` inside a 10-second recording has whole-clip RMS below
`0.0001`, so the previous `peak AND whole-clip RMS` rule rejected it even though multiple
contiguous speech windows were audible. The same old code also checked `readyState` and
`enabled` but not `muted`, so it could not fail early for the A case. No physical-device
metric is invented for the historical recording.

#### Fix

- `getUserMedia` deliberately omits `deviceId`, so macOS/Chrome/Safari select the active OS
  or browser default. Mono 48 kHz, echo cancellation, noise suppression and automatic gain
  control are ideals/optional processing requests, not exact constraints that can exclude a
  valid microphone.
- Capture now requires one audio track with `readyState === "live"`, `enabled === true` and
  `muted === false` before constructing `MediaRecorder`. Development diagnostics record
  permission state, audio-input count, track state, redacted track settings and recorder MIME.
- The live meter is sourced directly from the `MediaStream` through
  `AudioContext` → `MediaStreamAudioSourceNode` → `AnalyserNode`. Its logarithmic display
  makes quiet input visible and the UI explicitly changes between “Speak to test the
  microphone” and “Microphone activity detected.”
- Decoded validation still requires duration ≥ 250 ms, a nonzero decoded sample count and
  peak ≥ `0.001`. Instead of requiring whole-recording RMS, it requires 20 ms RMS windows ≥
  `0.0001` for at least 60 ms. This accepts sustained quiet speech surrounded by silence but
  rejects zero PCM, zero samples, too-short input and a one-window click/transient. Whole-clip
  RMS remains measured and reported as a diagnostic.
- `MediaRecorder.isTypeSupported` and `decodeAudioData` support are not assumed to be
  identical. WebM/Opus or MP4 is decoded normally when Web Audio supports it. If that decode
  fails, upload is allowed only when the browser can parse the exact Blob as playable *and*
  the direct-stream analyser independently observed sustained audible PCM. If either check
  fails, the Blob is `recordingUnreadable` and is not uploaded. Worker source/output audio
  validation remains the final independent gate.
- Development logs contain only counts, timing, MIME, booleans and amplitude aggregates:
  recording duration, Blob size, decoded duration/sample count, peak, whole RMS, maximum
  window RMS, active voice duration and validation mode. They never contain labels, raw
  device IDs, object URLs, Blob/audio bytes or samples.

#### Verification and manual discriminator

| Verification | Result |
| --- | --- |
| Browser audio + composer tests | **17 passed**: live/default/unmuted track, reactive meter, silence, zero samples, too-short input and isolated-click rejection, quiet padded speech acceptance, browser-format fallback, and inspection-before-upload |
| Static checks | Application TypeScript and focused ESLint clean |
| Localization | **4,205** English/Arabic leaf messages in parity; hardcoded-string gate clean across 451 files |
| Production build | Successful on Next.js 16.2.6; 84 static pages generated |
| Worker defense-in-depth (unchanged) | **11 focused tests passed**; audible browser WebM/Opus → validated mono 48 kHz OGG/Opus → Baileys `ptt: true`; nonempty silent WebM rejected |

This execution environment exposed no controllable browser and cannot grant a physical
microphone, so a real microphone duration/Blob/peak/RMS result is not claimed. Manual local
testing is now decisive: open development DevTools, filter Console for `voice_recorder`, and
record while watching the meter. A stationary meter plus zero live peak/RMS identifies A;
a moving meter plus nonzero live aggregates followed by failed decoded aggregates identifies
an encoding/validation boundary. A successful run emits `recording-inspected` with all safe
aggregates, then creates the upload draft. The existing focused worker test establishes the
remaining conversion/OGG/Opus/`ptt: true` boundary without changing any connection code.

**Not deployed.** Only the local database received the earlier P8C migration. The remote
database, worker, web application, current QR-linked identity and real WhatsApp account were
not modified by this follow-up.

### 11.8 Proven real-device silent-input diagnosis and microphone selection (2026-08-21)

Status: **fixed and verified locally; not deployed.** This change is restricted to the
browser microphone input-selection UX, its local analyser state, English/Arabic copy,
focused browser tests and this report. WhatsApp transport, worker, ffmpeg, QR, sessions,
providers and history were not changed.

#### Conclusive diagnosis

A real macOS/Chrome capture resolved the ambiguity recorded in §11.7. Browser permission
was `granted`; Chrome exposed 6 audio inputs; the selected browser-default stream contained
one live, enabled, unmuted audio track. Despite that healthy track state, its analyser
reported `livePeak = 0`, `liveRms = 0` and `liveActiveVoiceSeconds = 0`.

`MediaRecorder` then produced a 1,963-byte Blob for 6.93 seconds. The Blob decoded
successfully to 6.9 seconds and 331,200 PCM samples, but decoded peak and RMS were both
approximately `2.03e-34` and active voice time was zero. This proves the selected
browser-default input was delivering digital silence. It was not a Blob decoding failure,
worker/ffmpeg defect, or audible-validation threshold false positive. The existing audible
recording thresholds remain unchanged.

#### Browser-only repair

- The first recorder action requests permission and opens a pre-recording microphone
  stream. Immediately after permission, the composer calls
  `navigator.mediaDevices.enumerateDevices()` and retains audio-input entries only.
- When more than one input exists, a compact selector shows Chrome's human-readable labels
  (for example, MacBook, AirPods, external and virtual microphones). Device IDs are never
  rendered as labels or written to diagnostics. Selector values use local opaque indexes.
- A previously successful explicit choice is restored from one browser-local
  `localStorage` value. It is requested with an exact `deviceId`. A missing or
  overconstrained stored device is removed and capture falls back to an unconstrained
  browser/default request. Server and clinic preference data are not involved.
- Changing the selector stops every track on the previous stream, closes its audio monitor,
  requests a fresh stream using the selected device's exact ID, checks that its track is
  live/enabled/unmuted, and attaches a new analyser. `MediaRecorder` is not created or
  started during this switch.
- The live meter is visible during microphone preflight and recording. A 1.2-second
  calibration watches peak, RMS and maximum-window RMS. Recording remains blocked until
  meaningful live energy is observed. A digitally silent input produces the actionable
  message: “No sound is coming from this microphone. Choose another input.” The selector
  remains available so another input can be tried immediately.
- After a microphone passes the live check, the employee explicitly starts recording. The
  monitor's aggregate inspection is reset at that boundary so calibration speech cannot be
  counted as recorded speech by the browser-format fallback. Final decoded-PCM validation
  of the exact Blob remains the independent defense-in-depth gate.
- A `devicechange` listener safely refreshes the input list. If the selected preflight
  device disappears, its stale local preference is cleared, the old stream is stopped and
  the browser/default input is reacquired. One-device browsers keep the simple UI without
  an unnecessary selector.

#### Focused coverage

The browser component suite now covers multiple labeled microphones, exact selection,
previous-selection restore, disappeared-device fallback, a digitally silent default, an
active alternate input, old-stream cleanup, `devicechange`, denied permission, the compact
one-device path, and successful recording after a switch. It also retains the existing
muted-track refusal, live-meter, decoded-silence rejection and inspection-before-upload
coverage. Together with the browser PCM suite, **27 focused tests passed** locally.

Development diagnostics remain privacy-safe: they contain only permission/count/state,
redacted settings and aggregate levels. Raw device IDs and labels are not logged.

**Not deployed.** No remote environment, worker process, linked session, QR identity,
WhatsApp account or database was changed.

## 12. P8D inbound voice/audio classification and Inbox rendering (2026-08-21)

Status: **fixed and verified locally; not deployed.** This repair is restricted to the
inbound Baileys message interpreter, inbound attachment ingestion/callback/persistence,
historical attachment normalization, Inbox attachment rendering, one additive migration,
localized attachment copy, and focused regression tests. QR pairing, auth state, sessions,
reconnect, outbound media, ffmpeg, provider selection and history delivery/spooling were not
changed.

### 12.1 Exact incident boundary and root cause

The currently linked environment was inspected with a read-only, privacy-safe aggregate.
No message body other than known generic markers and no identifier, JID, number, filename,
URL or media byte was emitted. It showed two recent `[image]` messages:

- the real image had one stored attachment with `media_kind = image` and MIME family
  `image`;
- the reported/misrendered message had no attachment row at all.

That proves the wrong classification occurred before callback persistence and Inbox
rendering. The running worker's media-only text fallback collapsed the message to
`[image]`, and it supplied no attachment metadata for downstream code to correct. The
local P8 worktree had already split the text markers (`audioMessage` became
`[voice message]`), but `media.ts` still contained a second decisive defect: an explicit
early return for every `audioMessage` and video, with `failureReason = kind_not_stored`,
before `downloadMediaMessage` was called. Thus even the improved local marker could never
produce playable inbound audio.

The fix makes the Baileys envelope authoritative for the coarse family:

- `imageMessage` / sticker → `image`;
- `videoMessage` / `ptvMessage` → `video`;
- `documentMessage` → `document`;
- `audioMessage` → `audio`, with `ptt === true` retained separately as `voiceNote`;
- unknown/unrecognized bytes → `unsupported`, never `image` by fallback.

An `audioMessage` whose downloaded bytes sniff as a non-audio format is now rejected as
`unsupported_type`; it is never relabeled as an image. Captionless PTT and ordinary audio
also have distinct safe body markers: `[voice message]` and `[audio]`.

### 12.2 Download, callback and durable metadata

Live inbound audio is now downloaded through the existing bounded attachment path, capped
by the existing attachment byte limit, SHA-256 measured, stored in the existing private
`whatsapp-inbound` bucket, and sent in the same signed callback as its message. Supported
sniffed audio containers are OGG, MP3, AAC, FLAC, WAV, WebM audio and MP4 audio. Ambiguous
WebM/MP4 containers require both the matching audio envelope/claim and a valid container
signature. WhatsApp's safe canonical MIME is retained, including
`audio/ogg; codecs=opus`, when it agrees with the sniffed bytes. Ordinary audio retains its
sanitized filename; PTT notes normally have none.

The existing `media_kind` check already included `audio`, so no enum expansion was needed.
Migration `20260821180000_p8d_whatsapp_inbound_audio.sql` adds only:

- `voice_note boolean not null default false`, constrained to `media_kind = 'audio'`;
- nullable, bounded `duration_seconds`.

Both values travel through the worker callback parser, inbound attachment upsert, generated
database types and Inbox loader. The callback parser defaults older worker payloads to
`voiceNote = false` / no duration. Persistence retries without the two new columns only for
an undefined-column/schema-cache error, and the Inbox reads P8D metadata separately from
the pre-P8D attachment fields. Therefore a rolling migration cannot make working inbound
images/documents disappear. Existing unambiguous historical audio rows whose body is
`[voice message]` are backfilled as PTT; ambiguous legacy rows are not guessed.

Historical sync uses the same `mediaMetadataFor` classifier as live ingestion. Historical
media still honestly remains `historical_media_unavailable` when WhatsApp no longer exposes
downloadable bytes, but its `audio` kind, PTT flag, duration, MIME and filename metadata are
preserved through immediate and unresolved-LID staging/reconciliation paths.

### 12.3 Inbox and safe degradation

Stored PTT notes render as an inline native audio control labeled “Voice note”; stored
ordinary audio renders through the same control with its filename (or “Audio file”). The
persisted duration is shown as `m:ss`, and the `<source>` retains the normalized MIME/codec.
The image branch is unchanged. Video remains correctly classified as `video` and currently
degrades to the explicit unavailable-media row rather than being downloaded or shown as an
image. Unsupported or invalid bytes likewise retain a generic unavailable marker.

Inbound media diagnostics contain only `mediaKind`, attachment presence, MIME family, PTT
boolean and duration presence (plus the existing clinic-scoped log binding). They contain no
message body, JID, phone number, filename, URL, storage path or media content.

### 12.4 Regression coverage and results

| Verification | Result |
| --- | --- |
| Worker normalization/ingestion/history | **69 passed** across `inbound-messages`, `attachments`, and `history-import`; includes image, PTT voice, ordinary audio, video, document, historical PTT, wrong-byte rejection and the existing image path |
| Complete WhatsApp worker suite | **156 passed**, including the untouched QR/session/reconnect/outbound/history regressions |
| Callback, persistence, schema compatibility, migration and Inbox UI | **55 passed** across five focused Vitest files; includes codec/PTT parsing, attachment-row `voice_note`/duration persistence, migration constraints/backfill, inline PTT player, ordinary-audio filename/player, no-image rendering, and existing image rendering when P8D metadata columns are absent |
| Local Supabase P8 integration | Additive P8D migration applied locally; **48 passed**, including real-Postgres `media_kind = audio`, PTT, duration, MIME and storage-path persistence plus existing image/replay/tenant regressions |
| Full non-integration application suite | **395 files / 3,314 tests passed** |
| Application TypeScript | Clean |
| Worker TypeScript and production compilation | Clean |
| Production application build | Successful on Next.js 16.2.6 (existing middleware-deprecation/NFT tracing warnings only) |
| Focused ESLint | Clean |

Real-device post-fix verification was not performed because the fix was explicitly not
deployed, and the connected worker therefore still runs the pre-fix inbound classifier.
Sending another handset voice note to it could only reproduce the known old behavior; it
could not exercise these local changes. The read-only pre-fix database evidence above is
reported separately and no post-fix production claim is made.

**Not deployed.** The additive P8D migration was applied to the local Supabase stack for
integration verification only. No QR/session/auth/reconnect state, linked identity, remote database,
worker process, web application, provider route, outbound media path or WhatsApp account was
modified.

## 13. P8E inbound audio persistence and ClinicFlow voice playback (2026-08-21)

Status: **root cause proven on the linked environment; fixed and verified locally; not
deployed.** This follow-up does not revisit the working P8D classification or Inbox audio
rendering. It changes only inbound media download context/diagnostics, the private inbound
bucket MIME allow-list, attachment-persistence diagnostics, and browser-side recording
preview/playability checks.

### 13.1 Exact live failure boundary

A privacy-safe, read-only inspection of the linked environment found the reported PTT
attachment with all of the following properties:

- media kind `audio`, PTT/voice-note flag true, and an audio MIME family;
- duration present;
- **8,518 downloaded/validated bytes**;
- attachment status `failed`, reason code `storage_failed`, and no storage reference.

The same read-only inspection found the private `whatsapp-inbound` bucket at its expected
16 MiB limit, but its allow-list admitted only image, application and text families. It
admitted **no audio MIME type**. This is the exact defect: P8D enabled audio in the worker
and database attachment contract, but the earlier P8 bucket migration remained
image/document-only. The worker successfully downloaded and sniffed the encrypted PTT,
then Storage rejected `audio/ogg`. The callback correctly persisted a failed attachment
without a storage path, which is why Inbox honestly displayed “This file could not be
saved” instead of creating a misleading playable record.

Migration `20260821210000_p8e_whatsapp_inbound_audio_storage.sql` retains the bucket as
private, retains its existing size limit and image/document allow-list, and adds only the
validated audio types used by the worker: AAC, FLAC, MP4 audio, MP3, OGG, WAV and WebM
audio. Codec parameters remain on the attachment row for browser playback; Storage receives
the canonical base type such as `audio/ogg`, matching its allow-list.

### 13.2 Baileys encrypted-media download

The installed Baileys 6.7.24 implementation was checked at its actual call boundary.
`downloadMediaMessage(message, "buffer", options, context)` unwraps the original
`WAMessage` and passes the complete media node to `downloadContentFromMessage`; that node
contains the encrypted-media metadata Baileys needs, including `mediaKey` and
`directPath`/`url`. ClinicFlow continues to pass the original message rather than attempting
a raw URL fetch.

The production downloader now also supplies the connected socket's
`updateMediaMessage` as Baileys' `reuploadRequest`. A 404/410 can therefore use Baileys'
supported media-refresh retry when WhatsApp still makes the object recoverable. Its Baileys
logger is deliberately silent because the library's re-upload log includes the message key;
ClinicFlow emits only the safe stage diagnostics below. No QR, auth, session, reconnect or
provider-routing logic changed.

After download, a zero-length buffer is rejected as `empty_file`, the actual byte cap is
rechecked, and byte signatures must identify supported audio. An `audioMessage` whose bytes
are not audio is rejected as `unsupported_type`; image behavior is not used as a proxy for
audio behavior.

### 13.3 Safe stage diagnostics and durable persistence

The complete inbound lifecycle now emits:

1. `inbound_audio_detected`
2. `media_download_started`
3. `media_download_completed` or `media_download_failed`
4. `storage_upload_started`
5. `storage_upload_completed` or `storage_upload_failed`
6. `attachment_persist_started`
7. `attachment_persist_completed` or `attachment_persist_failed`

Each event is structurally limited to clinic ID, media kind, voice-note boolean, MIME
family, byte count, duration presence, and—only on failure—a sanitized category/code.
Diagnostics do not accept or emit JIDs, numbers, bodies, filenames, URLs, object paths,
encryption keys, media bytes, raw Baileys objects or raw upstream error messages.

Persistence starts only after ingestion has produced the final attachment outcome. A
successful upload produces a `stored` row containing `media_kind = audio`,
`voice_note = true` for PTT, bounded `duration_seconds`, the preserved audio MIME, byte
count/hash and storage reference. A download, validation or upload failure has no storage
reference and cannot be represented as stored. Database-upsert failure emits
`attachment_persist_failed` with only the safe database code.

### 13.4 Fresh recording preview and sent-message playback

The additional real-device observation is separate from the inbound Storage defect:
WhatsApp received and audibly played the outbound voice note, while ClinicFlow's freshly
created local preview stayed at `0:00 / 0:00`.

Code inspection found two concrete browser-side gaps:

- the recorder format was chosen from `MediaRecorder.isTypeSupported()` alone, even though
  recorder support and native `<audio>` playback support can differ by browser/version;
- the Blob URL belonged to render-derived state and could be replaced/revoked across
  attachment state transitions instead of remaining stable for the life of the preview.

Recording/send behavior is otherwise unchanged. ClinicFlow now selects the first MIME type
supported by both `MediaRecorder` and the native audio element, requires the completed Blob
to load as native audio in addition to the existing audible-PCM validation, and owns one
stable Blob URL from “ready” through send. It revokes that URL only when the employee
removes/replaces the attachment, a send succeeds, or the composer unmounts.

A read-only check of the newest real `sent` outbound voice row separately proved the
server-side post-send path: its private object could be signed and read with HTTP 200, its
declared and downloaded sizes both equaled **271,137 bytes**, and its MIME family was audio.
Thus the stored sent-media object is available to ClinicFlow without making its bucket
public. Actual audible browser playback of the post-fix UI remains part of the pending
real-device run below.

### 13.5 Verification results

| Verification | Result |
| --- | --- |
| Complete WhatsApp worker suite | **157/157 passed**; includes live-style PTT and ordinary audio download, encrypted metadata passed only to Baileys, non-empty/type validation, storage success/failure, safe diagnostics, image regression, history metadata and unavailable-media fallback |
| Focused application regression | **58/58 passed** across six files; includes P8E migration, PTT persistence stages, preview URL stability/revocation, recorder/player MIME intersection, native-unplayable rejection, private sent-audio rendering and existing P8D behavior |
| Local Supabase P8 integration | P8E applied to the local stack only; **48/48 passed** against real Postgres, including audio/PTT/duration/MIME/storage-reference constraints and existing image/replay/tenant cases |
| Private local Storage round trip | Audio upload accepted; signed read returned the same non-empty byte count; test object removed; bucket remained private |
| Application and worker TypeScript | Clean |
| Focused ESLint | Clean |

### 13.6 Real-device result and remaining acceptance run

The **pre-fix real linked-device result is conclusive**: PTT classification and download
succeeded, 8,518 non-empty audio bytes reached the upload boundary, the remote bucket's
image/document-only allow-list rejected them, and Inbox rendered the resulting failed row.
The user's real outbound result is also retained: the recipient received and heard the
voice note, while the old ClinicFlow local preview did not play.

The **post-fix real-device matrix has not been executed** because neither this migration nor
this code was deployed, as requested. The remote bucket still lacks the new audio MIME
entries, and starting a competing local worker against the linked identity would touch the
session/reconnect boundary explicitly excluded from this task. No post-fix handset or
audibility claim is made.

After the normal deployment/restart boundary, acceptance must use newly created media and
record the safe stages above for:

- inbound PTT: stored, signed, visible as a voice note, playable and audibly verified;
- inbound ordinary audio: stored, signed, visible as audio, playable and audible;
- inbound image: unchanged stored/signed/rendered regression;
- historical audio: downloaded where WhatsApp refreshes it; otherwise the existing honest
  `historical_media_unavailable` fallback;
- expired/unavailable media: `media_download_failed` with a safe category/code, a failed or
  rejected attachment with no storage reference, and graceful Inbox fallback;
- new employee recording: non-zero native preview duration, audible before send, successful
  send, then private signed sent-message playback and audible verification.

**Not deployed.** Only the local Supabase stack received P8E for integration/storage
verification. The remote database/bucket, worker, web application, linked identity and
WhatsApp account were not modified.

## 14. P8F voice regressions: sendability versus preview and authenticated playback (2026-08-21)

Status: **both regression causes identified and fixed locally; stored production-like media
verified read-only; not deployed.** This section supersedes the browser hard-gate conclusion
in §13.4. It does not change QR, linked-session auth, reconnect, provider selection, history,
text, image, or WhatsApp addressing behavior.

### 14.1 Outbound regression — exact branch and correction

The P8E preview repair introduced the outbound regression in
`lib/messaging/browser-audio.ts`. `AudioCaptureMonitor.inspect()` called
`blobIsPlayable(blob)` before `decodeAudioData()`, and threw `NotSupportedError` whenever a
temporary native `<audio preload="metadata">` element errored or did not emit
`loadedmetadata` inside two seconds. The composer caught that exception and displayed “The
browser could not verify this recording.” A second restriction in `recordingMimeType()`
selected only the intersection of `MediaRecorder.isTypeSupported()` and native
`HTMLMediaElement.canPlayType()`.

Those checks conflated two independent capabilities. The native player can reject or delay
metadata for a recorder Blob that Web Audio decodes into valid audible PCM and that the worker
can decode/transcode successfully. As a result, valid speech was rejected before upload even
though the stronger audible-sample proof was available.

The corrected trust order is:

1. choose a format that `MediaRecorder` can actually produce;
2. require a non-empty completed Blob;
3. decode the exact Blob with Web Audio and apply the existing duration/sample/peak/windowed
   RMS/contiguous-activity silence rules;
4. if decoded PCM is audible, mark the recording sendable without consulting native metadata;
5. only when Web Audio cannot decode the recorder's own format, retain the conservative
   fallback requiring both sustained live PCM and a natively readable recorder container;
6. let the worker independently decode the uploaded source, reject silence, transcode it to
   48 kHz mono OGG/Opus, validate the output, and only then send it as PTT.

Native Blob playback is now preview-only. The stable Blob URL remains attached to the composer
and CSP explicitly allows `blob:` under `media-src`, so supporting browsers still preview it;
a preview metadata failure no longer changes send eligibility. The silence constants and
decoded/live PCM criteria were not lowered or bypassed.

### 14.2 Inbound regression — exact browser boundary

A read-only check of the newest stored inbound PTT proved that storage and HTTP delivery were
healthy before changing code:

- the row reported PTT, an OGG/Opus MIME and approximately four seconds;
- database byte count, downloaded byte count and SHA-256 all matched at **11,406 bytes**;
- the object began with the Ogg signature and contained an Opus header;
- a fresh private signed read returned **HTTP 200**, `Content-Type: audio/ogg`,
  `Content-Length: 11406`, `Accept-Ranges: bytes`, and exactly 11,406 bytes;
- `Range: bytes=0-15` returned **HTTP 206**, `Content-Range: bytes 0-15/11406`, and 16 bytes;
- FFmpeg decoded **228,168 mono 48 kHz samples (4.7535 seconds)** with peak `0.902130` and RMS
  `0.085994`.

This rules out failed WhatsApp download, corrupt storage, wrong object MIME, a byte-count/hash
mismatch, an expired URL at inspection time, absent range support, and silent/unplayable bytes.

The broken boundary was the application CSP. `next.config.ts` defined no `media-src`, so audio
fell back to `default-src 'self'`. The Inbox supplied a cross-origin Supabase signed URL; the
browser blocked that URL before native metadata could load, yielding `0:00 / 0:00`. The player
had no `loadedmetadata`/`canplay`/`error` diagnostics to distinguish that policy refusal from a
decoder or storage failure. Even after adding the missing CSP source, a signed URL minted only
during server render would still expire after one hour in a long-lived Inbox tab.

Inbound audio now uses a stable same-origin endpoint:
`/api/inbox/voice/<attachment-id>`. On every request it authenticates the staff user, restricts
access to the two Inbox roles, reads attachment metadata through the caller's clinic-scoped RLS
client, repeats the clinic/path check at the service-role storage boundary, downloads the
private object, and verifies audio MIME, stored byte count and SHA-256 before responding. It
returns `audio/*`, `Content-Length`, `Accept-Ranges: bytes`, full **200** responses, single-range
**206** responses with `Content-Range`, **416** for invalid ranges, and `private, no-store`.
Because the browser source is same-origin and stable, no signed URL reaches the DOM, no CORS
grant is required, and there is no source-expiry lifecycle. Images and documents retain their
existing signed-link behavior.

The player now sets `src` directly and lets the response's actual `Content-Type` drive native
selection instead of pre-filtering through a possibly mismatched `<source type>`. A safe HEAD
probe and native `loadstart`, `loadedmetadata`, `canplay`, and `error` handlers distinguish HTTP,
MIME, byte-count, range, network and decoder failures.

### 14.3 Safe diagnostics

Two explicit event families were added:

- `voice_outbound_validation_stage`: Blob-ready, decoded/live PCM inspection, silence refusal,
  unreadable refusal, worker FFmpeg start/completion/failure, source/output byte counts and safe
  failure codes;
- `voice_playback_load`: authorized request, HTTP response/failure, status, actual audio MIME,
  object/response byte counts, range request/support, native ready/network state, positive
  duration when available, and coarse error category.

Neither schema accepts or emits audio bytes, Blob/signed/object URLs, filenames, attachment or
conversation identifiers, message content, phone numbers, JIDs/provider addresses, or raw
upstream errors.

### 14.4 Verification and remaining device acceptance

| Verification | Result |
| --- | --- |
| Focused application regression | **52/52 passed** across decoded PCM inspection, recorder/composer, Inbox player/HTTP diagnostics, and the authenticated full/HEAD/range endpoint |
| Complete WhatsApp worker suite | **157/157 passed**, including real FFmpeg audible WebM → validated OGG/Opus and silent-source rejection |
| Application TypeScript | Clean |
| Worker production/test TypeScript | Clean |
| Production application build | Successful on Next.js 16.2.6; the authenticated voice route is present in the generated route manifest (existing middleware-deprecation/PDF tracing warnings only) |
| Focused ESLint and diff whitespace | Clean |
| Read-only stored PTT inspection | Byte count/hash/container/codec matched; signed 200 and ranged 206 responses were correct; FFmpeg decoded 4.7535 seconds of audible PCM |

Real-device acceptance remains required after the normal deploy/restart boundary: record normal
speech, confirm decoded PCM is audible, confirm preview where the device supports it, send and
listen on the recipient; then receive a fresh WhatsApp PTT, confirm stored duration, native
duration greater than zero, successful Play, and audible output. No claim is made that those
post-fix browser/device steps ran locally.

**Not deployed.** No remote database, bucket, worker, web application, WhatsApp session, linked
identity, provider, QR/reconnect state or patient communication was changed by this follow-up.
