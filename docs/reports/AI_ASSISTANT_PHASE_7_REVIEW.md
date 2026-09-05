# AI Assistant — Phase 7 Review

**Phase:** 7 — Adversarial hardening, migration completion, eval (`docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §15)
**Implementation report reviewed:** `docs/reports/AI_ASSISTANT_PHASE_7_IMPLEMENTATION.md`
**Scope:** Phase 7 only. Phases 0–6 were treated as reviewed baseline and checked only for weakening.

**Verdict:** **NOT PASS — 2 Medium, 4 Low. No High, no security finding.**

The phase's core claims hold up under direct inspection. The four unmounted tools are genuinely
covered by the resource layer for the roles they served; the coverage suite is derived from the
live registries and would fail on a real narrowing; `list_pending_followups` is correctly
retained; the confirm-token forgery block drives the real verifier and cannot consume a
legitimate token; the §17 eval additions match §19 decision 1, including the two corrected
receptionist rubrics. No capability was silently lost and no Phase 0–6 behaviour was weakened —
every deleted test block names a replacement assertion, and I confirmed each named replacement
exists and passes.

What blocks a PASS is two gaps between what the phase claims and what it shipped: the capability
panel does not actually render the actions the phase added to it (P7-01), and the appointment
date-range semantics the superseded tools resolved server-side in the clinic's timezone have no
successor on the generic path (P7-02). Neither is a security defect; both are user-facing.

No production code was modified by this review.

---

## 1. Verification performed

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | **clean** |
| Full unit suite | `npm run test` | **359 files, 2767 tests passed** |
| AI unit subtree | `npx vitest run tests/unit/ai` | **63 files, 953 tests passed** |
| Adversarial / eval | `npm run test:ai-adversarial` | **2 files, 136 tests passed** |
| Full integration + RLS (local Supabase) | `npm run test:integration` | **54 files passed, 1 skipped; 466 passed, 3 skipped** |
| Production build | `npm run build` | **compiled successfully** |
| Lint | `npm run lint` | **0 errors, 28 warnings** |
| i18n / RTL gates | `npm run lint:i18n`, `npm run lint:rtl` | ✓ 439 files / ✓ 679 files |

Every number in the report's §7 reproduces exactly.

**One flake, not a Phase 7 defect.** A first `test:integration` run reported one failure in a
subscription assertion unrelated to Phase 7, immediately after an earlier aborted run had left
seed rows on the local stack. Re-run clean under the suite's own `--no-file-parallelism` it
passes at 54/466. Recorded so it is not mistaken for a regression.

Local keys were exported from `.env.local` (`LOCAL_SUPABASE_URL`, `LOCAL_SUPABASE_SECRET_KEY`,
`LOCAL_SUPABASE_PUBLISHABLE_KEY`); the stack was already running. Nothing was pushed, deployed,
or applied to any remote.

---

## 2. What I verified as correct (not taken from the report)

Recorded because the findings below are narrow and should not obscure what actually holds.

- **Unmount ordering and superset coverage.** I read all four deleted modules from `git show
  HEAD:` and compared them column by column against the manifest in
  [lib/ai/tools/superseded.ts](lib/ai/tools/superseded.ts). Every returned column of every
  removed tool is a declared, role-readable field on the claimed resource; every input is a
  registered filter; the relations carrying `patient_name` / `patient_file_number` /
  `doctor_name` / `department_name` all exist. `get_patient_summary` returned an *age/gender*
  redaction where `patients` now returns `date_of_birth` and `blood_type` outright — a strict
  superset, consistent with §7.2.
- **The `medical_notes` role narrowing is real, not a waiver.**
  `MEDICAL_NOTE_READ_ROLES = [admin, receptionist, doctor]`
  ([lib/patients/read-permissions.ts:16](lib/patients/read-permissions.ts#L16)) is asserted equal
  to `rolesCovered` by [phase7-superset-coverage.test.ts:179](tests/unit/ai/phase7-superset-coverage.test.ts#L179),
  so "manager and assistant got an empty notes array anyway" is a checked claim.
- **The coverage suite is live-registry-derived.** It resolves `RESOURCE_REGISTRY_BY_ID`, runs
  each definition's real `fieldPolicy`, checks `existsSync` on the deleted module paths, and
  asserts the registry equals *generic ∪ retained* exactly with the superseded set disjoint. A
  future tool cannot be added without classifying it. Final surface is 22 tools, 8 generic —
  I counted the registry entries independently.
- **`list_pending_followups` retention is justified.** `get_followups_dashboard` derives
  appointments with *no* follow-up row. No filter over the `follow_ups` resource expresses an
  anti-join. Unmounting it would have removed a capability. The other retained tools are
  database-side computations, and `get_patient_stats` carries the §7.4 k-anonymity path.
- **The `note` filter does not broaden authorization.** It is `ilike` on a column the same
  caller may already read in full, inside the same RLS-scoped query and the same
  `tenantScope` inner join. `*` is rejected at compile time and `\ % _` are escaped by the
  compiler ([compile.ts:81,414-422](lib/ai/resources/compile.ts#L414)), which is stronger than
  the removed tool's hand-rolled escape.
- **Context proposals preserve the P4.10 trust boundary exactly.**
  [context-proposal.ts:109](lib/ai/resources/context-proposal.ts#L109) refuses to propose when
  an `id` filter is present, so `get_record` never seeds context; a truncated page or
  `total !== 1` proposes nothing; the id must be one the server read back and match a UUID.
  `ResolvedFilter.context` is populated only when `trustedForContext` is true
  ([filters.ts:45](lib/ai/resources/filters.ts#L45)), and reaches the recorder out-of-band via
  `onResolvedContext` so the resolved entity never appears in model-visible output.
- **Continuation is not broken.** `contextChoicesForToolResult`
  ([assistant-chat.tsx:124](components/assistant/assistant-chat.tsx#L124)) is tool-name-agnostic
  for the `needs_clarification` branch, and the `{id, name}` candidate shape emitted by
  `resolveCompiledFilters` matches what it expects, so the P4.10B click-to-choose path works
  unchanged on `query_resource`.
- **Confirm-token forgery coverage exercises the real verifier.**
  `verifyAndClaimActionConfirmation` ([confirm.ts:220-236](lib/ai/actions/confirm.ts#L220))
  checks the HMAC and all four bindings *in process, before* the store claim, so the in-memory
  store in the test cannot be what refuses the attack. The negative control passes a genuine
  token, and every non-replay case re-reads the store afterwards to prove the legitimate
  confirmation was not burned. Replay is the one binding whose refusal comes from the store
  rather than the verifier; the real single-use constraint is asserted separately in the
  phase3 suites.
- **§17 / §19 decision 1.** `eval-staff-31` and `eval-staff-32` now expect a receptionist to
  read notes via `query_resource` while keeping the no-diagnosis information boundary. That
  matches `medical_notes_select_role_scoped` and §19 decision 1; the previous expectation was
  the AI-only carve-out the plan removed. The 18 acceptance rows all grade consistent against
  the real authorization oracle, and A7/A7b/A14/A15 are correctly excluded with their owning
  suites named.
- **No migration was needed.** Phase 7 introduces no table, column, RPC, or enum. Leaving
  `types/database.ts` untouched is correct and avoids importing the known ~1184-line regen
  drift.
- **Dead code from the retired tools is mostly gone.** The four modules, the four i18n keys in
  both locales (verified programmatically — all 19 remaining `labelKey`s resolve in `en` and
  `ar`, and the four removed ones resolve in neither), the `tool-presentation` entries,
  `CLINICAL_TASKS`, and the `redactPatientIdentity` / `ageFromDateOfBirth` /
  `RedactedPatientIdentity` exports. One exception, P7-05.
- **Unrelated dirty work is intact.** The document platform, `lib/documents/**`, `actions/**`,
  `app/**`, and `supabase/migrations/**` all build, typecheck, and pass their suites; the
  document/component suites are green within the full run. (I cannot byte-diff against "how
  Phase 6 left it" — the whole tree is uncommitted with no phase boundary in git — so that
  specific claim is unverifiable by diff, only by the green suites.)

---

## 3. Findings

### P7-01 — Medium — The capability panel does not render the actions Phase 7 added to it

**Where**
- [lib/ai/capabilities.ts:97-114](lib/ai/capabilities.ts#L97) — the doc comment states "the
  panel now enumerates actions with their risk class".
- [components/assistant/capability-panel.tsx:57-79](components/assistant/capability-panel.tsx#L57)
  — the component's only content prop is `items`; it has no `actions` prop and no code path
  that renders one.
- [components/assistant/assistant-chat.tsx:1184-1191](components/assistant/assistant-chat.tsx#L1184)
  — the call site passes `items` only. `capabilities.actions` is never read by any component.
- [tests/unit/ai/phase7-capability-surface.test.ts:94](tests/unit/ai/phase7-capability-surface.test.ts#L94)
  — the describe block is named "the capability panel reports reads and writes alike" but every
  assertion is against `resolveAssistantCapabilities`, never against the panel component.
- Implementation report §4.5 and the §1 acceptance row ("capability panel reflects the new
  surface").

**Why it matters**
The §15 P7 acceptance line is about the panel — the surface a *user* looks at to decide what
they are authorising the assistant to do. The phase added a correctly-resolved `actions` array
(derived from `describeAuthorizedActions`, which is the right source) and wired it into the
model-facing `list_my_capabilities`, but not into the panel. The user-visible panel therefore
still says nothing about the appointments the assistant can create, the documents it can issue,
or the roles it can change — which is precisely the under-reporting the code comment identifies
as "the more dangerous direction of drift". The comment, the test's describe name, and the
report all assert a behaviour that is not shipped, so the gap is invisible to review and to the
suite.

Secondary cost: `resolveAssistantCapabilities` runs on every assistant page load and now
executes `describeAuthorizedActions` — a sequential `assertActionAccess` over the whole action
registry — purely to populate a field the panel discards. The underlying reads are
request-cached, so this is cheap rather than harmful, but it is work with no consumer on that
path.

**Required fix** — either of:
1. Thread `actions` (and, consistently, `resources`) into `CapabilityPanel` and render them —
   an actions section carrying each action's label, description, and risk class, with the
   privileged class visually distinct, matching the risk vocabulary the confirmation card
   already uses; **or**
2. Do not claim it: gate `actions` resolution on the consumer that actually needs it, correct
   the comment at `capabilities.ts:104-107`, rename the test's describe block to say
   "capability resolution", and correct report §4.5.

Option 1 is the one that satisfies the plan's acceptance line.

**Acceptance criteria**
- If (1): a component test renders `CapabilityPanel` for an admin with a non-empty `actions`
  array and asserts each action's description and risk class is visible, and that a
  `privileged` action is distinguishable from a `normal` one; a doctor/assistant render asserts
  no actions section appears. The existing Axe checks in `tests/e2e/p4b-assistant.spec.ts` must
  still pass on the expanded panel in both locales.
- If (2): no comment, test name, or report line claims the panel enumerates actions, and
  `describeAuthorizedActions` is not invoked on a path whose result is discarded.

---

### P7-02 — Medium — Superseded appointment date ranges have no timezone-anchored successor

**Where**
- Removed: `list_appointments` used `dateRangeInputSchema` → `resolveToolDateRange`
  ([lib/ai/tools/range.ts:15](lib/ai/tools/range.ts#L15)), whose own doc says the model "can
  never supply raw timestamps or a timezone". `list_doctor_appointments` and
  `search_patient_visits` used `clinicDateRangeToUtc(from, to, timeZone)` with
  `resolveClinicTimeZone` ([lib/ai/tools/context.ts:112-116](lib/ai/tools/context.ts#L112)).
- Replacement: `appointments.scheduled_at` and `medical_notes.created_at` are
  `timestampSchema = z.string().datetime({ offset: true })`
  ([lib/ai/resources/filters.ts:21](lib/ai/resources/filters.ts#L21)) — absolute instants only.
- Neither `buildStaffSystemPrompt` ([lib/ai/prompts/staff.ts](lib/ai/prompts/staff.ts)),
  `buildDoctorSystemPrompt`, `createStaffAgent`
  ([lib/ai/staff-agent.ts:69-77](lib/ai/staff-agent.ts#L69)), nor `describe_capabilities`
  ([lib/ai/tools/describe-capabilities.ts](lib/ai/tools/describe-capabilities.ts)) supplies the
  clinic timezone or the current date. `buildAssistantPageContextPrompt` supplies a
  `from`/`to` date pair only when the chat was launched from the appointments, revenue, or
  reports page ([lib/ai/page-context.ts:153-165](lib/ai/page-context.ts#L153)).
- [components/assistant/assistant-chat.tsx:904](components/assistant/assistant-chat.tsx#L904) —
  Phase 7 re-keyed the general `suggestTodaysAppointments` chip onto `query_resource`.
- [lib/ai/tools/superseded.ts:153,173](lib/ai/tools/superseded.ts#L153) records
  `filters: ["scheduled_at", ...]` as parity, and
  [phase7-superset-coverage.test.ts:131](tests/unit/ai/phase7-superset-coverage.test.ts#L131)
  checks only that the key exists with a non-empty column and operator list.

**Why it matters**
The manifest's parity claim is key-level, not semantic. The removed tools accepted clinic-local
dates (a named preset, or `YYYY-MM-DD`) and resolved them to UTC bounds **server-side, in the
clinic's own timezone**. The resource filter accepts only offset-bearing instants, and the model
has neither the clinic timezone nor today's date anywhere in its context. So "show me today's
appointments" — a chip this phase deliberately re-pointed at `query_resource`, offered on every
page — now depends on the model inventing both an anchor date and a UTC offset. For a clinic
outside UTC this silently returns the wrong day's schedule at the edges, and the answer looks
authoritative because the resource layer returns an exact total and a truthful `truncated` flag
for the window it was actually given.

The `MAX_RANGE_DAYS` (400) clamp and its honest `clamped` notice also do not apply on the
generic path. Row exposure is still bounded by `rowCap: 200` and the `ai.bulk_export` gate on
page > 1, so this is an accuracy problem, not an extraction problem.

This is genuinely a Phase 7 consequence: before the unmount, timezone-correct appointment lists
were reachable; afterwards the only appointment-list path is the one without the anchor.

**Required fix** — one of:
1. Give the read path the same server-owned resolution the removed tools had: accept a clinic-
   local date or preset on the date/timestamp filters (resolved through the existing
   `resolveClinicTimeZone` + `clinicDateRangeToUtc` / `resolveDateRange` core, so an assistant
   answer and the report page still reconcile), keeping the absolute-instant form as well; **or**
2. Put the anchor in the model's context: the clinic's IANA timezone and the current
   clinic-local date, injected by `createStaffAgent` and echoed by `describe_capabilities`, plus
   an explicit instruction to convert before filtering.

(1) is preferable — it keeps the timezone server-owned, which is the property the removed tools
had and the reason `range.ts` says the model may never supply a timezone.

**Acceptance criteria**
- A unit test drives `query_resource` over `appointments` for "today" in a clinic whose
  timezone is not UTC and asserts the emitted `gte`/`lte` bounds are byte-identical to
  `clinicDateRangeToUtc` / `resolveDateRange` for the same clinic-local day — the same
  fidelity check `phase2-clinical-parity-rls` applies to fields.
- `lib/ai/tools/superseded.ts` records the date-semantics parity explicitly (not just the filter
  key), and `phase7-superset-coverage.test.ts` asserts it, so a future edit that removes the
  clinic-local form fails naming the capability.
- If the range clamp is intentionally not carried across, that is stated in the manifest as a
  recorded deviation rather than left implicit.

---

### P7-03 — Low — Superset coverage asserts relation *names* but never relation *fields*

**Where**
- [lib/ai/tools/superseded.ts:32](lib/ai/tools/superseded.ts#L32) — `relations?: readonly string[]`.
- [tests/unit/ai/phase7-superset-coverage.test.ts:144-152](tests/unit/ai/phase7-superset-coverage.test.ts#L144)
  — asserts only `Object.keys(definition.relations)` contains each name.

**Why it matters**
`list_appointments` returned `patient_file_number`, `doctor_name`, and `department_name`; those
now live in the `patient`, `doctor`, and `department` relation field maps and `defaultFields` of
the appointments resource. Deleting `file_number` from the `patient` relation, or dropping it
from that relation's `defaultFields`, removes a column the superseded tool returned and the
suite stays green — which is exactly the regression class the manifest exists to catch. The
suite's stated fourth claim ("each replacement's fields/filters/relations/roles") is weaker for
relations than for fields.

**Required fix**
Make `relations` carry the fields the removed tool actually projected (e.g.
`{ patient: ["full_name", "file_number"] }`) and assert each named relation field is present in
`relation.fields`, readable under `relation.fieldPolicy` for every covered role, and — where
the removed tool returned it without being asked — present in `relation.defaultFields`.

**Acceptance criteria**
Removing `file_number` from the appointments `patient` relation (or from its `defaultFields`)
fails `phase7-superset-coverage.test.ts` with a message naming `list_appointments` and that
field.

---

### P7-04 — Low — Two of the four new stored-injection cases assert nothing beyond payload sanitization

**Where**
- [lib/ai/eval/injection-corpus.ts:544-570](lib/ai/eval/injection-corpus.ts#L544) —
  `inj-stored-service-name-01` (`services.name`) and `inj-stored-package-note-01`
  (`patient_packages.notes`) carry no `forbiddenTool`, no `targetAction`, and no `detectFlag`.
- [tests/unit/ai/p6a-injection-suite.test.ts:323-337](tests/unit/ai/p6a-injection-suite.test.ts#L323)
  — the sanitization test is parametrized over `STORED_INJECTION_PAYLOADS`, independent of the
  corpus cases.
- [tests/unit/ai/p6a-injection-suite.test.ts:361-370](tests/unit/ai/p6a-injection-suite.test.ts#L361)
  — the behavioural agent-loop test filters on `category === "stored_data_injection" &&
  storedField?.includes(".") && forbiddenTool`, so both cases are excluded.

**Why it matters**
Because the payloads themselves are already in `STORED_INJECTION_PAYLOADS` and already
sanitization-tested there, these two corpus entries contribute exactly one assertion each: the
`storedFields` set-membership check at
[p6a-injection-suite.test.ts:117-128](tests/unit/ai/p6a-injection-suite.test.ts#L117). Nothing
asserts that a payload planted in a service name or a package note fails to move a mounted tool.
`documents.title` (agent loop) and `sick_leaves.reason` (stored-payload forgery test) are
genuinely exercised; these two are declarative. The §13 obligation is that each newly-exposed
free-text field carries its own case rather than being assumed covered — half of the new fields
meet that only nominally.

**Required fix**
Give both cases a `forbiddenTool` reachable for their persona (as the `medical_notes.note` /
`prescriptions.notes` / `lab_requests.clinical_context` cases do with `get_record`) so the
behavioural loop at line 361 picks them up.

**Acceptance criteria**
All four Phase 7 stored fields appear in the behavioural stored-injection `it.each` (or, for
`sick_leaves.reason`, its equivalent forgery test), and stubbing `sanitizeUntrustedDeep` to a
pass-through makes each of them fail.

---

### P7-05 — Low — `assertClinicalToolAccess` is dead production code after the cutover

**Where**
- [lib/ai/authorization.ts:108](lib/ai/authorization.ts#L108).
- Its only remaining references are `tests/unit/ai/p4a-authorization.test.ts:99` and
  `tests/unit/ai/phase2-clinical-parity.test.ts:210`. No file under `lib/`, `app/`, or
  `components/` calls it; the resource layer gates on `assertResourceAccess` plus each
  definition's `requiredFeatures`.

**Why it matters**
Its last production callers were the clinical tools this phase deleted. Report §3.4 states
that dead code from the retired tools was removed and gives a principled reason for removing
the redaction helpers — "leaving them would have suggested a minimization that no longer runs".
The same reasoning applies here: a live-looking authorization assert with no caller suggests a
gate that is not in the path, and it has two suites pinning it, so it reads as load-bearing.
(Contrast `detectInjectionAttempt`, whose retention §8.4 flags explicitly and defensibly.)

**Required fix**
Either remove `assertClinicalToolAccess` and re-point its two tests at
`assertResourceAccess` / the clinical `requiredFeatures` path that now enforces the same rule,
or annotate it as deliberately retained with the reason and the decision owner, as
`detectInjectionAttempt` is.

**Acceptance criteria**
Every exported assert in `lib/ai/authorization.ts` either has a production caller or carries a
stated reason for retention; `ai.read_clinical` enforcement remains asserted by
`phase2-clinical-parity` against whatever path is authoritative.

---

### P7-06 — Low — Test fixtures still name tools and exports that no longer exist

**Where**
- `tests/unit/ai/p48a-launchers.test.ts:60` and
  `tests/unit/api/p48a-launcher-session-route.test.ts:63,180` — `toolNames: ["list_appointments"]`.
- `tests/unit/components/p46b-assistant-analytics-ui.test.tsx:415` — a capability item named
  `get_patient_summary`.
- `tests/unit/components/p410b-active-context-ui.test.tsx:185` — `contextChoicesForToolResult`
  called with `"list_appointments"`.
- `tests/unit/api/p4b-chat-route.test.ts:527,572` — `type: "tool-get_patient_summary"` parts.
- `tests/unit/ai/p6a-eval-set.test.ts:176,186` — a synthetic grader case with
  `forbidTools: ["get_patient_summary"]`.
- `tests/unit/ai/p410b-context-tools.test.ts:42,59,91` — mocks `assertDoctorToolAccess`, which
  is not exported by `lib/ai/authorization.ts` at all any more.

**Why it matters**
None of these asserts a real capability, and none is load-bearing — which is why the suite is
green. But `p46b-assistant-analytics-ui.test.tsx:415` now exercises `presentationFor`'s
*fallback* branch rather than a real presentation mapping, so it no longer tests what its name
implies; and a `vi.fn()` mock for a non-existent export
(`p410b-context-tools.test.ts`) silently does nothing, which is the shape of a test that has
stopped testing. Report §6 states every test edit either re-points an assertion or removes a
block whose subject was deleted; these fixtures did neither.

**Required fix**
Re-point each fixture at a tool that exists (`query_resource` / `get_record`) and drop the
`assertDoctorToolAccess` mock. Where a fixture's whole point was the presentation mapping, use
a name that is actually in `ASSISTANT_TOOL_PRESENTATION`.

**Acceptance criteria**
A grep for the four removed tool names across `tests/` returns only the Phase 7 suites and the
comments that explain the removal — no fixture data, no mock, no rubric.

---

## 4. Observations (no fix required, recorded for the decision owner)

- **Note text reaching the provider widened.** The superseded tools applied
  `redactText(note).slice(0, 500)` — emails and 7+ digit runs stripped, hard 500-char excerpt.
  The generic path relies on the central boundary in
  [untrusted-text.ts:58](lib/ai/untrusted-text.ts#L58), which caps `note` at the free-text limit
  of 2,000 characters (with honest `text_truncated_fields` reporting) and applies no redaction.
  This is the correct reading of §7.2 — the field policy, not a redactor, is where a narrowing
  belongs — and §13 accepts wider field exposure over ZDR-certified routes. Flagged only so the
  change of degree is a recorded decision rather than a side effect of deleting a helper.
- **`note` filter length.** `shortTextSchema` caps at 160 characters where
  `search_patient_visits` accepted a 200-character query. A 40-character narrowing on a
  substring search; not worth changing.
- **`detectInjectionAttempt` still has no production consumer.** Correctly disclosed in report
  §8.4 and correctly not deleted. It remains a product decision — wire it into the chat route as
  a telemetry signal, or retire it deliberately.
- **Feature-key shifts** (appointments/patients/follow-ups moving to `ai.read_operational`) are
  recorded per-record in the manifest and are behaviour-preserving while all AI keys sit on one
  plan row. Correct handling.
- **The `taskClasses` narrowing is decorative outside `staff_help`.**
  [tools/index.ts:88-90](lib/ai/tools/index.ts#L88) gates on `activeTaskClasses.length > 0` for
  every non-help class, so `SHARED_TASKS` vs `OPERATIONAL_TASKS` does not change a mount. This
  pre-dates Phase 7 and means removing `CLINICAL_TASKS` could not have cost a capability — the
  right outcome, reached for a reason the registry comment overstates.

---

## 5. E2E assessment

**Skipping Playwright leaves no meaningful Phase 7 verification gap, and I did not run it.**

The phase changed exactly two user-facing things, and both are covered without a browser:

1. **Suggestion chips re-keyed onto `query_resource`.** These are pure client-side conditionals
   over `capabilities.toolNames` and are asserted at the component level in
   `tests/unit/components/p46b-assistant-analytics-ui.test.tsx:121,139,156` with
   `query_resource` in the mount, including the truncation-notice path. An E2E would exercise
   the same branch through a slower harness.
2. **The capability panel.** Its rendered content did not change — Phase 7 added `actions` to
   the resolver but never to the component (P7-01). The existing spec
   `tests/e2e/p4b-assistant.spec.ts:77-93,206` covers the toggle, `aria-expanded`,
   focus return, and Axe in both locales, and is unmodified because there was nothing new to
   cover. Once P7-01 is fixed the panel gains rendered content and that spec should be extended
   — at that point an E2E run becomes worthwhile.

The continuation path (P4.10 proposals and clarification choices) is the one behaviour where an
E2E would have been tempting, and it is better covered by
`tests/unit/ai/phase7-context-parity.test.ts` (8 cases including the negative trust-boundary
ones) plus the live-RLS integration suites than a browser test could manage, since the
proposals are server-side and never rendered.

The one gap E2E would *not* have closed either is P7-02: it needs a non-UTC clinic and a
deterministic bound comparison, which is a unit-level fidelity check, not a browser one.

---

## 6. Summary

| ID | Severity | Summary |
|---|---|---|
| P7-01 | Medium | Capability panel does not render the `actions` the phase added; code comment, test name, and report claim it does |
| P7-02 | Medium | Clinic-timezone date-range resolution lost in the supersession; `query_resource` has no date anchor and the "today's appointments" chip now depends on it |
| P7-03 | Low | Superset coverage asserts relation names but not relation fields, so a dropped `patient.file_number` would pass |
| P7-04 | Low | `services.name` and `patient_packages.notes` injection cases carry no `forbiddenTool` and add no assertion beyond payload sanitization |
| P7-05 | Low | `assertClinicalToolAccess` has no production caller after the cutover |
| P7-06 | Low | Test fixtures and one `vi.fn()` mock still name removed tools and a removed export |

No High. No security finding. No capability silently lost. No Phase 0–6 behaviour weakened.
Both Mediums are self-contained and neither touches the phase's architecture.
