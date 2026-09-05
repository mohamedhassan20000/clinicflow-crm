# AI Assistant — Action Routing Fix

**Date:** 2026-08-16
**Branch:** `feat/p7-manual-qa-polish`
**Fixes:** `docs/reports/AI_ASSISTANT_ACTION_ROUTING_REVIEW.md`
**Status:** Implemented, tested locally. Nothing pushed, deployed, or applied remotely.

---

## 1. What was wrong, in one paragraph

`isHelpIntent` detected the *mood* of a sentence, not its content. Any instructional
opener — "how do I…", "where do I…", "walk me through…", "كيف أ…" — routed the turn to
`staff_help`, which is the one certified class narrow enough to unmount `execute_action`
and `describe_action`. A fully-specified, authorized, entitled booking request therefore
lost the entire registered write surface on nothing more than a question mark, and the
model, obeying `lib/ai/prompts/help.ts`, answered with a navigation link. The defect was
action-agnostic, so it hit every registered write across every domain, all five staff
roles, and both languages.

---

## 2. Exact routing change

### 2.1 Guard 3 — the actionable-write override

`lib/ai/platform/execution.ts`. `isHelpIntent` is unchanged and still means "this reads
like a request for instructions". A third guard now sits between it and the route:

| Symbol | Line | Role |
|---|---|---|
| `WRITE_INTENT_RE` | L227 | English write-verb lexicon (explicit inflected forms) + Arabic stems |
| `arabicStems()` | L260 | Bounds an Arabic stem with `(?<![ء-ي]) … (?![ء-ي])`, tolerating the attached `و/ف/ل/ب/ك` + `ال` prefixes, the imperfect/imperative inflection (`ألغ` → `ألغي`), and object-pronoun suffixes (`أحجز` → `أحجزه`) |
| `OPERAND_RE` | L273 | Clock times, ISO/numeric dates, weekdays, months, file/record numbers, `Dr. <name>` / `د. <name>`, Arabic date-time vocabulary, Arabic patient/file markers |
| `NON_NAME_CAPITALIZED` | L307 | Product and page nouns excluded from proper-name detection ("the **Appointments** page" is not a person) |
| `hasProperNameOperand()` | L327 | A capitalized Latin token that does not open its sentence — case-sensitive, so it cannot live in the `i`-flagged `OPERAND_RE` (`\p{Lu}` under `i` matches lowercase) |
| `CONTEXT_REFERENCE_RE` | L351 | A pronoun/deictic that only means something against a live conversation entity |
| `hasWriteIntentVerb()` | L368 | Signal 1, exported for tests |
| `hasConcreteOperand()` | L372 | Signal 2, exported for tests |
| `isActionableWriteRequest()` | L386 | Their **conjunction** |

`staffTaskForRole` (L436) now reads:

```
helpPhrasing   = isHelpIntent(text)
actionableWrite = helpPhrasing && isActionableWriteRequest(text, { hasActiveEntityContext })

if (helpPhrasing && !actionableWrite)  -> staff_help            (unchanged behavior)
if (isCompositeIntent(text))           -> staff_composite
if (isClinicalRole)                    -> staff_clinical_summary
if (actionableWrite)                   -> staff_administrative  (new, L491)
otherwise                              -> operational / administrative as before
```

Three ordering decisions worth stating:

- The override is evaluated **inside** the help branch, because that branch returned
  before any other signal was consulted.
- Composite is checked **after** the help escape, so a turn that is both instructional and
  multi-step ("how do I check availability for Dr. Sara on Sunday **and then** book Ahmed
  Ali at 10:00?") lands on `staff_composite`, not `staff_administrative`.
- An overridden administrative turn is pinned to `staff_administrative` rather than falling
  through to `isOperationalQueryIntent`. Its domain noun ("invoice", "follow-up") matches
  the operational matcher, and a preview → confirm → execute turn must not inherit the
  budget sized for a typed aggregate. Clinical roles take `staff_clinical_summary` by the
  normal persona split.

No budget change was needed (review §7.4): an overridden turn leaves `staff_help` entirely
and inherits the destination class's own certified policy.

### 2.2 Multi-turn: the router now sees the conversation

`app/api/agent/chat/route.ts`. The class used to be computed from the current user message
alone, which is why the reported turn 3 — "how do I book him for that slot?", whose only
operands were resolved in turns 1 and 2 — read as a bare documentation question. The
conversation is now loaded **before** routing, and the router receives
`hasActiveEntityContext`.

- New `hasActiveEntitySlot()` in `lib/ai/conversation-context.ts` reports *presence* of any
  P4.10 entity slot. Never an id, never a label, never an authorization input.
- A launcher-opened conversation has no persisted slot on its first turn (the page-context
  seed runs later in the request), so a non-null page context counts as a live entity for
  operand purposes only.
- `ensureDoctorConversation` is a pure read — a first turn stays virtual until it is
  persisted — so moving it earlier creates nothing for a turn that later fails the
  entitlement, usage, or budget checks in `prepareAiExecution`.

**One observable consequence, deliberate:** a turn rejected for `invalid_patient_context`
now fails *before* the budget reservation instead of after it. The caller still gets the
same 400 `invalid_request`; the ledger simply gets one fewer reserve/reconcile pair.
`tests/unit/api/p4b-chat-route.test.ts` asserts both the new short-circuit and, in a new
sibling test, that a failure *after* routing still reserves and reconciles as `failed` /
`request_failed`.

### 2.3 Mount backstop (review §7.2a)

`lib/ai/tools/registry.ts`: `describe_action` gains `staff_help` via a new
`DESCRIBE_ACTION_TASKS` list. It is permission-filtered registry metadata and reads no
clinic table, so the containment property is untouched. `execute_action` deliberately does
**not** get this treatment — mounting the write carrier would make `staff_help` no longer
the narrow class its cheaper model and 4-step budget are certified against. The router is
the fix; this only makes a help turn recoverable rather than a dead end.

### 2.4 The composite landmine (review §6.1) is pinned, not tightened

`lib/ai/tools/index.ts` gains an explicit **do not tighten** note on the candidate filter,
and `tests/unit/ai/action-routing.test.ts` asserts (a) `staff_composite` mounts a non-empty
set including both action tools for every role, and (b) that no tool in `AI_TOOL_REGISTRY`
actually declares `staff_composite` — which is *why* the gate must stay permissive. A
future strict gate now fails loudly instead of silently mounting zero tools.

---

## 3. True help vs. actionable "how do I…"

The override fires only on the **conjunction** of a write verb and a concrete operand.
Either signal alone is insufficient, and that is the entire design:

- **Verb alone** would drag "how do I issue an invoice?" and "كيف أصدر فاتورة؟" — textbook
  documentation questions — onto the expensive class and destroy the containment property
  `staff_help` exists to provide.
- **Operand alone** would catch "where do I find Ahmed Ali's file?", which is a read.

| Turn | Verb | Operand | Class |
|---|---|---|---|
| "How do I book an appointment?" | ✓ | ✗ | `staff_help` |
| "كيف أصدر فاتورة؟" | ✓ | ✗ | `staff_help` |
| "Where do I find Ahmed Ali's file?" | ✗ | ✓ | `staff_help` |
| "Where is the appointments page?" | ✗ | ✗ | `staff_help` |
| "How do I book Ahmed Ali with Dr. Sara on Sunday at 10:00?" | ✓ | ✓ | `staff_administrative` |
| "كيف أحجز موعدًا لأحمد مع د. سارة؟" | ✓ | ✓ (`د. سارة`) | `staff_administrative` |
| "How do I write a prescription for Ahmed Ali?" (doctor) | ✓ | ✓ | `staff_clinical_summary` |
| "How do I write a prescription?" (doctor) | ✓ | ✗ | `staff_help` |
| "How do I book him for that slot?" + live context | ✓ | ✓ (context) | `staff_administrative` |
| "How do I book him for that slot?" without context | ✓ | ✗ | `staff_help` |

### One deliberate deviation from the review

Review §7.1(2) lists "a live `activeContext` entity" as a concrete operand outright. As
implemented, a live slot counts **only when the turn actually refers to it** — a pronoun or
deictic (`him`, `her`, `that slot`, `له`, `نفس`, or an Arabic write verb carrying an
attached object pronoun such as `أحجزه`). Treating any live slot as an operand would mean
that once a patient is resolved, every later documentation question in that conversation
leaves the cheap class — which is precisely the containment loss the fix exists to avoid.
The reported transcript's turn 3 is covered either way, and both directions are asserted.

---

## 4. Capability reporting in help turns (review §7.3)

`lib/ai/tools/list-my-capabilities.ts`. The tool still returns the cross-class authorized
union — the right answer to "what can I ask you?" — but it no longer leaves the model free
to promise a write it cannot start in that same turn. The result now carries:

- `actions_startable_this_turn` — derived from `execute_action`'s own `taskClasses`
  declaration (the same one the mount reads), not from a hardcoded class name, so a future
  narrow class is covered without a second edit.
- `action_availability_note` — present only when actions exist but cannot be started here.
  It instructs the model to say the actions are real and authorized, **not** to claim they
  are unavailable to the user, **not** to substitute a page link, and to ask the user to
  restate the request with details so the next turn runs it as an action.

The tool description points at that field, and `lib/ai/prompts/help.ts` gains a matching
bullet in **both** EN and AR: the product-knowledge clause explicitly does not apply when
the user is asking for something to be *done* for a named person, date, or record.

---

## 5. Tests

### Added (the 13 from review §9)

`tests/unit/ai/action-routing.test.ts` — 66 assertions across 9 blocks:

1. **Table-driven override.** Every instructional booking phrasing from §4.1 and every
   other-write phrasing from §6, asserted `!== "staff_help"` **and** `=== "staff_administrative"`,
   for all three administrative roles. Imperative phrasings asserted unchanged.
2. **Help containment preserved.** Eight operand-free instructional questions, asserted
   `staff_help` for all five roles — including with a live entity context present.
3. **Both-signals-required.** Verb-without-operand and operand-without-verb both stay
   `staff_help`, asserted through the exported `hasWriteIntentVerb` / `hasConcreteOperand`
   so the failure is diagnosable. Plus: an aggregation question never becomes a write turn,
   and a capitalized product noun is not a person.
4. **Bilingual parity.** Five Arabic actionable writes and four Arabic help questions, plus
   an explicit assertion that an Arabic stem does not match inside a longer word (`معدل`
   must not fire on `عدل`).
5. **Role coverage.** All five roles reach an action-capable class; the doctor's
   instructional prescription request lands on `staff_clinical_summary`; its operand-free
   twin stays `staff_help`.
6. **Composite interaction.** A turn matching both `isHelpIntent` and `isCompositeIntent`
   resolves to `staff_composite`; composite phrasing alone does not steal a genuine help turn.
7. **Action tools reachable in every non-help class**, for every class in
   `STAFF_TASK_CLASSES_BY_ROLE[role]` and every `ACTION_CAPABLE_ROLES` member.
8. **Composite mount invariant** (§6.1), both halves.
9. **Containment unchanged** — the `staff_help` mount is exactly the four data-free tools
   plus `describe_action`, and `execute_action` plus ten named clinic-data tools are
   asserted absent for every role.

Plus a **multi-turn** block: four pronoun phrasings (EN + AR, including `كيف أحجزه؟`) leave
`staff_help` when the context is live, and the identical turn without context does not.

`tests/unit/api/action-routing-route.test.ts` — 5 tests, the reported scenario driven
through the **real** router inside the actual route (only the reservation, agent, and
database are stubbed):

10. The §4.2 transcript: turns 1–2 resolve patient and slot, turn 3 "How do I book him for
    that slot?" resolves to a class contained in `execute_action`'s declared task classes.
    Arabic equivalent asserted. Counterpart asserted: a genuine documentation question
    mid-conversation still routes to `staff_help`.
11. Class stability: imperative and instructional phrasings of the same booking resolve to
    the *same* action-capable class; a conversation that mounted data tools does not lose
    the write surface when the mood changes.

`lib/ai/eval/eval-set.ts` — six new cases (12):

12. `eval-staff-53/54` instructional booking EN/AR → `execute_action`;
    `eval-staff-55/56` instructional invoice issuing EN/AR → `execute_action`;
    `eval-staff-57/58` the operand-free containment counterparts → `search_help`.
    All six pass the offline achievability/containment oracle.

`tests/unit/ai/action-routing-authorization.test.ts` — 5 tests (13): `appointments.create`
driven down the newly reachable path returns **the same** `assertActionAccess` denials —
`plan_not_entitled` without `ai.write_scheduling`, `unauthorized_role` for a role the
action does not list, `unauthorized_scope` with the `appointments` page hidden — with the
receipt still finalized in every case, and an authorized caller still getting a
preview-only result that requires the on-screen confirmation.

### Updated

- `tests/unit/ai/p47a-help-tools.test.ts` — the `staff_help` containment list now includes
  `describe_action`, with the reasoning inline.
- `tests/unit/api/p4b-chat-route.test.ts` — the `invalid_patient_context` test asserts the
  new pre-reservation short-circuit; a new sibling test pins that a post-routing failure
  still reserves and reconciles.

### Results

| Check | Command | Result |
|---|---|---|
| Targeted routing/mount | `vitest run tests/unit/ai/action-routing.test.ts` | **66 passed** |
| Targeted route scenario | `vitest run tests/unit/api/action-routing-route.test.ts` | **5 passed** |
| Targeted authorization | `vitest run tests/unit/ai/action-routing-authorization.test.ts` | **5 passed** |
| Full unit suite | `npm test` | **371 files, 2999 passed, 0 failed** |
| Adversarial | `npm run test:ai-adversarial` | **136 passed** |
| Integration / RLS | `npm run test:integration` (local Supabase) | **55 files, 501 passed, 3 skipped, 1 failed — pre-existing local data, see §6** |
| Assistant E2E | `p4b-assistant.spec.ts --workers=1` | **3 passed** |
| Assistant E2E | `post-plan-conversation-history.spec.ts` + `phase5f-privileged-actions.spec.ts --workers=1` | **4 passed** |
| Build | `npm run build` | **passed** |
| Typecheck | `npm run typecheck` | **passed, no output** |
| Lint | `npm run lint` | **0 errors**, 28 pre-existing warnings, none in changed files |
| RTL gate | `npm run lint:rtl` | **passed** (682 files) |
| i18n gate | `npm run lint:i18n` | **passed** (441 files) |
| i18n parity | `npm run i18n:missing` | **passed** (4000 base leaf messages) |
| Whitespace | `git diff --check` | **clean** |

---

## 6. Remaining issues

1. **Pre-existing local integration failure, not a regression.**
   `tests/unit/integration/dev-clinic-pro-ai-entitlement.test.ts` fails because the local
   database holds **two** clinics named "Health Care Pro" — one seeded 2026-05-06
   (`caf2711f-…`) alongside today's canonical dev-clinic row (`93000000-…`). Verified
   directly against the local REST API. The test reads clinic seed data only; nothing in
   this change touches the database. Fix is local seed hygiene: delete the stale row.

2. **Pre-existing E2E cross-spec interference, not a regression.**
   Running `p4b-assistant.spec.ts` and `post-plan-conversation-history.spec.ts` in parallel
   makes logins fail in whichever spec loses the race — both specs seed their own auth
   users and clinics against the same local instance. Every affected test passes with
   `--workers=1`, and `p4b-assistant.spec.ts` passes in isolation. Worth fixing separately
   by making the specs' `beforeAll` seeds mutually non-colliding.
   (Note also that these specs seed into **local** Supabase while `.env.local` points the
   app at the remote project; the app must be started against local Supabase for them to
   pass at all. That is an environment note, not a defect.)

3. **The lexicon is a lexicon.** The write-verb and operand lists are deterministic and
   inspectable by design — the router must not itself require a model call — but they are
   finite. An unusual verb or an Arabic name written without an honorific, digit, day word,
   or patient marker will not trigger the override, and such a turn degrades to today's
   behavior: `staff_help`, where `describe_action` is now mounted and the prompt tells the
   model to name the action and ask the user to restate the request. It fails toward the
   old behavior, never toward a write.

4. **Known, accepted false-positive shape.** A documentation question that happens to carry
   both a write verb and a date — "show me how to record the revenue report for August" —
   will run on `staff_administrative` instead of `staff_help`. That costs money on a turn
   that answers correctly either way (the help tools are mounted in every class). It cannot
   widen what the caller may do.

---

## 7. Guarantees explicitly preserved

- **Authorization.** Routing selects a certified policy from a fixed set; it has never been
  an authorization input and still is not. Every action re-asserts role, plan features,
  per-user permission, and page visibility in `assertActionAccess` at both preview and
  execute. Pinned by test 13.
- **RLS / entitlements.** Untouched. The mount for an overridden turn is byte-identical to
  the mount an imperatively-phrased turn from the same user already received.
- **Confirmation, re-authorization, audit.** The write path is unchanged: `execute_action`
  still returns a preview only, the confirm token is still withheld from model context,
  privileged actions still require the password step-up, and receipts are still written for
  denials as well as successes.
- **`staff_help` containment.** The class still mounts no tool that reads clinic data. The
  one addition, `describe_action`, is permission-filtered registry metadata.
- **`staff_composite`.** The task-class gate was not tightened, and the invariant that would
  have broken it is now asserted.
- **Bilingual parity.** Every routing property above is asserted in Arabic as well as
  English, and both prompt clauses were updated together.
