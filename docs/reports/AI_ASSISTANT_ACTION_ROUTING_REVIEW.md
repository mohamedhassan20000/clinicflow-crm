# AI Assistant — Action Routing Regression Review

**Date:** 2026-08-16
**Branch:** `feat/p7-manual-qa-polish`
**Scope:** Staff assistant surface (`/api/agent/chat`), task-class router, tool mount, action registry
**Status:** Reproduced. Root cause identified. No production code modified.

---

## 1. Verdict

The regression is **real and reproducible**. It is **not** a prompt problem, not a tool-description
problem, not an action-schema problem, and not an action-discovery problem.

**Root cause: task classification/routing, coupled to tool mounting.**

The deterministic help-intent router (`isHelpIntent`) classifies any instructionally-phrased request
— "how do I…", "where do I…", "walk me through…", "كيف أ…" — as `staff_help`, **without checking
whether the request also expresses a concrete write intent with resolved operands**. The `staff_help`
task class is the one genuinely narrow mount in the system: it excludes `execute_action` and
`describe_action` entirely, along with every entity-resolution and data tool. The model is therefore
left holding only `search_help`, `get_navigation_target`, `list_my_capabilities`, and
`describe_capabilities`, and the product-knowledge prompt clause correctly instructs it to answer
such turns from `search_help` and to direct the user to a page via `get_navigation_target`.

The assistant is behaving exactly as instructed. It tells the user to open the appointment page
manually because, in that turn, **booking is not in its world** — the action tools were never mounted.

The authorization chain is *not* the cause and is correct throughout: `appointments.create` is
registered, reachable, and properly gated.

---

## 2. Severity

**High (functional), Low (security).**

| Dimension | Assessment |
|---|---|
| Correctness | High — an authorized, entitled, supported write silently degrades to a navigation hint. |
| Blast radius | High — affects **every** registered write action, not just booking (see §6). |
| Data safety | None — this fails *closed*. No unauthorized write, no data leak, no confirmation bypass. |
| User-visible impact | High — the assistant's headline capability appears absent, and it appears absent *inconsistently*, depending only on how the sentence was phrased. |
| Trust impact | High — `list_my_capabilities` is mounted in help turns and reports the **full cross-class authorized union**, so the assistant can truthfully claim "I can create appointments" and then, in the same turn, be unable to do it. |

Not a security defect. A capability and product-integrity defect.

---

## 3. Affected files and locations

| File | Location | Role in the defect |
|---|---|---|
| `lib/ai/platform/execution.ts` | `HELP_INTENT_RE` (~L150–163), `AGGREGATION_LEAD_RE` (~L170–179), `isHelpIntent` (~L181–188) | **Primary root cause.** Guard 2 overrides an instructional opener only for *aggregation/listing* phrasing. There is no guard for *write/action* phrasing. |
| `lib/ai/platform/execution.ts` | `staffTaskForRole` (~L233–277) | Help routing is evaluated **first**, before the composite check and before the persona split, so it wins over every other signal. |
| `lib/ai/tools/registry.ts` | `SHARED_TASKS` (~L180–184); `execute_action` (~L246–256); `describe_action` (~L257–267) | The action tools declare `SHARED_TASKS`, which omits `staff_help`. This is what converts a routing miss into a capability loss. |
| `lib/ai/tools/index.ts` | `resolveToolMount` candidate filter (~L82–91) | `staff_help` is the sole containment branch; all other classes mount the full authorized union. |
| `lib/ai/platform/registry.ts` | `staff_help` policy (~L161–172) | `maxSteps: 4`, `maxOutputTokens: 700`, and a cheaper model alias (`staff-haiku-bootstrap-v1`) — a booking turn is additionally downgraded and step-starved. |
| `app/api/agent/chat/route.ts` | L118–133 | The class is computed **per request from the current user message only**, so a mid-conversation phrasing change silently swaps the mount. |
| `app/api/agent/chat/route.ts` | L160 (`uiMessages = [...conversation.messages, currentMessage]`) | Full prior history stays in context. This is why the transcript *shows* a resolved patient and a confirmed slot while the tools that produced them are gone. |
| `lib/ai/prompts/help.ts` | `EN` / `AR` clauses (L22–36) | Not a cause, but the amplifier: it directs the model to answer from `search_help` and route via `get_navigation_target`. Correct for real help turns; it is what produces the "open the page manually" wording here. |

**Confirmed *not* at fault:**

- `lib/ai/actions/definitions/appointments.ts` — `appointments.create` (L70) is registered with a
  correct schema, preview, execute, `pageSlug: "appointments"`, and `requiredFeatures: ["ai.write_scheduling"]`.
- `lib/ai/actions/execute.ts` — `assertActionAccess` (L108–147) correctly re-asserts role, staff tool
  access, plan features, per-user permission, and page visibility.
- `lib/ai/tools/registry.ts` — `ACTION_CAPABLE_ROLES` (L137–139) is derived from `AI_ACTION_REGISTRY`,
  so every role with a registered action mounts the action tools in non-help classes.
- Tool descriptions on `execute_action` / `describe_action` are accurate and action-oriented.
- The preview → on-screen confirm → execute pipeline is intact.

---

## 4. Reproduction

### 4.1 Executable reproduction (performed)

A temporary vitest file was run against the real, unmodified router and the real tool registry, then
removed. Verbatim output:

```
staff_help mount: describe_capabilities, search_help, get_navigation_target, list_my_capabilities
staff_administrative mount: query_resource, get_record, aggregate_resource, describe_capabilities,
  execute_action, describe_action, describe_documents, preview_document, search_authorized_patients,
  check_availability, get_clinic_summary, ... (full authorized union)

===== BOOKING (role: receptionist) =====
task=staff_administrative  exec_action=yes  | Book an appointment for Ahmed Ali with Dr. Sara on Sunday at 10:00
task=staff_administrative  exec_action=yes  | Please book Ahmed Ali with Dr. Sara tomorrow at 10:00
task=staff_administrative  exec_action=yes  | Can you book Ahmed Ali an appointment with Dr. Sara on 2026-08-20 at 10:00?
task=staff_help            exec_action=NO   | How do I book an appointment for Ahmed Ali with Dr. Sara on Sunday at 10:00?
task=staff_help            exec_action=NO   | How can I schedule Ahmed Ali with Dr. Sara on Sunday at 10:00?
task=staff_help            exec_action=NO   | Where do I book Ahmed Ali with Dr. Sara for Sunday 10:00?
task=staff_help            exec_action=NO   | Show me how to book Ahmed Ali with Dr. Sara on Sunday at 10am
task=staff_composite       exec_action=yes  | Check availability for Dr. Sara on Sunday and then book Ahmed Ali at 10:00
task=staff_administrative  exec_action=yes  | احجز موعدًا لأحمد علي مع د. سارة يوم الأحد الساعة 10
task=staff_help            exec_action=NO   | كيف أحجز موعدًا لأحمد علي مع د. سارة يوم الأحد الساعة 10؟
```

The imperative forms work. The instructional forms — same operands, same user, same authorization —
lose the entire write surface. Both languages are affected.

### 4.2 End-to-end path matching the reported scenario

The reported symptom includes a *successfully resolved patient and a confirmed slot* followed by a
navigation answer. That combination cannot occur inside a single `staff_help` turn, because
`search_authorized_patients` and `check_availability` are not mounted there either. It is a
**multi-turn** transcript, which the code reproduces exactly:

1. **Turn 1** — "Find patient Ahmed Ali."
   → `isHelpIntent` false → `staff_administrative` → full mount → `search_authorized_patients` runs,
   patient resolved, and the resolution is persisted as active context
   (`ConversationContextRecorder`, `route.ts` L184+).
2. **Turn 2** — "Is Dr. Sara free Sunday at 10:00?"
   → `staff_administrative` → `check_availability` runs → slot confirmed.
3. **Turn 3** — "How do I book him for that slot?" *(or "Where do I book…", or "كيف أحجز…")*
   → `isHelpIntent` **true** → `staff_help` → mount collapses to four help tools; model additionally
   downgraded to the cheap alias with `maxSteps: 4`.
4. Prior tool results remain in context (`route.ts` L160), so the model can see the resolved patient
   and the confirmed slot — it simply has no tool to act on them.
5. Obeying `lib/ai/prompts/help.ts`, it calls `search_help` + `get_navigation_target` and replies
   with the Appointments page path.

This is precisely the reported behavior, and every step is forced by the code.

### 4.3 Single-turn reproduction

Turn 3's phrasing alone reproduces it, minus the resolved-patient detail: the assistant answers the
booking request with a navigation hint and never reaches `execute_action`.

---

## 5. Why the other candidate causes were excluded

| Candidate | Verdict |
|---|---|
| Task classification/routing | **CAUSE.** `isHelpIntent` has no write-intent guard. |
| Tool mounting | **CO-CAUSE.** `execute_action`/`describe_action` declare `SHARED_TASKS`, omitting `staff_help`. |
| Prompt instructions | Amplifier, not cause. `lib/ai/prompts/help.ts` correctly governs genuine help turns. The action-safety clause in `lib/ai/prompts/staff.ts` is correct. |
| Tool descriptions | Not a cause. Both action tools describe themselves accurately. |
| Action discovery | Not a cause. `describe_action` → `describeAuthorizedActions` correctly enumerates authorized actions — it is simply not mounted in a help turn. |
| Agent step budget | Contributing but not causal. `staff_help` gives 4 steps vs. 20 for administrative; even with the tools mounted, 4 steps would be tight for resolve → verify → describe → preview. `staff_administrative` (20) and `staff_composite` (25) are adequate. |
| Appointment action schema / context resolution | Not a cause. `appointments.create` and the shared availability/reference checks are intact. |

---

## 6. Are other write actions affected?

**Yes — every registered write action is affected, identically.** The defect is in the router and the
mount, both of which are action-agnostic. `execute_action` and `describe_action` are the single
carrier for all of `AI_ACTION_REGISTRY`, so when they are unmounted the *entire* write surface
disappears at once.

Measured, same harness:

```
===== OTHER WRITES (role: receptionist) =====
task=staff_help  exec_action=NO  | How do I issue an invoice for Ahmed Ali?
task=staff_help  exec_action=NO  | How do I record a follow-up outcome for Ahmed Ali?
task=staff_help  exec_action=NO  | How do I cancel Ahmed Ali's appointment tomorrow?
task=staff_help  exec_action=NO  | Where do I mark Ahmed Ali as arrived?
task=staff_help  exec_action=NO  | Walk me through issuing a sick leave for Ahmed Ali
task=staff_help  exec_action=NO  | How do I update Ahmed Ali's phone number?

===== DOCTOR =====
task=staff_help             | How do I write a prescription for Ahmed Ali?
task=staff_clinical_summary | Write a prescription for Ahmed Ali: amoxicillin 500mg
```

Affected domains: appointments, billing/invoices, follow-ups, patients, clinical authoring
(prescriptions, lab requests, sick leaves), documents, and settings. All five staff roles are
affected, including doctor and assistant. Both English and Arabic.

The document tools (`preview_document`, `describe_documents`) also declare `SHARED_TASKS` and are
lost in the same turns, so "how do I issue a sick leave for Ahmed" loses both the document preview
and the issuing action.

### 6.1 Adjacent latent risk (flagged, not the reported defect)

No tool in `AI_TOOL_REGISTRY` declares `staff_composite`. The composite class only mounts anything
because the candidate filter in `resolveToolMount` (`lib/ai/tools/index.ts` L88–90) reduces to
`activeTaskClasses.length > 0` for every non-help class — it never checks that the tool actually
declares the active class. This is deliberate today (see the comments at `staff-agent.ts` L55–57 and
`index.ts` L85–87), but it means **any future tightening of that gate would silently mount zero tools
for `staff_composite`.** Since a natural instinct while fixing this report is to "make the task-class
gate strict", this must be called out: either add `staff_composite` to `SHARED_TASKS`/`HELP_TASKS`,
or leave the gate deliberately permissive with the invariant asserted by a test.

---

## 7. Required fix

The fix must land in the **router**, and be backstopped in the **mount**. Prompt changes alone cannot
fix it — the tool genuinely does not exist in the turn.

### 7.1 Primary — add a write-intent guard to `isHelpIntent`

`lib/ai/platform/execution.ts`. Introduce a third guard, symmetric with the existing
`AGGREGATION_LEAD_RE` guard: an instructional opener must **not** route to `staff_help` when the turn
also carries an actionable write intent.

Two composable signals, both cheap and deterministic, consistent with the existing design (the router
must not itself require a model call):

1. **Write-verb lexicon** — `book`, `schedule`, `create`, `cancel`, `reschedule`, `issue`, `record`,
   `update`, `add`, `mark`, `send`, `write`, `assign`, `confirm`, plus Arabic equivalents
   (`احجز`, `أنشئ`, `ألغِ`, `عدّل`, `أصدر`, `سجّل`, `أضف`, `أرسل`, `اكتب`).
2. **Concrete-operand detection** — the turn carries a resolvable operand: a date/time, a proper
   name, a file number, or a live `activeContext` entity. This is what separates "how do I book an
   appointment?" (a genuine documentation question — must stay `staff_help`) from "how do I book
   Ahmed Ali with Dr. Sara on Sunday at 10:00?" (a booking request wearing a question mark).

Require **both** before overriding the help route. Guarding on the verb alone would pull real
documentation questions back into the expensive class and undo the containment property that
`staff_help` exists to provide. On override, route administrative roles to `staff_administrative` and
clinical roles to `staff_clinical_summary` (or `staff_composite` if `isCompositeIntent` also matches).

Ordering note: the override must be applied *inside or before* the `isHelpIntent` branch in
`staffTaskForRole` (L249), since that branch currently returns before any other signal is consulted.

### 7.2 Backstop — make the help class recoverable rather than a dead end

Pick one; (a) is the smaller change and is recommended.

- **(a) Mount `describe_action` in `staff_help`.** Add `"staff_help"` to its `taskClasses`. It is a
  read-only, permission-filtered metadata tool that reads no clinic data, so it does not weaken the
  containment property that `staff_help` was built for. A model that lands in a help turn holding a
  real write intent can then at least name the action truthfully and invite the user to restate it,
  instead of silently degrading to a page link.
- **(b) Re-route on discovery.** Have the help tools signal "this looks like a supported action, not
  a documentation question" and let the route re-run the turn on the administrative class. More
  faithful, materially more complex, and it costs a second model call.

### 7.3 Consistency — stop advertising unreachable capability

`list_my_capabilities` is mounted in `staff_help` and reports the **cross-class authorized union**,
including every write action. In a help turn it therefore promises capability the turn cannot
deliver. It should either mark entries not mounted in the active class, or the copy should make the
cross-class framing explicit ("you can ask me to do this — say it directly").

### 7.4 Budget

If §7.1 lands, no budget change is needed: overridden turns leave `staff_help` and inherit
`staff_administrative`'s 20 steps. If only §7.2(a) lands, `staff_help`'s `maxSteps: 4` and
`maxOutputTokens: 700` are too tight for even a truthful redirect and should be revisited.

---

## 8. Acceptance criteria

1. For every staff role, a booking request carrying an identified patient, doctor, date, and time
   routes to a task class that mounts `execute_action` — **regardless of whether it is phrased
   imperatively ("book…") or instructionally ("how do I book…", "where do I book…", "كيف أحجز…")**.
2. The same holds for every other registered write intent: invoices, follow-ups, patient updates,
   appointment status changes, clinical authoring, and document issuing.
3. Genuine documentation questions with **no concrete operand** — "how do I book an appointment?",
   "where is the invoices page?", "كيف أصدر فاتورة؟" — still route to `staff_help`, and the help
   containment property (no clinic-data tool mounted) is unchanged.
4. In the multi-turn transcript of §4.2, turn 3 prepares an `appointments.create` preview and renders
   the confirmation card. It does not answer with a navigation link.
5. The write path is unchanged: `execute_action` still returns a preview only, the confirm token is
   still withheld from model context, and execution still requires the on-screen confirmation.
6. No authorization behavior changes. An unauthorized or unentitled caller still gets the same denial
   reason from `assertActionAccess`, and routing never widens what a caller may do.
7. Arabic and English behave identically at every point above.
8. `staff_help` remains genuinely cheaper: an override raises cost only for turns that carry a real
   write intent with concrete operands.

---

## 9. Tests that should be added

### 9.1 Router — `tests/unit/ai/` (extend the `staff_help` routing block in `p47a-help-tools.test.ts`, or add a dedicated `action-routing` suite)

1. **Table-driven write-intent override.** For each of the ten booking phrasings in §4.1 and the six
   in §6, assert `staffTaskForRole(...).task !== "staff_help"`. This is the direct regression lock
   and would have caught this defect.
2. **Help containment preserved.** Operand-free instructional questions ("how do I book an
   appointment?", "where is the appointments page?", "كيف أصدر فاتورة؟") still return `staff_help`.
   This guards the fix against over-correcting.
3. **Both-signals-required.** A write verb without an operand stays `staff_help`; an operand without
   a write verb stays `staff_help`. Prevents the guard from degenerating into a bare verb match.
4. **Bilingual parity.** Every case above asserted in Arabic as well as English.
5. **Role coverage.** admin, manager, receptionist, doctor, assistant — confirm the doctor case
   ("how do I write a prescription for Ahmed Ali?") lands on `staff_clinical_summary`.
6. **Composite interaction.** A phrasing matching both `isHelpIntent` and `isCompositeIntent` resolves
   to `staff_composite`, not `staff_help`.

### 9.2 Mount

7. **Action tools reachable in every non-help class.** For each class in
   `STAFF_TASK_CLASSES_BY_ROLE[role]` other than `staff_help`, assert `resolveToolMount` yields
   `execute_action` and `describe_action` for every role in `ACTION_CAPABLE_ROLES`.
8. **Composite invariant (§6.1).** Assert `resolveToolMount({ taskClass: "staff_composite" })` returns
   a non-empty mount including `execute_action`. This pins the latent landmine so that tightening the
   task-class gate fails loudly instead of silently.
9. **Containment unchanged.** The existing assertion that a `staff_help` mount contains no
   clinic-data tool must continue to pass, updated only for whatever §7.2(a) adds.

### 9.3 Route / integration — `tests/unit/api/p4b-chat-route.test.ts`

10. **Multi-turn scenario.** Drive the §4.2 transcript against the route with a stubbed model and
    assert the third turn's resolved task class mounts `execute_action`. This is the test that
    encodes the reported bug as a scenario rather than as a regex property.
11. **Class stability across a conversation.** Assert that a conversation whose earlier turns mounted
    data tools does not lose the write surface purely because the latest message changed phrasing.

### 9.4 Eval set — `lib/ai/eval/eval-set.ts`

12. Add instructionally-phrased booking and invoice-issuing cases whose expected outcome is an
    `execute_action` preview, so the behavior is covered end-to-end at the model level and not only
    at the regex level.

### 9.5 Authorization non-regression — `lib/ai/eval/authorized-tools.ts`

13. Confirm the routing change grants nothing: a caller lacking `ai.write_scheduling`, lacking the
    role, or with the `appointments` page hidden still receives the same `assertActionAccess` denial
    on the newly-reachable path.

---

## 10. Summary

An authorized user's booking request loses the entire write surface when phrased as a question. The
deterministic help router (`isHelpIntent`, `lib/ai/platform/execution.ts`) treats "how do I…" /
"where do I…" / "كيف أ…" as documentation intent with no guard for a concurrent write intent, and
`staff_help` is the one task class narrow enough to unmount `execute_action` and `describe_action`
(`lib/ai/tools/registry.ts`, `SHARED_TASKS`). The assistant then does exactly what
`lib/ai/prompts/help.ts` tells it to: look up the help corpus and hand back a page link.

It fails closed — nothing is exposed and nothing is written without confirmation — but it removes the
assistant's entire registered write capability across all domains, all five staff roles, and both
languages, on nothing more than a change in sentence mood. The fix belongs in the router (a
write-intent guard requiring both a write verb and a concrete operand), backstopped by mounting
`describe_action` in `staff_help` so the class is recoverable rather than a dead end.

**No production code was modified in the course of this review.** The temporary reproduction test was
removed after the measurements in §4.1 and §6 were captured.
