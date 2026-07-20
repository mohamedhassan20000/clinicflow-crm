# P4.6A — Tool Registry, Aggregate RPCs, Operational Tools & Permission Plumbing

**Date:** 2026-07-20 (review fixes applied 2026-07-20)
**Branch:** `feat/p46a-staff-analytics-tools`
**Status:** Implemented, reviewed, and review fixes applied. No UI (P4.6B owns the chat surface).
**Review:** `docs/reviews/P4.6A_REVIEW.md` — *APPROVED WITH REQUIRED FIXES*. All findings addressed; see §9.
**Phase review:** `docs/reviews/P4.6_PHASE_REVIEW.md` — fixes implemented in `docs/reports/P4_6_PHASE_REVIEW_FIXES.md` (H1, M1–M7, L1–L13). Findings touching this sub-phase: the `run_clinic_report` description/denial seam (H1), database-boundary entitlement and grant enforcement (M1, M2), audit coverage for denials and clarifications (M3), and the row-cap, doctor-filter, and sanitization corrections (M7, L5, L6, L7).
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.6 execution split, sub-phase P4.6A.
**Companion analysis:** `docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md` §5, §7, §10.
**Depends on:** P4A/P4B (assistant foundation), P4.5A–P4.5C (AI platform), P4.6C (entity search).

---

## 1. Scope delivered

Everything in the roadmap's P4.6A *in-scope* list:

| Deliverable | Where |
|---|---|
| Declarative AI tool registry (keystone refactor); existing 5 P4 tools migrated onto it, behavior unchanged | `lib/ai/tools/registry.ts`, `lib/ai/tools/index.ts` |
| `SECURITY DEFINER` clinic-scoped aggregate RPCs with small-cell suppression | `supabase/migrations/20260720130000_p46a_staff_analytics.sql` |
| Operational list tools with hard row caps + fixed field allow-lists | `lib/ai/tools/list-appointments.ts`, `count-new-patients.ts`, `list-pending-followups.ts` |
| Financial tools | `lib/ai/tools/get-revenue-summary.ts`, `compare-revenue-periods.ts`, `list-outstanding-invoices.ts` |
| `run_clinic_report` over the `lib/reports/data.ts` cores | `lib/ai/tools/run-clinic-report.ts` |
| `staff_operational_query` certified task class | `lib/ai/platform/types.ts`, `lib/ai/platform/registry.ts`, `lib/ai/platform/execution.ts` |
| `ai.staff_analytics` + `ai.financial_insights` entitlements | Already seeded for `pro_ai` (P4.5C); now consumed |
| Per-user financial permission storage + admin management | `user_ai_permissions` table, `lib/ai/permissions.ts`, `actions/ai-permissions.ts` |
| `assertFinancialInsightsAccess` + deny-by-default registration | `lib/ai/authorization.ts`, `lib/ai/tools/index.ts` |
| Tool-authorization test suite | `tests/unit/ai/p46a-staff-analytics-tools.test.ts`, `tests/unit/integration/p46a-analytics-rpc-isolation.test.ts` |

Plus the staff/department/service ranked search infrastructure that P4.6C explicitly deferred to
this sub-phase (§1074 *out of scope*, and the §10 migration table of the expansion proposal).

**Out of scope and not built:** any chat UI, patient analytics, help/navigation tools, write tools.

---

## 2. The tool registry (keystone refactor)

`buildStaffTools` was a `switch` over roles returning hand-assembled objects. It is now a generic
deny-by-default filter over `AI_TOOL_REGISTRY`, where each tool declares:

```ts
{ name, build(ctx), roles, requiredFeatures, requiredUserPermission?,
  taskClasses, capabilityDescription: { en, ar } }
```

`resolveToolMount()` mounts a tool only when **all four** gates pass: role ∈ `roles`, the turn's
certified task class ∈ `taskClasses`, every `requiredFeatures` key resolves true, and any
`requiredUserPermission` is granted. Permission lookups are de-duplicated per key, so the financial
grant costs at most one read per turn.

`taskClasses` is a real gate rather than documentation (review M2): it was previously declared on
every entry and read by nothing, so the mount only looked correct because roles happened to align.
`docsSlug` was declared and never set or read on any entry, and has been removed rather than left as
metadata that would be wrong by the time P4.7 depended on it (review L9).

Three consequences worth stating:

1. **Adding a tool is one module + one entry + tests.** It is now structurally impossible to add a
   tool without declaring who may use it.
2. **`capabilityDescription` lives with the mount decision**, so P4.7's capability panel and the
   model's actual tool array derive from one resolution and cannot drift.
3. **Non-mounting became the primary defense.** An unauthorized tool does not exist in the model's
   world — it cannot be called, described, or coaxed out by injection.

Because tool resolution now reads entitlements and permissions, `buildStaffTools`,
`createStaffAgent`, and `createDoctorAgent` became async; `app/api/agent/chat/route.ts` awaits.

---

## 3. Database layer

Migration `20260720130000_p46a_staff_analytics.sql`, applied and exercised against local Postgres.

### 3.1 `user_ai_permissions`

Follows `user_page_permissions` — clinic FK, `updated_by`, touch trigger, and RLS of *read own* +
*admins manage their clinic* — with a `CHECK` constraining the key set to `ai.financial_insights` so
a typo cannot silently create an inert grant.

It **deliberately diverges** from that table in two ways (review H3; the original "mirrors it
exactly" claim was both literally true and the defect). The PK is `(clinic_id, user_id,
permission_key)`, and a composite FK binds `(user_id, clinic_id)` to `profiles (id, clinic_id)`. Without
those, an admin of clinic B could insert a row naming a clinic-A user with `clinic_id = B`: the RLS
`with check` passed because the row claimed clinic B, and the globally-unique key was then taken, so
clinic A's own admin could never upsert the real grant. `user_page_permissions` still carries the
unconstrained shape — that predates P4.6A, is not in this sub-phase's scope, and is recorded in §9.4
as a recommended follow-up.

This table exists because **RLS is not sufficient here**: `patient_deposits` and
`outstanding_settlements` already permit manager reads. The manager restriction is therefore an
application-layer decision by necessity, and this is its storage (roadmap §P4.6 security note).

### 3.2 Aggregate RPCs

`ai_get_clinic_summary`, `ai_get_patient_stats`, `ai_get_appointment_stats`,
`ai_get_revenue_summary`, `ai_compare_revenue_periods` — all `SECURITY DEFINER`, `STABLE`,
`set search_path = ''`, and all routed through one shared guard:

```sql
ai_assert_analytics_caller(p_scope text) -- 'operational' | 'clinic_analytics' | 'financial'
```

The guard re-resolves `auth_clinic_id()` / `auth_role()` itself and raises for unauthenticated
callers and for doctors (clinic-wide analytics are out of their scope entirely). The scope parameter
replaces the original `p_financial boolean` (review H2): with one boolean, a receptionist was refused
only *financial* reads, so for the clinic-wide aggregates the application registry's `roles` array was
the only layer denying them — which is not defense in depth. `clinic_analytics` and `financial` are
both admin/manager; `operational` additionally admits receptionists. The boolean predecessor is
dropped in the same migration so no caller can reach the weaker guard by argument type. **No RPC accepts a clinic id**, so a caller cannot aim an aggregate at another
tenant; tenancy is server-derived, exactly like actor identity everywhere else in the assistant.

`ai_get_revenue_summary` deliberately mirrors the arithmetic of the existing
`public.get_revenue_summary` (the reports-page core) so an assistant answer and the report a user
can open themselves reconcile to the same numbers.

### 3.3 Small-cell suppression

Buckets below a floor of 5 report `count: null, display: "<5"`. **Hiding a small cell is not on its
own a privacy control**, because the buckets partition the population exactly, so a lone suppressed
cell is recovered by `total − Σ(visible)` (review H1). Two properties are therefore enforced
together in `ai_get_patient_stats`, and neither suffices alone:

1. **Complementary suppression** — if anything is suppressed, the smallest still-visible bucket keeps
   being suppressed until at least two cells are hidden *and* their counts sum to at least the floor.
   The recoverable residual is then a band of ≥5 spread over ≥2 cells.
2. **The co-published total is no longer exact when suppression is active** — `patients_total` is
   `null` and only a floor-rounded `patients_total_approx` is offered, so even the combined residual
   cannot be pinned down.

`suppressed_bucket_count` is returned so the assistant answers honestly ("2 groups were too small to
report") rather than guessing. The per-cell `ai_suppress_small_cell` helper was **removed**: a
function that sees one count cannot know whether hiding it leaves a solvable residual, so keeping it
would invite the exact construction it appeared to prevent.

**Recorded asymmetry:** `ai_get_appointment_stats` applies *no* suppression, deliberately. Its
buckets are operational counts per status/doctor/department — not patient attributes — and
admin/manager already read exactly these figures on the reports page. Suppressing them would degrade
an operational tool to protect nothing.

### 3.4 Staff / department / service ranked search

Generated `search_name` columns on `profiles`, `departments`, `services`, plus
`search_staff_ranked` / `search_departments_ranked` / `search_services_ranked`. These reuse P4.6C's
`normalize_search_text` verbatim and are **`SECURITY INVOKER`**, so visibility comes from existing
table RLS rather than from the function.

They have a real consumer: `list_appointments` and `run_clinic_report` accept a doctor or department
*by name*, resolved through the same P4.6C confidence contract — proceed only on a confident unique
match, otherwise return candidates and ask the user. The tool never picks a namesake itself, **and a
uuid-shaped argument no longer short-circuits that contract**: it is verified against the caller's own
RLS-scoped visibility and falls to `not_found` if it does not resolve, so the model cannot assert an
entity id from free text (review M4).

**No trigram indexes are created for these three columns** (review M5). A GIN trgm index accelerates
the trigram *operators*; these functions compute `similarity()` as a scalar and filter on the score,
which is not sargable, so the index was pure write amplification — on `profiles`, a table every
authenticated request touches. Adding a `search_name % v_query` conjunct to make it usable was
rejected: `%` applies pg_trgm's own 0.3 threshold, well above the 0.18 recall floor these functions
intentionally use, so it would silently drop the fuzzy matches the feature exists for. These are
per-clinic tables of at most a few hundred rows; scan-and-rank is the honest plan. This does **not**
transfer to `patients.search_name` (P4.6C), whose table grows without bound — that index stays, and
its access path is a P4.6B follow-up.

---

## 4. Role matrix as implemented

| Tool | Admin | Manager | Receptionist | Doctor |
|---|---|---|---|---|
| `get_clinic_summary`, `get_patient_stats`, `get_appointment_stats` | ✅ | ✅ | ❌ | ❌ |
| `list_appointments`, `count_new_patients`, `run_clinic_report` | ✅ | ✅ | ✅ | ❌ |
| `list_pending_followups` | ✅ | ❌ *(see below)* | ✅ | ❌ |
| `get_revenue_summary`, `compare_revenue_periods`, `list_outstanding_invoices` | ✅ | ⚠️ entitlement **+** per-user grant | ❌ | ❌ |

Admins carry the financial grant implicitly (they already administer billing and every financial
page); managers default OFF and require an explicit admin grant; receptionists and doctors are
excluded by non-registration.

### Three deliberate deviations from the roadmap matrix

All narrow access rather than widen it, and each exists because an existing platform authority
already denies the role. **The assistant must never be a way to reach data the same user is refused
in the UI.** All three are now recorded in the plan's normative §1055 matrix (review I3), so a later
sub-phase does not "fix" the registry back to a matrix that would ship a guaranteed runtime error.

1. **Managers are excluded from `list_pending_followups`.** `get_followups_dashboard` raises
   `42501` for managers (baseline rule, `20260512140000`). Registering the tool would have produced
   a guaranteed runtime error and implied an access path that does not exist.
2. **`run_clinic_report` enforces a per-report role list** mirroring each RPC's own guard:
   cancellations/no-shows = A/M/R, doctor & receptionist performance = A/M, revenue = A/M
   (financial-gated), follow-ups = A/R. Denial happens **before** any read.
3. **Receptionists are excluded from the clinic-wide aggregates** while keeping the operational
   lists and counts. The plan's "operational list/stat tools" row reads naturally as including
   `get_patient_stats`, but that tool returns a *patient-attribute distribution*, a different privacy
   class from an appointment list.

---

## 5. Containment properties

- **Row caps:** `list_appointments` 50, `list_pending_followups` 50, `list_outstanding_invoices` 25
  (also the schema max). Results carry `row_cap`/`truncated` so the model reports honestly rather
  than implying it saw everything.
- **Field allow-lists.** `list_appointments` returns schedule/status/patient name/file number/
  doctor/department — appointment notes, cancellation reasons, and every financial column are
  dropped. `list_pending_followups` strips `national_id`, `payment_note`, and amounts out of the
  richer RPC payload. `list_outstanding_invoices` returns only name, amount, and age.
- **Date ranges** resolve through the same `resolveDateRange` core the reports pages use, and every
  tool range is clamped to 400 days by the single `resolveToolDateRange` path — including both
  periods of `compare_revenue_periods`, which previously called `resolveDateRange` directly and so
  escaped the cap entirely, making the phase's most expensive tool the one able to scan all of
  history (review M1). The clamp is also no longer silent: results carry `clamped` and a
  `clamp_note`, so the assistant can say it narrowed the range instead of confidently answering a
  question nobody asked (review L1).
- **`list_outstanding_invoices` reconciles with revenue.** It now filters `status = 'completed'`,
  matching `ai_get_revenue_summary` exactly, so the assistant cannot contradict itself between two of
  its own tools or disagree with the revenue report page a user opens to check it. It accepts an
  optional clamped range and states `scope: "all_time"` explicitly when none is given (review M6).
- **Audit:** every tool writes a content-free `log_agent_tool_call` row (counts, presets, filter
  flags — never query text or patient data).
- **Per-invocation re-authorization:** registration is never sufficient. Each `execute()` re-runs
  role, subscription, entitlement, page visibility, and (financial) the per-user grant, so a
  revocation mid-conversation denies the very next call. This holds against **every** denied role,
  not only doctors: the clinic-wide aggregates call `assertClinicAnalyticsToolAccess`
  (admin/manager), which is strictly narrower than the operational
  `assertAnalyticsToolAccess` (admin/manager/receptionist), and the `clinic_analytics` SQL scope
  denies a third time in the database (review H2).
- **Tenant text is neutralized before it enters model context.** P4.6A is what first carries
  tenant-authored strings — patient names, department names, follow-up outcomes — from the database
  into the conversation, so stored prompt injection becomes reachable the moment P4.6B mounts these
  tools. See §8.

---

## 6. Verification

Re-run in full after the review fixes.

| Gate | Result |
|---|---|
| `supabase db reset` | All migrations apply cleanly from scratch |
| `npm run typecheck` | Clean |
| `npm run lint` | **0 errors**, 25 warnings (all pre-existing, none in P4.6A files) |
| `npm test` (unit) | **174 files / 1064 tests passing** |
| `npm run test:integration` (live Postgres) | **22 files / 204 tests passing** |
| `npm run build` | Compiled successfully |

Migration applied to local Postgres and the RPCs driven directly. Confirmed live:

- Aggregates return correct values for the caller's clinic (`patients_total` 8 vs 3 across two clinics).
- **Suppression is not reversible on real rows:** with 6 `O+` and 2 `A+` patients — the review's
  worked reversal, where `8 − 6 = 2` recovered the hidden cell exactly — the payload now suppresses
  two buckets and withholds the exact total, so there is nothing left to subtract from.
- **Denials raise as intended:** doctor → analytics `42501`; **receptionist → clinic-wide aggregates
  `42501`**; doctor and receptionist → revenue `42501`; unauthenticated → `28000`; unsupported
  grouping and unsupported scope → `22023`.
- **No cross-clinic leakage:** clinic B's summary contains none of clinic A's departments or staff.
- **`user_ai_permissions` integrity holds at the constraint, not only at the policy:** a cross-tenant
  row is rejected with `23503` even when written through the **service client**, which bypasses RLS
  entirely — so the defect is not one bad policy edit away from returning.
- **Ranked search** returns sensible scores, respects the `p_role` filter, and is clinic-scoped.

### Three real defects found and fixed during verification

1. `.lt()` was missing from the shared test query-builder mock (`tests/unit/helpers/`), breaking any
   tool using a `gte`/`lt` half-open range. Added.
2. Three P4A tests grabbed `tools.get_patient_summary` for a non-doctor to assert `execute()`
   refuses. Non-mounting now makes that `undefined`. Rather than delete the assertions, the tests
   build the tool **directly**, so they still prove the second line of defense holds against a
   future registry mis-wiring — which is what they were actually for.
3. `p4b-chat-route.test.ts` lacked mocks for the entitlements read the route now performs.

---

## 7. Files

**New:** `supabase/migrations/20260720130000_p46a_staff_analytics.sql`; `lib/ai/permissions.ts`;
`lib/ai/untrusted-text.ts`; `lib/ai/tools/{registry,range,entity-filters}.ts`; the ten tool modules
under `lib/ai/tools/`; `actions/ai-permissions.ts`;
`tests/unit/ai/{p46a-staff-analytics-tools,p46a-review-fixes}.test.ts`;
`tests/unit/actions/p46a-ai-permissions-actions.test.ts`;
`tests/unit/integration/p46a-analytics-rpc-isolation.test.ts`.

**Modified:** `lib/ai/tools/index.ts` (registry-driven + the sanitization boundary),
`lib/ai/authorization.ts`, `lib/ai/errors.ts` (new `permission_not_granted` reason),
`lib/ai/prompts/staff.ts` (untrusted-data and suppression rules, ar/en),
`lib/ai/{staff,doctor}-agent.ts` (async, task class), `lib/ai/tools/context.ts` (`taskClass`),
`lib/ai/platform/{types,registry,execution}.ts` (new task class + intent routing),
`lib/server-page-permissions.ts` (parameter widened for memoization),
`app/api/agent/chat/route.ts`, `types/database.ts`, `messages/action-errors/{en,ar}.json`,
`docs/AI_AGENT_PLAN.md`, and five test files.

**Deliberately edited in place rather than superseded:** the P4.6A migration itself. It is unmerged
and has never run anywhere but a local database, so a follow-up "fix" migration would have left the
repository permanently describing a table shape and a guard signature that were never intended to
ship. Verified by `supabase db reset` from scratch.

---

## 8. Prompt injection: tenant text entering model context

The review flagged this as forward-looking rather than a P4.6A defect, since P4.6B is what makes the
surface reachable. It is closed **here** anyway, because P4.6A is what creates it: `list_appointments`
and `list_pending_followups` are the first tools to carry tenant-authored strings — patient names,
department names, follow-up outcomes — out of the database and into the model's conversation. Anyone
who can create a patient can write into the assistant's context. Deferring the defense to P4.12's
adversarial corpus would mean shipping the surface first and testing it later; P4.12 should be
testing a defense, not discovering its absence.

Three independent layers, in `lib/ai/untrusted-text.ts` and the mount boundary:

1. **Neutralization.** Tenant strings are stripped of C0/C1 controls, zero-width characters, and the
   bidirectional-override "Trojan Source" family; sequences imitating conversation protocol (`system:`,
   `</instructions>`, `<|…|>`, code fences) are replaced with visible `[redacted-…]` markers rather
   than deleted, so a transcript reader can see something was neutralized; newlines are flattened so
   one field cannot pose as several; and values are capped at 200 characters. Deliberately
   conservative: apostrophes, hyphens, parentheses, and Arabic script survive byte-identical, because
   mangling real names to defend against hypothetical ones makes the assistant wrong about real people.
2. **Framing.** Every tool result carries a `data_provenance` marker, and both the Arabic and English
   staff system prompts now state that tool output is clinic data and never an instruction.
3. **Authorization — unchanged and decisive.** Even a fully successful injection can only call tools
   the caller was already authorized to call, over the caller's own clinic, because every `execute()`
   re-asserts role, entitlement, permission, and RLS. Neutralization reduces the blast radius of a
   confused model; it is not what makes the system safe.

**Architectural decision:** this is applied **centrally**, by wrapping each built tool's `execute` in
`resolveToolMount`, rather than by convention inside each tool. A per-tool convention is one
forgotten call away from a hole; wrapping at the mount covers every tool P4.6B and later add, by
construction. The cost is that all tool results now carry the provenance key, which is why two P4A
integration assertions moved from `toEqual` to `toMatchObject`.

---

## 9. Review findings — disposition

Against `docs/reviews/P4.6A_REVIEW.md`. **All High, Medium, Low and actionable Info findings are
fixed.** Nothing is deferred.

### 9.1 High

| # | Fix |
|---|---|
| **H1** | Complementary suppression + non-exact co-published total in `ai_get_patient_stats`; per-cell `ai_suppress_small_cell` helper removed; `ai_get_appointment_stats`' no-suppression decision recorded explicitly (§3.3). |
| **H2** | Role sets split into `OPERATIONAL_ASSISTANT_ROLES` and `CLINIC_ANALYTICS_ASSISTANT_ROLES`; the three aggregate tools call `assertClinicAnalyticsToolAccess`; `ai_assert_analytics_caller` takes a `p_scope` of `operational`/`clinic_analytics`/`financial` and the boolean predecessor is dropped. |
| **H3** | PK is `(clinic_id, user_id, permission_key)`; composite FK binds `(user_id, clinic_id)` to `profiles (id, clinic_id)`; the action's `onConflict` matches. The "mirrors `user_page_permissions` exactly" claim is corrected in §3.1. |

### 9.2 Medium

| # | Fix |
|---|---|
| **M1** | `compare_revenue_periods` routes both periods through `resolveToolPeriod` → the shared 400-day clamp. |
| **M2** | `taskClasses` is a real mount gate in `resolveToolMount`, driven by the turn's certified policy. |
| **M3** | Task class now follows **turn intent** (`isOperationalQueryIntent`, bilingual, deterministic), with the entitlement as a precondition rather than the trigger. `staff_administrative` is reachable again and keeps its 8-step / 1500-token budget for ordinary administrative turns. |
| **M4** | A uuid-shaped filter is verified against the caller's RLS-scoped visibility and falls to `not_found` otherwise. |
| **M5** | The three trigram indexes are dropped, with the reasoning — and why the `%` conjunct was rejected — recorded in the migration. `patients.search_name` (P4.6C) is explicitly *not* covered by that reasoning. |
| **M6** | `list_outstanding_invoices` filters `status = 'completed'` to match the revenue definition, accepts an optional clamped range, and declares `scope: "all_time"` when none is given. |

### 9.3 Low & Info

| # | Fix |
|---|---|
| **L1** | Ranges carry `clamped` + a `clamp_note`; the incomplete-`custom` case is announced too. |
| **L2** | `get_clinic_summary` audits `multiple`; `run_clinic_report` audits a per-report `auditTable`. |
| **L3** | `revoke all … from public` added to the three `search_*_ranked` functions; the suppression helper is gone. |
| **L4** | **Assessed, no change.** `resolveDateRange` produces day-granular bounds ending at `23:59:59.999`, with the next period starting at `00:00:00.000`; the previous-period predicate is already exclusive (`< p_start`). There is no instant that falls in two periods, so converting to half-open would drop the final millisecond of every range to fix an ambiguity that does not exist in the data. |
| **L5** | `tests/unit/actions/p46a-ai-permissions-actions.test.ts` — 15 tests over every gate, the conflict target, and the failure path. |
| **L6** | `React.cache`-scoped memos for the page-visibility and grant reads, keyed on primitives. Per-turn re-checking is unchanged. |
| **L7** | The distribution is renamed `buckets_all_time` with an explicit `bucket_scope`, so the model cannot describe an all-time distribution as belonging to the requested range. |
| **L8** | The decision to retain patient phone numbers in `list_pending_followups` is now stated, with its justification, at the point of the decision. |
| **L9** | `docsSlug` removed from `AiToolDefinition`. |
| **I2** | Unchanged — correctly P4.6B's, and the distinct `permission_not_granted` reason code is already in place. |
| **I3** | `AI_AGENT_PLAN.md` §1055 amended with all three matrix deviations and their justifications. |

### 9.4 Not fixed, with justification

- **I1 — working-tree hygiene.** Genuine, and not addressed here: the branch still mixes P4.6A with
  P4.6C files, the runbook, the `lib/supabase/admin.ts` change, and the `messages/action-errors`
  reordering. Splitting it is a git operation on the user's branch, not a code change, and doing it
  unasked would rewrite work the user may have staged deliberately. **Recommended before the PR:**
  isolate the i18n reordering in particular, since it makes the five keys actually added far harder
  to review than they should be.
- **`user_page_permissions` carries the same unconstrained shape as H3.** Confirmed by inspection
  (`20260504193000_user_page_permissions.sql`): PK `(user_id, page_slug)`, `clinic_id` with no FK to
  the target user's clinic. The review anticipated this. It predates P4.6A, is outside this
  sub-phase's scope, and the same hardening would need a data audit first (existing rows must satisfy
  the composite FK before it can be added). Recorded here and in the migration comment so it is not
  lost.

---

## 10. Follow-ups for P4.6B

- Mount these tools in the assistant UI with entitlement/permission-gated affordances.
- Localized "not enabled" copy for a manager without the financial grant — the route now returns
  `permission_not_granted`, distinct from `feature_not_entitled`, precisely so the UI can tell
  "your plan lacks this" apart from "ask your admin to enable this".
- A settings surface for `actions/ai-permissions.ts` (the server actions exist; no UI was built).
- Operational-vs-financial result presentation and report deep links (`run_clinic_report` already
  returns a `link`).
- Presenting a suppressed distribution honestly: the payload now distinguishes
  `patients_total` (exact) from `patients_total_approx` (rounded), and the UI must not render the
  approximation as an exact figure.
- Confirm the composite index assumption in the review's §8 — `(clinic_id, scheduled_at)` on
  `appointments` and `(clinic_id, created_at)` on `patients` — before this goes on a hot path.
- Re-check `search_patients_ranked` (P4.6C) for the M5 access-path pattern on a table that grows.
