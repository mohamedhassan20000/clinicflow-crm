# P11D — Booking state continuation fix

Conversation traced: `763b1c6b-c388-4f36-b8ca-965f71f20f86`
Clinic: `caf2711f-97cb-4474-a103-f9505f467087` · Turns 28–31 · 2026-08-24 15:39–15:40 UTC
Remote DB accessed **read-only**. No migration. No deploy. No push.

---

## 1. Exact runtime root cause

**The department was never selected, and the roster the patient saw was never an offer the
server recorded.** Both alternating replies were the same pair of deterministic templates,
emitted by a *stateless* fallback that re-derived its context from the current inbound
message on every turn and persisted nothing.

The model never called a booking tool on any of the four turns. Its prose reply named
doctors; `checkDoctorGrounding` rejected it against an empty allowed-set; the
`unbacked_roster` branch replaced the reply wholesale — correctly, since the alternative is
a phantom roster. But that replacement was a *render*, not a *transition*. Because it wrote
nothing, `offeredDoctorIds` stayed `[]` forever, which guaranteed the next roster-bearing
turn would re-enter the same branch.

This is a **livelock**, not state loss: the fallback's own statelessness was the thing that
kept re-arming it.

## 2. Exact trace for the "حنين" turn

From `audit_logs` (`actor_type='ai'`), turns 28–31, verbatim:

| turn | inbound | `tool_called` | stage before → after | grounding |
|---|---|---|---|---|
| 28 | "…نكمل؟ انا عايز احجز لابني **علاج طبيعي**" | `none` | `idle` → `selecting_department` | `violation` (2) → `deterministic/unbacked_roster` |
| 29 | **"حنين"** | `none` | `selecting_department` → `selecting_department` | `violation` (1) → `deterministic/unbacked_roster` |
| 30 | "ازاي يبني مش دول دكاترة **العلاج الطبيعي**…" | `none` | `selecting_department` → `selecting_department` | `violation` (1) → `deterministic/unbacked_roster` |
| 31 | **"حنين"** | `none` | `selecting_department` → `selecting_department` | `violation` (1) → `deterministic/unbacked_roster` |

Every grounding row carried `server_backed: false`, `offered_doctor_count: 0`,
`roster_bearing: true`. Every stage row carried `legal_transition: true`,
`illegal_transitions_total: 0`.

Per-turn state, as persisted:

- `stage_before` / `stage_after` — as tabled above; never left `selecting_department`.
- `ai_booking_stage` (final) — `{"stage":"selecting_department","turnCount":31,`
  `"bookingForOther":true,"offeredDoctorIds":[],"offeredDays":[],"offeredSlots":[],`
  `"intakeStaged":false,"submitted":false,"escalated":false,"appointmentLookup":null,`
  `"illegalTransitions":0,"lastToolOutcome":{"tool":"patient_escalation",`
  `"outcome":"escalated","at":"2026-08-24T14:44:29.390Z"}}`
- `ai_collected_data` (final) — `{"appointment_date":"2026-08-23"}`
- `selectedDepartmentId` — **absent on every turn**
- `selectedDoctorId` — **absent on every turn**
- `offeredDoctorIds` — **`[]` on every turn**
- `bookingForOther` — `true` (latched 2026-08-23, "بحجز لزوجتي" / "لابني")
- `appointmentLookup` — `null`
- mounted tools — `STAGE_WORKFLOW_TOOLS.selecting_department` = `["prepare_booking",
  "list_doctors"]`; both **were** mounted
- tool called / args / outcome — **none, on all four turns**
- repair — **did not run** (no tool call exists to repair)
- grounding changed the reply — **yes, on all four turns**; the model's text was discarded
  and replaced
- state persisted after the tool — **none**

The alternation is fully explained by `buildAuthoritativeReply`'s fallback to
`resolveNamedEntity(latestPatientText, departments)`:

```
turn 28  message names a department  → Physical Therapy → roster template
turn 29  "حنين" names no department  → null            → DEPARTMENT LIST   ← restart
turn 30  message names a department  → Physical Therapy → roster template
turn 31  "حنين" names no department  → null            → DEPARTMENT LIST   ← restart
```

## 3. Which state was missing / lost / wrong

Missing, never written: `department_id`, `doctor_id`, `offeredDoctorIds`.
Nothing was *lost* — there was never anything to lose. Nothing was *wrong*: every value the
system held was an accurate record of a booking that had never advanced.

## 4. Why the flow restarted at departments

Because `buildAuthoritativeReply` had exactly one input for "which department are we in?"
that could ever be non-null on turn 29 — the text of turn 29 — and "حنين" is a person's
name. With `establishedDepartmentId(collected)` null (nothing had ever been persisted) and
the message naming no department, `department` resolved to `null`, and the `null` branch of
`buildDeterministicRosterReply` is the department list.

Against the hypothesis list in the brief: **not A–J. It is K.** Specifically A is nearly
right but for the wrong reason — the department was never persisted not because a write was
missed, but because *no write path existed on that turn at all*.

## 5. Did tool-call repair contribute?

**No.** `experimental_repairToolCall` never executed. Repair is invoked only for a
malformed tool call, and `tool_called: "none"` on all four turns means no tool call was
produced to repair. Audited and excluded.

## 6. Did `bookingForOther` contribute?

**No.** The latch was `true` and remained `true` throughout, but it is read by `deriveStage`
only *after* the `department_id` and `doctor_id` branches:

```ts
if (!has(collected, "department_id")) return "selecting_department";  // ← returned here
if (!has(collected, "doctor_id"))      return "selecting_doctor";
if ((!linked || bookingForOther) && !intakeStaged) return "intake_collecting";
```

The conversation returned at line 1 on every turn, so the latch was never reached. Its
lifecycle is a real open item (see §13) but it is **not** implicated in this defect, and it
has deliberately not been changed here — reworking a data-isolation latch that the trace
exonerates would be risk without cause.

## 7. New state invariant

> **A roster the server puts in front of a patient is an offer, and an offer is state.**

Anything authoritative enough to say to the patient is authoritative enough to persist. The
deterministic reply now commits exactly what the equivalent tool would have committed,
through the same two calls `prepare_booking` and `list_doctors` use:

- `setConversationAiState({ collected })` → `department_id`, `department_name`, and on a
  doctor selection `doctor_id` / `doctor_name`
- `recordStageTurn(identity, { collectedOverride, offeredDoctorIds | offeredDays })`

The stage then derives forward on its own. Structurally this closes the livelock: the branch
that fires on an unbacked roster now *creates* the backing it was missing, so it cannot fire
for the same reason twice.

Monotonicity is enforced by construction rather than by a rule. In
`continuePatientBookingFromRoster` the only path that reaches the department list requires
`currentDepartmentId === null`, and the only path that changes department requires
`resolveDepartmentChange` to return a *different* department. A bare doctor name satisfies
neither, so `selecting_doctor → selecting_department` is unreachable for "حنين" — the same
technique `LEGAL_EDGES` already uses for "مين غيره؟".

## 8. Generic doctor-selection behavior

`lib/ai/offered-doctor-resolution.ts` is pure and closed-world: it takes the offered roster
as an argument and can only return a member of it. Two passes, in order:

1. **Ordinal**, against the roster in the order it was offered, after title-stripping — so
   "الدكتور التاني" reads as position 2. An out-of-range ordinal is `no_match`, never
   clamped.
2. **Name**, via `resolveNamedEntity` against the offered members only, then a
   cross-script skeleton pass.

Three gaps in the existing shared resolvers were found by these tests and fixed generically:

- **Ordinals** — `ordinalIndex` knew only MSA masculine forms. Added feminine ("الأولى"),
  Egyptian ث→ت spellings ("التاني", "التالت"), and counting prefixes ("رقم ٢", "number 2").
- **Cross-script names** — `يوسف` transliterates to `ywsf` against a stored `Youssef Adel`,
  scoring 0.25. A consonant-skeleton comparison (`ywsf` → `ysf` ← `youssef`) is applied
  **only** within the offered set, where the candidate list is a couple of dozen names the
  patient has just read and the worst error is visibly correctable. It is deliberately *not*
  added to `literalScore`, where a lossy key would reach a stranger's record.
- **Ordinal-as-department** — `resolveNamedEntity` reads an ordinal positionally against
  whatever list it is given, so "الأول" against the department list resolved to *department
  one*. `resolveDepartmentChange` now rejects bare ordinals outright. This was caught by the
  live-Postgres test, not by the mocked one.

No department name, doctor name or clinic vocabulary appears in any of this. Candidates are
always the directory loaded that turn.

## 9. Third-party lifecycle behavior

Unchanged and untouched, by design (§6). Two properties are pinned by new tests: the
continuation never writes `bookingForOther` in any patch, and a third-party conversation
resolves a doctor identically to a self-booking. Booking *subject* and booking *target* stay
separate — this module only ever writes the target.

## 10. Files changed

| File | Change |
|---|---|
| `lib/ai/offered-doctor-resolution.ts` | **new** — pure, closed-world offered-roster resolver + explicit department-change test |
| `lib/ai/patient-roster-continuation.ts` | **new** — the state-committing deterministic continuation |
| `lib/ai/patient-reply-grounding.ts` | `buildAuthoritativeReply` delegates to the continuation; pre-P11D render kept as `buildStatelessRosterReply` degraded path |
| `lib/ai/entity-resolution.ts` | widened `ordinalIndex`; added `stripEntityTitles` export |
| `lib/ai/patient-grounding.ts` | added `buildDeterministicDoctorChoiceReply`, `buildDeterministicDaysReply` |
| `tests/unit/ai/p11d-booking-state-continuation.test.ts` | **new** — 29 tests |
| `tests/unit/integration/p11-generic-multi-department-booking.test.ts` | +6 real-Postgres P11D tests |

Untouched, as instructed: WhatsApp QR, session, media, voice, provider, history import.

## 11. Migration status

**None required, none created.** The fix writes only to `conversations.ai_collected_data`
and `conversations.ai_booking_stage`, both of which already exist and already carry these
exact keys. No schema change, additive or otherwise.

## 12. Tests / results

| Suite | Result |
|---|---|
| New P11D unit regression | **29 passed** |
| P11D integration (real local Postgres) | **6 passed** (file total 23) |
| Full AI unit suite | **92 files, 1683 passed**, 2 skipped |
| Full unit suite (`pnpm test`) | **422 files, 3885 passed**, 2 skipped |
| Integration suite (`pnpm test:integration`, real Postgres) | **64 files, 646 passed**, 3 skipped |
| Adversarial (`pnpm test:ai-adversarial`) | **136 passed** |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors (28 pre-existing warnings, none in changed files) |
| `pnpm lint:i18n` | pass (455 files, 41 documented exceptions) |
| `pnpm lint:rtl` | pass (744 files, 17 documented exceptions) |
| `pnpm build` | ✓ compiled in 15.0s |
| `git diff --check` | clean |

Integration count rose 640 → 646, which is the six new tests and nothing else.

**The two defects the mocked tests missed** — opening-move mislabelled as
`department_changed`, and ordinal read as a department — were both caught only by the
real-Postgres run. That is the argument for §13 existing, and it is why the result above is
not being reported on the strength of the unit suite alone.

## 13. Remaining limitations

1. **The model still does not call tools on these turns.** P11D makes the deterministic
   fallback correct and state-advancing, so the patient now progresses; it does not diagnose
   *why* `prepare_booking` was skipped four times with the tool mounted. That is a separate
   investigation (prompt, briefing, or tool-description issue) and is the higher-value
   follow-up. The fallback is now a safe floor rather than a dead end.
2. **`bookingForOther` still has no release.** Confirmed not implicated here (§6) and
   deliberately left alone. It remains a real open item: a completed third-party booking
   leaves the latch set, so a later self-booking on the same thread still derives
   `intake_collecting`. Worth a typed lifecycle, but on evidence, not on suspicion.
3. **The skeleton pass is lossy by design.** Two offered doctors with the same consonant
   skeleton return `ambiguous` rather than a guess, which is correct but will occasionally
   ask a question a human would not need to.
4. **`getPatientAvailableDays` is called with a fixed 30-minute duration** in the
   continuation, matching the tool default. A clinic whose services differ materially may
   see a slightly different day list than `list_available_days` with an explicit service.
5. **Days are rendered as ISO dates.** Correct and unambiguous, but less natural than the
   model's usual phrasing; this is a deterministic-path reply, so it trades warmth for
   truth.

## 14. Verdict

**SAFE TO PUSH.**

Not on the test results alone. The state-machine argument is:

`continuePatientBookingFromRoster` has exactly one branch that emits the department list,
and reaching it requires `currentDepartmentId === null`. Once any department is committed —
and the roster-offering branch now always commits one — that condition is permanently false
for the rest of the conversation, unless `resolveDepartmentChange` returns a *different*
department, which requires the message to resolve against the clinic's own department list
and to not be a bare ordinal. A plain doctor reply such as "حنين" resolves against
departments to nothing. Therefore the turn that produced the bug is now structurally
incapable of producing it: the restart is not discouraged, it is unreachable — the same
property `LEGAL_EDGES` gives `selecting_doctor`.

Nothing was deployed, nothing was pushed, and the remote database was read only.
