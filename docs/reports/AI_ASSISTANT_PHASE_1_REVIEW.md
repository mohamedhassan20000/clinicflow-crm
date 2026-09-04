# AI Assistant — Phase 1 Review (Resource registry & generic read)

**Verdict: Phase 1 — PASS.** All 8 findings from the previous cycle (M-1, M-2, L-1 … L-6) are resolved in the real implementation and each is held by a regression test or a negative control. No new Critical, High, Medium or Low finding was introduced by the fixes.

Reviewed against `docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §5, §7, §11, §13, §15 (Phase 1), §16, §17, §19.
Scope: the full working-tree diff plus every new file under `lib/ai/resources/`, `lib/ai/tools/`, and the Phase 1 test files. Production code was not modified by this review.

**Verification performed (this cycle)**

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/ai tests/unit/security tests/unit/components/p4b-assistant-chat.test.tsx tests/unit/lib/entitlements.test.ts` — 51 files / **697** tests pass (was 692; the delta is the new Phase 1 assertions).
- `tests/unit/integration/phase1-resource-query-rls.test.ts` against the local Supabase stack (keys via `supabase status -o env`) — **11/11 pass** (was 5/5).
- `p4a-ai-tools-rls`, `p45c-ai-commercial-integration`, `p46-ai-permissions-rls`, `p46a-analytics-rpc-isolation`, `p49a-assistant-customization-rls`, `assistant-scope-rls` against live policies — 148 tests pass, so the Phase 0/0b/1 additions did not regress the existing RLS suites.
- **Independent live PostgREST probe** (not via the repo's tests) re-confirming the L-1 semantics from scratch: a raw `*` inside `ilike` expands to `%` and matched an unintended row; a backslash-escaped `*` matched **nothing**, i.e. escaping cannot preserve it as a literal — so rejection is the only correct handling. The same probe confirmed the retained escape class is functionally correct: `\%`, `\_` and `\\` each match their literal character and do **not** match the wildcard-expanded control rows seeded alongside them.
- Manual read of the compiler, all 8 resource definitions, the 4 tools, the registry/mount diff, and the full `git diff` of every tracked file under `lib/ai/**`.

---

## Finding-by-finding resolution

### M-1 — deterministic pagination ordering — **RESOLVED**

`CompiledResourceQuery` now carries `tiebreak: { column: "id"; direction: "asc" }` ([types.ts:164](lib/ai/resources/types.ts#L164)), emitted unconditionally by the **pure** compiler ([compile.ts:321-323](lib/ai/resources/compile.ts#L321-L323)) — as required, so the property is unit-testable without a client — and applied by the executor as a second `.order()` after the primary one and before `.range()` ([compile.ts:506-510](lib/ai/resources/compile.ts#L506-L510)).

All three acceptance criteria are met:
1. `tests/unit/ai/phase1-resource-registry.test.ts:207-224` asserts the tiebreaker on the compiled plan for **every** resource × **every** declared sort key × **both** directions.
2. `:284-287` asserts the executor's `order` calls in sequence — `[["full_name",{asc:true}], ["id",{asc:true}]]` — so an inverted or dropped tiebreaker fails.
3. `phase1-resource-query-rls.test.ts:646-668` seeds 5 patients sharing one `full_name`, pages them at `page_size: 2` across pages 1–3 with `direction: "desc"`, and asserts the union of ids equals the seeded set exactly, with `new Set(...).size === 5` catching duplicates and the length check catching omissions. This runs against live Postgres, which is the only place the defect could manifest.

Every Phase 1 table has a UUID `id`, and the "queries all eight resources" live test exercises the tiebreaker on all 8 without error.

### M-2 — shared authorization-source roles — **RESOLVED**

`ALL_STAFF_ROLES` is deleted from `lib/ai/resources/fields.ts`; all 8 definitions now declare `roles: PERMISSION_USER_ROLES`, imported from [lib/page-permissions.ts:8](lib/page-permissions.ts#L8). This is the stronger of the two fixes the finding allowed: rather than *mirroring* the app constant, the AI layer *is* the app constant, so drift is impossible by construction rather than by assertion — `ROLE_PAGE_SLUGS` is derived from the same array ([page-permissions.ts:166](lib/page-permissions.ts#L166)), confirming it is genuinely the app-side source of truth and not a second AI-local list.

Acceptance criteria:
1. `phase1-resource-registry.test.ts:110-121` imports `PERMISSION_USER_ROLES` and compares against every resource's `roles`.
2. Every resource carries the required inline justification comment. The three RLS-broader-than-UI cases name their policy explicitly — `departments_select_own`, `insurance_select_clinic`, `services_select`, plus `profiles_select_same_clinic` — and the row-scoped ones name the policy that narrows them (`patients_select_role_scoped`, `appointments_select_role_scoped` incl. the assistant supervised-doctor union, `follow_ups_select_role_scoped`, `documents_select_scoped` + catalog).
3. `:114` asserts no resource declares a role outside `PERMISSION_USER_ROLES`.

### L-1 — literal/wildcard `ilike` handling — **RESOLVED**

The compiler rejects `*` for `ilike` at parse time with `invalid_filter_value` and `forbidden_character: "*"` ([compile.ts:80-89](lib/ai/resources/compile.ts#L80-L89)), before any query is built; the executor keeps escaping `\`, `%`, `_` ([compile.ts:395](lib/ai/resources/compile.ts#L395)). The comment at both sites now states the true reason, and my independent live probe (above) confirms that claim: escaping `*` does not neutralize it, it breaks the match entirely, so "strip or reject instead" was the correct branch of the required fix.

Acceptance criterion is met by a **dedicated** test covering `*` alone (`phase1-resource-registry.test.ts:354-368`), separate from the existing combined `%`/`_`/`\` fixture at `:334-352`, plus a live negative control at `phase1-resource-query-rls.test.ts:670-697` proving the tool refuses before PostgREST can expand the star. The stated invariant and the code now agree.

### L-2 — truthful aggregate / k-anonymity wording — **RESOLVED**

The `aggregate_resource` description now says what is true — *"Phase 1 counts are exact and unsuppressed; no k-anonymity guarantee applies on this tool path"* — and points to `get_patient_stats` only for **grouped** distributions, which is the property that tool actually enforces ([aggregate-resource.ts:17-18](lib/ai/tools/aggregate-resource.ts#L17-L18)). The false *"privacy-preserving get_patient_stats"* claim is gone.

The decision is written down in the plan at **§7.4** and cited from the code comment directly above the description ([aggregate-resource.ts:14-16](lib/ai/tools/aggregate-resource.ts#L14-L16)), so the divergence from the `ai_get_patient_stats` floor is now deliberate and traceable. `phase1-resource-tools.test.ts:181-192` snapshots both required phrases **and** asserts the retired claim is absent, which is what makes this drift-proof rather than a one-time edit.

### L-3 — field-policy-aware sorting — **RESOLVED**

`compileResourceQueryPlan` now intersects the declared sorts with `fieldPolicy(user)` and validates against that set, returning `invalid_sort` whose `valid_sorts` lists only the caller's readable keys ([compile.ts:284-294](lib/ai/resources/compile.ts#L284-L294)). The default sort also falls back to the first *readable* key, so a Phase 2 narrowing cannot silently produce an unauthorized default order.

`phase1-resource-registry.test.ts:226-245` narrows `patients.date_of_birth` to `admin`, asserts a receptionist gets `invalid_sort`, and asserts the returned `valid_sorts` excludes the withheld key — the negative control the finding asked for. Since no `FieldSpec.roles` is set in Phase 1, this is the only way to exercise the path today, and it does so honestly rather than by asserting the inert default.

### L-4 — bounded pagination — **RESOLVED**

`MAX_PAGE = 100` is defined once ([compile.ts:27](lib/ai/resources/compile.ts#L27)) and enforced in two independent places: the tool input schema (`page: z.number().int().min(1).max(MAX_PAGE)`, [resource-input.ts:31](lib/ai/tools/resource-input.ts#L31)) and the compiler itself ([compile.ts:239-252](lib/ai/resources/compile.ts#L239-L252)), so a caller bypassing the schema is still bounded. The refusal carries `{ max_page, max_page_size }` so the model learns the ceiling instead of retrying, and `describe_capabilities` advertises `max_page` alongside `row_cap` ([describe-capabilities.ts:54-55](lib/ai/tools/describe-capabilities.ts#L54-L55)). Worst-case offset is now 19,800 rows rather than unbounded.

Tests: `phase1-resource-registry.test.ts:195-204` asserts `MAX_PAGE + 1` returns `invalid_pagination` carrying the maximum; `phase1-resource-tools.test.ts:178` asserts `describe_capabilities` reports `max_page: 100` next to `row_cap: 200`.

### L-5 — correct notices — **RESOLVED**

The notice is built from the page offset: `Showing rows ${from + 1}–${from + rows.length} of ${total}.` ([compile.ts:531](lib/ai/resources/compile.ts#L531)). `phase1-resource-registry.test.ts:290-321` asserts page 2 of a 7-row set at `page_size: 2` yields *"Showing rows 3–4 of 7."*, page 1 yields *"Showing rows 1–2 of 7."*, and a complete first page still yields `truncated: false, notice: null`.

### L-6 — live RLS coverage across roles and resources — **RESOLVED**

The integration suite grew from 5 to 11 live tests and now covers what §16's matrix asks for:
1. **assistant** — a real `assistant_doctor_assignments` row is seeded and the supervised-union scope is asserted on **both** `patients` and `appointments`, with `total` reflecting the narrowing (`:509-527`). **manager** gets its own clinic-wide case with an explicit cross-tenant exclusion (`:494-507`).
2. **All 8 resources** are queried live with their declared relations requested in one test (`:529-644`), which is what validates every `!<constraint>_fkey` literal — `patients_department_id_fkey`, `documents_patient_id_fkey`, `follow_ups_recorded_by_fkey`, and the rest — against the real schema.
3. **`documents` catalog vs. RLS is attributed separately** (`:699-727`): the test first proves via a direct authenticated query that the doctor *can* see `documentCatalogDeniedA` (RLS-permitted, catalog-denied) and *cannot* see `documentOtherA` (RLS-denied), then asserts the tool returns neither. A regression in either layer alone is therefore distinguishable, exactly as the acceptance criterion required.

Cross-tenant and missing-id byte-identity is still proven live at `:729-744`.

---

## Cross-cutting checks

- **No Phase 2+ leakage.** `git diff` over `lib/ai/**` touches only `capabilities.ts`, `commercial-policy.ts`, `conversations.ts`, `errors.ts`, `patient-reply-mode.ts`, `platform/execution.ts`, `tool-presentation.ts`, `tools/index.ts`, `tools/list-my-capabilities.ts`, `tools/registry.ts` — all Phase 0/0b/1 mechanics. `lib/ai/authorization.ts` (`assertClinicalToolAccess`), `lib/ai/prompts/**` and the workflow engine are **untouched**. No clinical resource (`medical_notes`, `prescriptions`, `lab_requests`, `sick_leaves`) is declared. The three `lib/ai` comment edits are wording corrections that remove now-false `pro_ai` slug claims — Phase 0b's own scope, not behaviour.
- **No unrelated dirty-work changes.** The set of modified tracked files is unchanged from the previous cycle; every fix landed in the new (untracked) Phase 1 files, the Phase 1 tests, and the plan's §7.4. Nothing was added to the pre-existing P7 document-platform work, and no P7 file was touched to make a Phase 1 test pass.
- **`describe_capabilities` in `staff_help`.** Its addition to the help mount keeps that class's containment property: it reads no clinic-data table, returns only permission-filtered registry metadata, and returns `resources: []` when the feature is off (`phase1-resource-tools.test.ts:108-118`). The `p47a` containment test was updated with a comment stating why, not silently.
- **Service-role guard.** Still clean — no service-role client anywhere in the read path; the static scan already walks `lib/` recursively.
- **Injection containment.** The generic path goes through the same `sanitizeUntrustedDeep` + `withProvenance` boundary as every other data tool, asserted end-to-end on a stored `<system>` payload (`phase1-resource-tools.test.ts:227-242`).

---

## Observations (no action required, not blocking)

- **The live star test's second assertion is decorative.** `phase1-resource-query-rls.test.ts:690-696` re-reads `expandedStarPatient` by id rather than probing an escaped-star pattern, so the "expanded" fixture doesn't currently prove anything the rejection assertion doesn't. The underlying claim is nonetheless true — I verified it independently against live PostgREST this cycle. If you want that fixture to earn its place, query `full_name ilike '%Literal\*Star%'` directly and assert it returns **no** rows (proving escaping cannot rescue a star) alongside the raw-star probe returning both.
- **The L-3 test mutates the registry singleton** (`dateOfBirth.roles = ["admin"]`, restored in `finally`) rather than using a standalone fixture resource. Correct today because vitest runs a file's tests sequentially, but a purpose-built fixture resource would be immune to future parallelism.
- **Default sort silently shifts** when the first declared sort becomes role-narrowed in Phase 2 (`readableSorts[0]` rather than `sorts[0]`). This is the safe direction, but it means two roles can get different default orders for the same call — worth stating in the definition docs when the first `FieldSpec.roles` lands.
- **The final page still carries `notice: null`.** A model paging to the last page gets no window statement at all, since `notice` is gated on `truncated`. Consistent with §7.5 and with the passing acceptance criterion; only worth revisiting if the prompt starts relying on the notice to know it has finished paging.
- **Two role lists still coexist.** `lib/ai/tools/registry.ts` keeps its pre-existing local `ALL_STAFF` for the 4 new tools while the resources use `PERMISSION_USER_ROLES`. Harmless — each resource independently re-asserts its own roles at `assertResourceAccess`, so the tool-level list can only ever be the looser gate — but folding `ALL_STAFF` into the app constant would remove the last hand-maintained role array on this path before Phase 3 declares actions.
- Prior-cycle observations that still stand and need no rework: `patients.blood_type`/`date_of_birth` shipping under `ai.read_operational`; `documents` gated on `ai.read_operational` rather than `ai.documents` (settle before Phase 6); `asc` default direction on time-ordered resources; the forward-declared `sensitivity` / `roles` / `groupBy` / `RelationSpec.fieldPolicy` surface; and `RelationSpec` carrying no feature gate (revisit when a clinical relation is declared in Phase 2).
- **Tree state.** The recommendation from the previous cycle is unchanged: the ~1,100 lines of P7 document-platform work still interleave with Phase 0b inside `lib/supabase/admin.ts` and both message files. Landing or parking it separately would let the Phase 1 diff be reviewed and reverted as a unit.

---

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-1 | Medium | No tiebreaker sort — paginated reads can duplicate or skip rows | **Resolved** — `tiebreak` in the pure plan, applied before `range`, proven on live Postgres with 5 tied rows |
| M-2 | Medium | `roles` is a hand-maintained AI list; the invariant test is a tautology | **Resolved** — all 8 use the imported `PERMISSION_USER_ROLES`; RLS-breadth comments added; test imports both sides |
| L-1 | Low | `ilike` does not escape `*` | **Resolved** — `*` rejected at compile time; live probe confirms escaping cannot work; dedicated test + live control |
| L-2 | Low | `aggregate_resource` asserts a privacy property it lacks | **Resolved** — description corrected, decision recorded in plan §7.4, snapshot test asserts both directions |
| L-3 | Low | `sort` not intersected with `fieldPolicy` | **Resolved** — sorts filtered by field policy; negative control with a narrowed field |
| L-4 | Low | `page` unbounded | **Resolved** — `MAX_PAGE = 100` enforced in schema *and* compiler, advertised by `describe_capabilities` |
| L-5 | Low | `notice` ignores the page offset | **Resolved** — offset-aware window string, asserted on page 2 |
| L-6 | Low | `assistant`/`manager` and 7 of 8 resources unproven against live RLS | **Resolved** — 11 live tests; assistant supervision, manager, all 8 resources with relations, documents catalog/RLS attributed separately |

Phase 1 is correct, tested where it matters, and contains nothing that belongs to a later phase. It is ready to build on.
