# AI Assistant — Phase 2 Review (Clinical parity & prompt correction)

**Re-review after review fixes — 2026-08-13.**

**Verdict: Phase 2 — CHANGES REQUIRED.** 1 Low. H-1, M-1, M-2, M-3, L-1, L-2, L-3 and L-4 are **all genuinely resolved in code, migration behavior, authorization matrices, storage/attachment access, resource definitions, tests, and adversarial coverage.** One new, concrete defect remains: the `query_resource` tool description still advertises `patient_documents` to the model, so the removal that resolved H-1 is not complete on the model-facing surface.

The substantive safety story is now correct. The Phase 2 migration no longer broadens anything: it contains exactly one policy, and that policy is a **narrowing**. `patient_documents` is gone from the Assistant registry entirely. `medical_notes` is pinned to the pre-Phase-2 application matrix through a shared constant used by the action layer, the registry, and asserted against the RLS and storage policies. The parity test is no longer circular — a literal role × resource id matrix now pins RLS itself, and the old parity assertion has been demoted to an explicitly-labelled compiler-fidelity check.

Reviewed against `docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §5, §7, §11, §13, §14, §15 (Phase 2), §16, §17, §19.
Scope: the Phase 2 migration, `lib/patients/read-permissions.ts`, `actions/{patient-documents,medical-note-attachments}.ts`, `lib/ai/authorization.ts`, `lib/ai/prompts/{staff,doctor}.ts`, `lib/ai/tools/registry.ts`, the five clinical resource definitions plus `clinical-shared.ts`, `lib/ai/resources/compile.ts`, the injection corpus, and all Phase 2 / updated Phase 1 tests. **No production code was modified by this review.**

## Verification performed

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/ai tests/unit/db tests/unit/security tests/unit/actions tests/unit/lib` — **234 files / 1899 tests pass**.
- `tests/unit/integration/{phase2-clinical-parity-rls,phase1-resource-query-rls,p4a-ai-tools-rls}.test.ts` against the local stack (keys via `supabase status -o env`) — **56/56 pass**.
- Read the live `pg_policies` definitions for `medical_notes_select_role_scoped`, `medical_note_attachments_select_role_scoped`, `patient_documents_select_staff`, `patient_assets_documents_select_staff`, and `clinic_members_read_packages`. All five match the pre-Phase-2 text except `clinic_members_read_packages`, which carries only the narrowing. The broadened policies from the first implementation are **not** present in the local database.
- Read `can_access_clinical_record()` ([20260802120000:640-678](supabase/migrations/20260802120000_p76a_clinical_authoring_foundations.sql#L640)) and confirmed `prescriptions_select_scoped` / `lab_requests_select_scoped` / `sick_leaves_select_scoped` pre-date Phase 2 and already admit all five clinic roles — so `roles: PERMISSION_USER_ROLES` on those three definitions is derived from the real policy, not granted by this phase.
- Grepped the tree for Phase 3+ artifacts (`lib/ai/actions/`, `execute_action`, `describe_action`, `ai_action_receipts`, `ai_action_confirmations`, `step_up_verified_at`) — **zero hits**.
- Confirmed the P7 document-platform dirty work still carries 08-09 mtimes and is untouched.

---

## Remaining finding

### L-5 — `query_resource`'s model-facing description still lists `patient_documents` as an available resource

**Severity:** Low
**Where:** [lib/ai/tools/query-resource.ts:13](lib/ai/tools/query-resource.ts#L13)

The tool description hard-codes the resource catalogue:

> `Resources currently available are patients, appointments, departments, services, profiles, follow_ups, documents, insurance_providers, medical_notes, prescriptions, lab_requests, sick_leaves, patient_documents, and patient_packages.`

`patient_documents` is no longer in `RESOURCE_REGISTRY` — that removal is precisely what resolves H-1. The string is the one place the reverted resource survived, and it is the surface the model actually reads. Consequences, in order of significance:

1. It contradicts the H-1 fix on the only surface the model sees. A model asked "what patient documents do we have on file?" is told the resource exists and will call it, then receive `unknown_resource`. The phase's stated outcome — the Assistant does not offer `patient_documents` — is not what the Assistant is told.
2. The list is duplicated from the registry rather than derived from it, and it has *already* drifted once. `describe_capabilities` returns the truthful, permission-filtered list ([registry.ts:81-107](lib/ai/resources/registry.ts#L81)); this static string cannot be permission-filtered and has no test.

No data is reachable through this: `assertResourceAccess` ([registry.ts:53-79](lib/ai/resources/registry.ts#L53)) and `compileResourceQueryPlan` ([compile.ts:244](lib/ai/resources/compile.ts#L244)) both reject an unregistered id, and the `patient_documents` table's RLS and storage policies are untouched. This is a correctness and capability-advertisement defect, not an authorization one.

**Required fix:** remove `patient_documents` from the sentence. Preferably remove the enumeration entirely and derive it from `RESOURCE_REGISTRY`, or replace it with a pointer to `describe_capabilities` (which the same description already recommends for uncertainty).
**Acceptance:** a test asserts that every resource id named in the `query_resource`, `get_record`, and `aggregate_resource` descriptions exists in `RESOURCE_REGISTRY`, and that every registry id is named — so the next add/remove cannot drift the description again.

---

## Resolved findings — verified fixed

Stable ids retained from the first review.

### H-1 — `patient_documents` widened to three roles the app refuses → **RESOLVED**

The migration no longer touches `patient_documents_select_staff`; the live policy is the original `admin`/`receptionist` text, and `patient_assets_documents_select_staff` is likewise unchanged. `lib/ai/resources/definitions/patient-documents.ts` is **deleted** and the resource is absent from `definitions/index.ts` and `RESOURCE_REGISTRY` — H-1's required fix (a), which explicitly sanctioned dropping the resource until a product decision exists.

The matrix is now stated once and consumed at every layer: `PATIENT_DOCUMENT_READ_ROLES` ([lib/patients/read-permissions.ts:8](lib/patients/read-permissions.ts#L8)) replaces all five inline `["admin","receptionist"]` literals in `actions/patient-documents.ts`. `phase2-clinical-read-parity-migration.test.ts:45-56` pins the constant's use count and asserts the admin/receptionist array literal in both the table and storage policy text; `phase2-clinical-parity.test.ts:126-128` asserts the registry does not contain the resource; and `phase2-clinical-parity-rls.test.ts:671-683` proves live, per role, that admin and receptionist see the document row and its storage object while **manager, doctor, and assistant see neither** — metadata and bytes on the same matrix, which is exactly the three-layer assertion H-1's acceptance demanded.

### M-1 — `medical_notes` opened to `manager` → **RESOLVED**

The live `medical_notes_select_role_scoped` is the unmodified `20260519006000` text: `admin`/`receptionist` clinic-wide plus scoped `doctor`, with no `manager` or `assistant` branch. The AI resource declares `roles: MEDICAL_NOTE_READ_ROLES` (`admin`, `receptionist`, `doctor`) rather than `PERMISSION_USER_ROLES`, derived from the same constant `actions/medical-note-attachments.ts` uses for its two read gates, and its inline comment names the governing policy and migration and states the deliberate manager/assistant exclusion ([medical-notes.ts:26-31](lib/ai/resources/definitions/medical-notes.ts#L26)).

Enforcement is layered and each layer is tested: the registry role gate denies `manager`/`assistant` before execution ([registry.ts:58](lib/ai/resources/registry.ts#L58)); `describe_capabilities` does not advertise the resource to them (`phase2-clinical-parity.test.ts:238-249`); and if both were bypassed, RLS returns zero rows — proven live at `phase2-clinical-parity-rls.test.ts:685-706`, which pins note ids, attachment ids, **and** storage object paths per role in one assertion. This also closes the L-3 divergence: narrative, attachment metadata, and bytes are now demonstrably one matrix rather than two.

### M-2 — circular parity test → **RESOLVED**

Two distinct tests now exist. `"matches direct authenticated RLS output as a compiler-fidelity check"` ([:579](tests/unit/integration/phase2-clinical-parity-rls.test.ts#L579)) keeps the `assistantIds === directIds` comparison under an honest name. `"pins the pre-existing role × resource authorization matrix to literal ids"` ([:611-669](tests/unit/integration/phase2-clinical-parity-rls.test.ts#L611)) declares a literal `Record<UserRole, Record<resource, string[]>>` covering five roles × six resources — including the empty sets for `manager`/`assistant` on `medical_notes` and for `manager`/`doctor`/`assistant` on `patient_documents` — and asserts each against a direct authenticated query.

I checked M-2's acceptance directly: flipping the `manager` branch of `can_access_clinical_record()` changes the manager row for `prescriptions`/`lab_requests`/`sick_leaves`/`patient_packages`; flipping the `doctor` or `assistant` branch changes those roles' single-id expectations; flipping any branch of the `medical_notes` policy changes its rows; and any change to `clinic_members_read_packages` changes the package expectations. Every branch is covered by a literal assertion that cannot be satisfied by redefining the baseline.

### M-3 — misleading resource comments → **RESOLVED**

All five clinical definitions now carry an accurate inline justification naming the exact policy and the migration that last changed it: `medical_notes` → `medical_notes_select_role_scoped` / `20260519006000` with the excluded roles spelled out; `prescriptions`, `lab_requests`, `sick_leaves` → the `*_select_scoped` policies from `20260802120000` with the `can_access_clinical_record` delegation named; `patient_packages` → `clinic_members_read_packages` / `20260813140000`, correctly attributing the change to this phase. A reviewer reading only `lib/ai/resources/definitions/` can now reconstruct the role matrix, which was M-3's acceptance.

### L-1 — `patient_packages` narrowing without non-AI coverage → **RESOLVED**

The narrowing stands (it was the defensible half of the original migration) and now has direct coverage. `"covers non-AI patient-package consumers for in-scope, out-of-scope, and deleted patients"` ([:708-726](tests/unit/integration/phase2-clinical-parity-rls.test.ts#L708)) exercises the RLS layer the five non-AI call sites share: doctor-A sees only her patient's package, doctor-other-A only his, assistant-A resolves through the supervised-doctor union, admin/manager/receptionist see both active packages, and **no role sees the soft-deleted patient's package**. `phase2-clinical-read-parity-migration.test.ts:74-88` asserts the migration contains exactly one `for select`, one `can_access_clinical_record(` call, one `not p.is_deleted` term, no `for insert|update|delete|all`, and no function or trigger. The `ai.read_clinical` choice is now justified in the definition comment on treatment-plan-PHI grounds rather than left implicit.

### L-2 — injection coverage substituted, not extended → **RESOLVED**

Both original `get_patient_summary` cases are restored under the `patient` persona (where the tool is genuinely unreachable), the `cancel_my_appointment` variants are retained as *additional* `staff_admin` cases in EN and Levantine AR, and three new `stored_data_injection` cases seed payloads into `medical_notes.note`, `prescriptions.notes`, and `lab_requests.clinical_context` with `forbiddenTool: "get_record"` — a tool that **is** mounted for the persona. `p6a-injection-suite.test.ts:94-110` asserts each of the three fields has a case and that `reachableFor(case).has(forbiddenTool)` holds, which is L-2's acceptance verbatim. A new parameterized end-to-end test drives each payload through `sanitizeUntrustedDeep` + `withProvenance` and fails if the protocol shape survives into the transcript or the forbidden tool executes.

### L-3 — attachment / storage matrix undocumented → **RESOLVED**

Superseded by the H-1/M-1 reverts and made explicit twice over. The migration header now enumerates every clinical read surface — `medical_notes`, `medical_note_attachments`, `patient_assets_medical_note_attachments_select`, `patient_documents`, `patient_assets_documents_select_staff`, `clinic_members_read_packages` — and states for each whether it changed, closing with "No mutation or storage policy is broadened by this migration." The live storage-object assertions described under H-1 and M-1 prove the header is true rather than aspirational.

### L-4 — weak entitlement assertion and relation-blind row limit → **RESOLVED**

The entitlement test now loops per resource (`for (const id of CLINICAL_RESOURCES) expect(visibleIds).not.toContain(id)` — `phase2-clinical-parity.test.ts:230-232`), so a single leaked clinical resource fails. `compileRelations` now reduces `maxListRows` across explicitly requested relation fields ([compile.ts:214-219](lib/ai/resources/compile.ts#L214)) and the result is folded into the top-level `sensitiveListLimit` by `Math.min` ([compile.ts:344-352](lib/ai/resources/compile.ts#L344)), feeding the same pre-count bulk refusal ([compile.ts:515-525](lib/ai/resources/compile.ts#L515)). `"enforces maxListRows declared by an explicitly requested relation field"` proves it by temporarily declaring one on the shared `patient.blood_type` relation field and asserting the compiled limit.

---

## Non-blocking observations

Not findings; recorded so the next reviewer does not re-derive them.

1. **Plan §15 Phase 2 still lists `patient_documents`** among the phase's new resource definitions ([plan:557](docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md#L557)), and §7's initial set at [plan:279](docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md#L279) still includes it. The omission is deliberate and was sanctioned by H-1's fix (a), but the plan does not say so. A one-line annotation on both lines — deferred pending a product decision on whether manager/doctor/assistant should read patient-document metadata — would keep the plan and the tree in agreement. This is the same annotation L-5's fix should reference.
2. **`PATIENT_DOCUMENT_READ_ROLES` also gates mutations.** `uploadPatientDocument`, `deletePatientDocument`, and `restorePatientDocument` now pass the read constant to `requireMutationRole` ([actions/patient-documents.ts:268,358,417](actions/patient-documents.ts#L268)). Behaviour is unchanged — the write matrix was already `["admin","receptionist"]` — but the name promises reads and a future narrowing of read access would silently narrow writes. A separate `PATIENT_DOCUMENT_WRITE_ROLES` alias, even if identical today, would keep the two intents independently movable.
3. **The `role_forbidden` branch of `assertResourceAccess` has no direct test** anywhere in the suite. For Phase 2 it is a second layer only — the RLS matrix test proves manager and assistant read zero `medical_notes` rows regardless, and `describe_capabilities` is asserted not to advertise the resource to them — so nothing is at risk today. A one-line assertion that `query_resource({resource:"medical_notes"})` returns `permission_denied` / `role_forbidden` for a manager would pin the gate itself.

---

## Verified correct — do not re-litigate

Re-confirmed against the current tree and the live database; unchanged from the first review except where noted.

**The old AI-only clinical restriction is genuinely gone.** `assertClinicalRole` is deleted; `CLINICAL_ASSISTANT_ROLES` is an alias of `STAFF_ASSISTANT_ROLES` carrying a comment that it "must never be treated as a grant to a particular clinical table"; `assertClinicalToolAccess` performs the staff spine plus `ai.read_clinical` and no role test ([authorization.ts:109-117](lib/ai/authorization.ts#L109)). No `{doctor, assistant}` clinical role gate survives anywhere.

**Case B works, for the right reason, live.** `get_patient_summary` and `search_patient_visits` are `roles: ALL_STAFF` + `taskClasses: SHARED_TASKS` + `requiredFeatures: [AI_ASSISTANT_FEATURE, AI_CLINICAL_READ_FEATURE]` ([registry.ts:305-326](lib/ai/tools/registry.ts#L305)); both build on the RLS-bound `createClient()`, so a manager calling `get_patient_summary` reaches `medical_notes` and receives nothing. The live Case B test drives a mocked model through `query_resource` and returns `O+` from real Postgres under real RLS, and the per-role live test confirms admin, manager, and receptionist each read blood type and the pre-authorized prescription.

**Row scope is unchanged and enforced by RLS only.** Doctor-A sees exactly her own prescription / lab request / sick leave / note / package; doctor-other-A exactly his; assistant-A resolves through `auth_supervised_doctor_ids()` to the supervised doctor's rows and to nothing on `medical_notes`. No TypeScript re-implementation of scope exists in the path. Cross-tenant rows are absent from both direct and Assistant reads, and `exactIdLookup` maps a zero-count id lookup to `unauthorized_scope`.

**Tenancy defense-in-depth survives the legacy table.** `medical_notes` has no `clinic_id`; `tenantScope` emits the hidden `!inner` embed on `patients`, filters `__tenant_patient.clinic_id`, and strips the helper from every returned row — asserted both by the compiler test and by the live sanitization test (`expect(rows[0]).not.toHaveProperty("__tenant_patient")`). The other four resources keep the direct `clinic_id` predicate, asserted per-resource.

**Field exposure is intended and bounded.** All five definitions use `declaredFieldPolicy` with no role carve-outs, per §19.1. `subject_national_id` on prescriptions / lab requests / sick leaves is excluded from `defaultFields` and carries `maxListRows: 25`, matching §19.2. Relations are server-owned PostgREST expressions with their own field policies; the model never supplies a table, column, or operator.

**Prompts.** The false "those tools are unavailable for their role" claim and the "non-clinical patient information" framing are gone from both EN and AR; both locales permit display of authorized records while hard-refusing diagnosis, treatment recommendation, and drug/dose, with the same refusal sentence in both personas. The prompt-injection paragraph is untouched. §14.5 is satisfied: the same working tree mounts the clinical resources.

**The migration touches one policy and only narrows it.** One `for select`, one `can_access_clinical_record` call, no function, trigger, or mutation policy, no storage policy, soft-delete and tenancy terms preserved. Asserted by `phase2-clinical-read-parity-migration.test.ts` and confirmed against `pg_policies`.

**No Phase 3+ leakage.** No `lib/ai/actions/`, no `execute_action` / `describe_action`, no `ai_action_receipts` / `ai_action_confirmations`, no confirm-token or step-up code. The workflow engine and its three action tools are untouched, as Phase 4 requires.

**Unrelated dirty work preserved.** The P7 document-platform changes (`lib/documents/**`, `components/documents/**`, `actions/documents.ts`, the P7 test files) carry 08-09 mtimes; `npx tsc --noEmit` is clean and 1899 unit tests pass with them in place.

**Phase 1 tests were extended, not weakened.** The registry-wide loops iterate all 13 resources and the tenant-predicate assertion accommodates `medical_notes` rather than exempting it. Pre-existing tests that asserted the old restriction were rewritten to assert the new invariant, per §18.
