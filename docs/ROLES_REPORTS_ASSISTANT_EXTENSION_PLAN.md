# Roles, Reports, Assistant Role, Placement/Customize & Replaced-Appointment Extension — Implementation Plan

> Scope: an incremental extension on top of the shipped ClinicFlow platform. This
> document is the authoritative plan for **this** body of work. It does **not**
> modify or restructure the master roadmap in [`AI_AGENT_PLAN.md`](./AI_AGENT_PLAN.md).
>
> Delivery model: **phased, with a human checkpoint after each phase.** Migrations
> were developed and replayed against **local Supabase**, then applied to the
> linked target during final-review remediation; `types/database.ts` receives only minimal,
> phase-specific hand-additions (never a wholesale local re-generation — see
> "Type generation policy" below). No commits/pushes are made by the agent.

## Status legend

| Marker | Meaning |
| --- | --- |
| ✅ DONE | Implemented, checkpointed, and approved in this session |
| 🟡 CHECKPOINT | Implemented and validated; awaiting human approval |
| 🟡 FINAL REVIEW REMEDIATED | Review findings fixed and validated; awaiting independent re-review |
| ⏳ REMAINING | Planned but not yet implemented |

Phase summary:

| Phase | Title | Status |
| --- | --- | --- |
| 1 | Database foundation & metadata-driven page catalog | ✅ DONE |
| 2 | Report catalog & per-user report visibility | ✅ DONE |
| 3 | Scope-aware report RPCs | ✅ DONE |
| 4 | Assistant role across the full application surface (+ Manager Appointments/Follow-ups authorization) | ✅ DONE |
| 5 | Assistant Placement & Customize controls (toggles + Reset to Product Defaults) | ✅ DONE |
| 6 | Replaced appointment workflow, chains & KPIs | ✅ DONE |
| 7 | Tests, documentation & final implementation report | 🟡 FINAL REVIEW REMEDIATED |
| 8 | Doctor-focused reporting & unified operational activity tracking | 🟡 FINAL REVIEW REMEDIATED |

## Final-review remediation

The blocking findings in
[`docs/reviews/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW.md`](./reviews/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW.md)
were remediated on 2026-07-27 and are awaiting independent re-review:

- every Phase 1–8 clinic-owned table is classified by the scoped admin client;
- Customize report-permission reads/writes and Assistant supervision reads no
  longer fail the synchronous allow-list guard;
- the Assistant-placement staff query no longer sends the new enum literal as a
  filter, so it remains compatible during schema rollout;
- the full Phase 1–8 migration chain is applied to the linked Supabase project
  used by `.env.local`, and clean local replay succeeds;
- source-usage and Phase-table contract tests prevent future allow-list
  omissions.

The complete remediation and validation record is
[`docs/reports/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW_FIXES.md`](./reports/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW_FIXES.md).

## Cross-cutting principles (apply to every phase)

1. **Visibility is never authorization.** Page visibility, report visibility,
   Assistant-launcher placement, showing an AI tool, and showing a report never
   grant data access. Every read/write is still gated by the existing
   authorization model (RLS, `requireRole`/`requireMutationRole`, RPC guards, AI
   tool asserts).
2. **A report is accessible only when BOTH hold:** (a) the caller is authorized
   for the underlying data, AND (b) that report is enabled (visible) for that
   specific employee. Enforced on the Reports page, report nav, direct URLs,
   APIs, RPCs, downloads/exports, dashboard shortcuts, AI reporting tools, AI
   navigation, and AI capability discovery.
3. **Metadata-driven catalogs are the single source of truth.** Pages
   ([`lib/page-permissions.ts`](../lib/page-permissions.ts) `PAGE_CATALOG`) and
   reports ([`lib/reports/catalog.ts`](../lib/reports/catalog.ts)
   `REPORT_CATALOG`) each register once and participate everywhere. Adding a page
   or report is a single registration; no scattered per-role matrices, no
   role-specific UI.
4. **Assistant scope = UNION of assigned doctors' own scopes only.** Never
   department-wide, never clinic-wide. Assignments drive **data scope only** and
   never touch visibility defaults or stored customizations.
5. **Separation of responsibilities:** Assignments → data scope. Customize →
   per-user visibility. Product defaults → role defaults. These never bleed into
   each other.
6. **Existing clinics preserved.** Only safe defaults are introduced for new
   functionality; stored customizations are retained.

## Type generation policy

`types/database.ts` is generated from the **remote** project. A full **local**
re-generation drifts ~1184 lines (CLI-format + unrelated local/remote schema
divergence) and would inject unrelated breakage. Policy: after a local migration,
hand-add **only** the new objects (enum values, new table `Row/Insert/Update/
Relationships`, new function signatures) into the committed file, matching its
existing format. Migrations that only change policies or RPC bodies (no new
tables/columns/signatures) require **no** type change.

---

# Phase 1 — Database foundation & metadata-driven page catalog ✅ DONE

**Goal.** Introduce the `assistant` role and the many-to-many assistant↔doctor
data-scope foundation; add the per-user report-visibility table; consolidate page
definitions into a single future-proof catalog; extend role unions app-wide.

**Migrations (applied locally).**
- `20260727120000_assistant_role_enum.sql` — `alter type user_role add value 'assistant'` (own migration so it commits before use).
- `20260727121000_assistant_doctor_assignments.sql` — `assistant_doctor_assignments(clinic_id, assistant_id, doctor_id, created_at, created_by)`, PK `(assistant_id, doctor_id)`; `auth_supervised_doctor_ids()` SECURITY DEFINER helper returning the union of active assigned doctors in the caller's clinic (empty array ⇒ fails closed); RLS (assistant reads own assignments; admin/manager manage).
- `20260727122000_user_report_permissions.sql` — `user_report_permissions(user_id, report_id, is_visible, clinic_id, …)` mirroring `user_page_permissions`; RLS (self-read; admin-manage).

**Types.** Hand-added `assistant` enum value, the two tables, and
`auth_supervised_doctor_ids` to `types/database.ts`.

**Code.**
- [`lib/page-permissions.ts`](../lib/page-permissions.ts) — merged `PAGE_DEFINITIONS` + `ROLE_PAGE_SLUGS` into one `PAGE_CATALOG`, each page declaring `defaultVisibilityByRole: Record<PermissionUserRole, boolean>`; `ROLE_PAGE_SLUGS`/`getRolePages` are derived views. Applied defaults: Manager +Appointments +Follow-ups; Doctor & Assistant +Reports; Assistant seeded identical to Doctor.
- Extended role unions: `UserRole` ([`lib/rbac.ts`](../lib/rbac.ts)), `PermissionUserRole`, staff validation `z.enum` ([`lib/validations/settings.ts`](../lib/validations/settings.ts) — plus optional `supervising_doctor_ids`), AI role-set constants ([`lib/ai/authorization.ts`](../lib/ai/authorization.ts), [`lib/ai/launcher-customization-types.ts`](../lib/ai/launcher-customization-types.ts)), task classes ([`lib/ai/tools/index.ts`](../lib/ai/tools/index.ts)), staff prompt ([`lib/ai/prompts/staff.ts`](../lib/ai/prompts/staff.ts)), calendar props, staff badges.
- Translations: `roleAssistant` (en/ar).

**Security/authorization.** Enum + tables + helper only; the helper fails closed.
No data-access widening yet.

**Dependencies.** None (foundation). Everything downstream depends on this.

**Acceptance criteria.** ✅ Enum applied locally; ✅ `pnpm typecheck` clean;
✅ full unit suite green; ✅ existing page/nav tests still hold (doctor/manager
inbox exclusions preserved).

---

# Phase 2 — Report catalog & per-user report visibility ✅ DONE

**Goal.** Make reports fully metadata-driven and per-employee configurable,
adding a visibility layer **without changing authorization**.

**Code.**
- [`lib/reports/catalog.ts`](../lib/reports/catalog.ts) (new) — single discovery source; each entry: `{ id, href, pageRoles, financial, administrative, defaultVisibilityByRole, titleKey, descriptionKey }`. Report ids shared with `lib/ai/clinic-reports.ts` (`ClinicReportId`).
- [`lib/server-report-permissions.ts`](../lib/server-report-permissions.ts) (new) — `getVisibleReportIds`, `getReportVisibilityState` (role defaults ⊕ `user_report_permissions`; fail-closed; request-memoized).
- [`actions/report-permissions.ts`](../actions/report-permissions.ts) (new) — primary-admin-gated list/save/update/reset; reports whether each employee's Reports page is enabled so the UI can hide the section.
- [`lib/reports/access.ts`](../lib/reports/access.ts) (new) — `requireReportsIndexAccess`, `requireReportAccess(reportId)` enforcing **page role guard + Reports page visible + report visible**; hidden report ⇒ `notFound()` (404) on direct URL.
- [`components/reports/reports-index.tsx`](../components/reports/reports-index.tsx) — catalog-driven cards, filtered to reports the user may open **and** see.
- Report subpages — guard via `requireReportAccess`.
- AI: `run_clinic_report.execute()` denies hidden reports; capability discovery `allowedReportIds` filtered by visibility ([`lib/ai/capabilities.ts`](../lib/ai/capabilities.ts)).

**Product defaults (`defaultVisibilityByRole`).** admin/manager: all on.
receptionist: cancellations/no-shows/revenue/follow-ups on, performance off.
doctor & assistant: cancellations/no-shows/follow-ups on, revenue + performance
off (each role owns its defaults; assistant seeded == doctor, independent
thereafter).

**Security/authorization.** Authorization unchanged this phase (report `pageRoles`
still admin/manager/receptionist etc.). Only the visibility overlay was added.

**Dependencies.** Phase 1 (`user_report_permissions`, role unions, `ClinicReportId`).

**Acceptance criteria.** ✅ typecheck clean; ✅ i18n parity; ✅ full unit suite
green incl. new `report-catalog.test.ts`; ✅ hidden report ⇒ 404; ✅ AI discovery
honors visibility.

---

# Phase 3 — Scope-aware report RPCs ✅ DONE

**Goal.** Replace the blanket "doctors are not authorized for reports" behavior
with role-aware + user-aware + **scoped** report output; give assistants their
union data scope.

**Migrations (applied locally).**
- `20260727123000_assistant_scoped_rls.sql` — `assistant` SELECT branch added to `patients`, `appointments`, `follow_ups` role-scoped policies. Scope = rows owned by assigned doctors (`= any(auth_supervised_doctor_ids())`); never department/clinic-wide; assistants read-only. Existing role branches reproduced verbatim.
- `20260727124000_scope_aware_report_rpcs.sql` — recreated `get_cancellation_report` / `get_no_show_report` without the `doctor` hard-deny; since they are SECURITY INVOKER over RLS-scoped `appointments`, RLS now scopes doctor→self, assistant→assigned doctors. `get_followups_dashboard` already permitted doctors (denies managers), so no RPC change.

**Types.** None (policies/RPC bodies only).

**Code.**
- [`lib/reports/catalog.ts`](../lib/reports/catalog.ts) — `SCOPED_OPERATIONAL_PAGE_ROLES` adds doctor+assistant to `pageRoles` for cancellations, no-shows, follow-ups. Revenue keeps admin/manager/receptionist; performance keeps admin/manager.
- [`lib/reports/access.ts`](../lib/reports/access.ts) — `reportScopeLockedToSelf(role)`.
- Cancellation/no-show subpages hide the cross-doctor filter and skip the clinic doctor list for doctor/assistant (RLS gives their scoped aggregate).

**Security/authorization.** Financial (revenue) & administrative (doctor/
receptionist performance) reports remain admin/manager only; finance tables are
admin/receptionist/manager-only, so doctors/assistants can never reach clinic-wide
money/staff-ranking data. Enabling a report never bypasses the data scope.

**Dependencies.** Phases 1–2.

**Acceptance criteria.** ✅ typecheck clean; ✅ `pnpm test` 218 files/1586;
✅ `pnpm test:integration` 27 files/282 (no isolation regression); ✅ new
`assistant-scope-rls.test.ts` (live DB, 9/9): single-doctor scope, union across
two doctors, cross-clinic isolation, **re-scope on unassign**, doctor self-scoped
report.

---

# Phase 4 — Assistant role across the full application surface ✅ DONE

**Goal.** Make `assistant` a first-class staff role everywhere, wire the
doctor-assignment management UI, extend route/action guards, and **grant Managers
full functional authorization for Appointments and Follow-ups** so the new
Manager pages are genuinely usable (no "Not Authorized"/empty pages).

**Migrations.**
- **Manager operational authorization.** Extend RLS + RPC guards so managers may operate Appointments and Follow-ups like admins/receptionists, within clinic isolation:
  - `appointments` write policies (`appointments_write_staff`, `appointments_update_staff`, delete): add `manager` where admin/receptionist are permitted.
  - `follow_ups` policies (`follow_ups_select_role_scoped` already admits managers for SELECT; add manager to insert/update/delete).
  - `get_followups_dashboard` RPC: remove the `if v_role = 'manager' then raise` deny so the Follow-ups data loads for managers.
  - Any appointment status-transition RPCs (`start_appointment_session`, undo, etc.) that enumerate roles: add `manager`.
- **Assistant assignment integrity.** Optional trigger/constraint ensuring `assistant_doctor_assignments.doctor_id` references a same-clinic active doctor and `assistant_id` references a same-clinic assistant. Safe handling of doctor removal is already covered by `on delete cascade`.

**Types.** Only if new RPC signatures/columns are introduced (not expected).

**RPC/RLS changes.** As above (manager operational authorization; assistant
already scoped in Phase 3). Re-run the integration isolation suite to prove no
cross-tenant regression.

**UI changes.**
- Staff management ([`components/settings/staff-form.tsx`](../components/settings/staff-form.tsx), staff list, [`actions/settings.ts`](../actions/settings.ts)): add the **Assistant** role option; when role = assistant, show a **supervising-doctors multiselect** (assigned to ≥1 clinic doctor). Persist assignments via a new action writing `assistant_doctor_assignments`. Assignment changes touch **only** the assignments table — never visibility rows.
- Invitations flow: allow inviting an assistant with doctor assignments; role selection includes assistant.
- Staff profile sheet & badges: assistant label/color (done in Phase 1) + show assigned doctors.
- Reassignment/removal: editing assignments replaces the set atomically; removing a doctor (or deactivating them) drops them from the union via cascade and the helper's active-doctor filter — no stale scope.

**Route guards / actions.** Include `assistant` wherever a doctor is allowed and
the surface is doctor-scoped: dashboard, patients, appointments, follow-ups,
reports index. Assistant dashboards/queries already RLS-scoped (Phase 3); verify
aggregates reflect the assigned-doctor union only.

**Report changes.** None beyond Phase 3 (assistant already scoped). Manager
follow-ups report benefits from the RPC deny removal.

**AI integration.** `assistant` is in `STAFF_ASSISTANT_ROLES`/`CLINICAL_ASSISTANT_ROLES`
(Phase 1); assistant uses clinical/help tools scoped by RLS. Verify assistant AI
answers only within the union scope. No clinic-wide operational/financial AI tools
mount for assistants.

**Tests.**
- Assistant role end-to-end: create assistant + assignments; assistant sees union; unassigned assistant sees nothing.
- Manager Appointments/Follow-ups: manager can list, create, update status, and manage follow-ups; clinic isolation holds.
- Direct route denial: a role without a page still 404s/redirects; visibility never grants access.
- AI capability resolution for assistant (clinical scope only).
- Existing-clinic compatibility.

**Documentation.** Update this plan's Phase 4 status; note manager-authorization
migrations.

**Security/authorization.** Manager authorization is **widened deliberately and
minimally** to Appointments + Follow-ups operational actions, incl. the
appointment-lifecycle billing RPCs needed to complete/undo an appointment
end-to-end (NOT `settle_patient_outstanding`), within clinic isolation —
explicitly approved.

**Assistant operational writes (correction, approved):** assistants are
operational actors, not read-only. For records of their actively assigned doctors
(union) they may INSERT/UPDATE appointments and follow-ups and perform the
non-financial operational status actions (confirm, check-in, cancel, no-show,
reschedule, record/complete follow-ups). Enforced at RLS
(`20260727127000_assistant_operational_writes.sql`, `WITH CHECK` on `doctor_id ∈
auth_supervised_doctor_ids()` — anti-spoof), scoped server-action guards, the
`/appointments/new` guard (doctor dropdown scoped to assigned doctors), and the
`appointment-actions` component (`canOperate` vs financial `canComplete`).
Assistants get NO delete, NO financial completion/settlement, NO clinic-wide or
out-of-scope access, and cannot forge a doctor id.

**Dependencies.** Phases 1–3.

**Acceptance criteria.** Assistant is selectable, assignable (1..n doctors), and
correctly scoped everywhere; Manager Appointments + Follow-ups pages are fully
functional (no unauthorized/empty state); no nav entry opens a dead page;
integration isolation suite still green; typecheck + unit + integration green.

---

# Phase 5 — Assistant Placement & Customize controls ✅ DONE

**Goal.** Real toggles for every supported role×area in Assistant Placement, a
Reset-to-Product-Defaults on both Assistant Placement and Customize, and the
per-user report configuration UI in Customize.

**Migrations.** None expected (settings already have tables:
`assistant_launcher_settings`, `assistant_launcher_user_overrides`,
`user_page_permissions`, `user_report_permissions`).

**UI changes.**
- **Assistant Placement** ([`components/settings/assistant-launcher-customizer.tsx`](../components/settings/assistant-launcher-customizer.tsx), [`lib/ai/launcher-customization.ts`](../lib/ai/launcher-customization.ts), [`actions/assistant-launcher-settings.ts`](../actions/assistant-launcher-settings.ts), [`lib/ai/launchers.ts`](../lib/ai/launchers.ts)): render a `Switch` for **every supported role×area** (including `assistant` and newly supported combinations). Replace the `—` dash with a real toggle where the area *can* support the role; keep a disabled placeholder **only** where placement is fundamentally unsupported. Per-role `defaultEnabled` added to the launcher registry so **new combinations default OFF** while current enabled combinations stay enabled.
- **Reset to Product Defaults (Assistant Placement):** confirmation dialog, loading state, success/error feedback, explanatory text stating exactly what is restored. Restores the **official ClinicFlow defaults** (delete overrides + role settings back to code-owned defaults) — **not** "enable everything".
- **Customize** ([`app/(protected)/settings/customize/page.tsx`](../app/(protected)/settings/customize/page.tsx), [`components/settings/page-visibility-customizer.tsx`](../components/settings/page-visibility-customizer.tsx)): add the **per-user report configuration** section driven by `actions/report-permissions.ts` + the report catalog — for every employee whose Reports page is enabled, toggle each report category. Hide/disable the report section when Reports is disabled for that user.
- **Reset to Product Defaults (Customize):** confirmation dialog, loading, success/error, duplicate-submission prevention. Restores default page visibility + default report visibility + default per-role visibility for the selected employee.

**Report/AI changes.** None beyond wiring the catalog into the Customize UI.

**Security/authorization.** All placement/visibility toggles are presentation
only; nothing here grants data access. Reset restores official defaults only.

**Tests.** Reset flows restore product defaults (not "all on"); new role×area
combos default OFF; current enabled combos remain enabled; report-config section
hidden when Reports disabled; duplicate-submission guarded.

**Dependencies.** Phases 1–4 (assistant role present; report catalog/actions).

**Acceptance criteria.** No dashes for supported combinations; both Reset buttons
work with confirm/loading/feedback and restore official defaults; Customize report
config functional and correctly gated.

---

# Phase 6 — Replaced appointment workflow, chains & KPIs ✅ DONE

**Goal.** A first-class `replaced` appointment status delivered through a
dedicated Replace workflow that creates a linked replacement, preserves the
original and full replacement chains, and treats replacement as its own reschedule
event in analytics.

**Implemented migrations.**
- `20260727130000_appointment_replaced_status_enum.sql` adds the enum value in its
  own transaction.
- `20260727131000_appointment_replace_workflow.sql` adds the three self-referencing
  chain columns, indexes, lifecycle guards, the initial transactional Replace RPC,
  and the RLS-invoker chain reader.
- `20260727132000_replaced_status_report_kpis.sql` and
  `20260727133000_replaced_status_ai_stats.sql` add dedicated replacement counts
  and rates while removing replaced originals from cancellation/no-show and AI
  active-appointment denominators.
- `20260727134000_replacement_workflow_hardening.sql` adds one-to-one link
  constraints, a deferred chain-integrity trigger, serialized replacement, full
  server-side slot validation, and a linked recursive chain reader.
- `20260727135000_replaced_status_remaining_analytics.sql` removes replaced
  originals from doctor/receptionist performance and dashboard/AI denominators.

**Types and business rules.** The enum value, chain columns, and RPC signatures
are hand-added to `types/database.ts`. Replace is future-only, accepts only
pending/confirmed originals, creates a confirmed active row, preserves the
original, and permits arbitrarily long A → B → C chains. The database validates
canonical duration, clinic/patient/root continuity, reciprocal links, active
same-clinic doctors, department compatibility, and the existing 15-minute buffer.

**Authorization/RLS.** Existing appointment SELECT policies scope chain reads.
The replacement write uses a narrowly scoped `SECURITY DEFINER` RPC that derives
identity and clinic from `auth.uid()` and grants no general appointment write
access. Admins, receptionists, and managers may choose an eligible clinic doctor;
doctors may replace only their own appointment and cannot transfer it; assistants
may replace only between doctors in their current supervised-doctor union.

**Analytics/KPI.** `replaced` is a dedicated reschedule event and is excluded from
cancelled, completed, no-show, lost, booking-share, and revenue-generating
statistics. Cancellation/no-show denominators exclude replaced originals.
Reports and AI expose **Replaced Appointments** and **Replacement Rate** separately.

**UI and notifications.** Appointment actions open a localized Replace dialog
with an authorization-filtered doctor selector. Badge/filter/calendar/list
surfaces treat `replaced` as terminal, and appointment detail renders the actual
ordered chain with dates, doctors, and the active/viewed nodes. Reusing the
existing status-based reminder pipeline makes the replaced original ineligible
and the new confirmed appointment eligible; creation notification remains
best-effort after the successful transaction.

**AI and audit.** Appointment list/report/page-context tools understand
`replaced`; appointment-stat output includes replacement KPIs without polluting
the other status rates. Existing appointment INSERT/UPDATE audit triggers record
both sides of every successful replacement.

**Validation/tests.** Static migration contracts and live local-Supabase tests
cover future/open-state rules, doctor/assistant scope, immediate revocation,
atomic linking, A → B → C ordering, original-slot reuse, concurrency, audit rows,
and KPI separation. The Phase 6 checkpoint records the complete validation run.

**Dependencies.** Independent of the role/report work but sequenced after it;
shares the audit patterns Phase 8 will generalize.

**Acceptance criteria.** Replace produces a linked replacement, preserves the
original + chain, is future-only, integrates across scheduling/calendar/lists/
filters/reports/dashboards/notifications/AI/audit/i18n, and never distorts
existing cancel/complete/no-show/revenue statistics.

---

# Phase 7 — Tests, documentation & final implementation report 🟡 FINAL REVIEW REMEDIATED

**Goal.** Consolidated automated coverage + the comprehensive final report.

**Completed.** Phase 7 performed the final regression, security, authorization,
RLS, RPC, Server Action, UI, AI, launcher, report-catalog, migration, and
documentation review across Phases 1–6. It added narrowly scoped production
hardening without adding product features:

- report discovery now fails closed on permission-query errors;
- page/report customization is primary-admin-only and cannot target the primary
  administrator;
- assistant supervision replacement is transactional, requires a non-empty
  valid doctor set, and is the only authenticated assignment-write path;
- assistant conversations and clinical tools are patient/supervision scoped,
  while clinic-wide analytics remain explicitly denied;
- assistant patient, appointment, dashboard, and report surfaces omit financial
  and destructive controls that the role cannot execute;
- manager follow-up AI/report access matches the already-approved Phase 2
  database/UI authorization;
- last-login tracking works through its guarded RPC without allowing direct
  protected-profile writes;
- department-less doctor dashboards no longer issue an invalid empty-UUID query;
- browser regression tests were aligned with the current accessible marketing
  and operator-report controls.

**Tests (focused).** Doctor reports; manager pages (now authorized); assistant
role + relationship; per-user report visibility; customize/placement defaults;
reset buttons; authorization boundaries; direct route denial; AI capability
resolution; report authorization; replaced-status; existing-clinic compatibility.

**Runs.** `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, DB tests, i18n
parity.

**Documentation.** Update this plan's statuses; write the **final implementation
report** (Markdown) covering Phases 1–7 with: executive summary, phase-by-phase
outcomes, product decisions, migrations, RPC/RLS changes, authorization changes,
report/page catalog changes, AI changes, UI changes, files added/modified,
validation/test results, known limitations, deferred Phase 8 scope, and the
recommended Phase 8 starting point. Follow the review-file workflow for any
per-subphase review docs.

**Acceptance criteria.** ✅ Complete unit and live integration coverage green;
✅ clean local migration replay; ✅ typecheck/build/ESLint/i18n/RTL/diff gates;
✅ browser smoke/accessibility coverage; ✅ final report and Phase 7 checkpoint
present; ✅ Phase 8 explicitly marked fully planned, intentionally deferred, and
reserved for a separate session.

---

# Phase 8 — Doctor-focused reporting & unified operational activity tracking 🟡 FINAL REVIEW REMEDIATED

> **Implemented through 8D, 8A, 8B, and 8C.** The final-review deployment and
> scoped-admin defects have been remediated; independent re-review is pending.

Phase 8 depends on Phases 1–7 (report catalog, per-user visibility, assistant
role + many-to-many assignments, replaced-appointment chain, and the audit
patterns established in Phase 6).

## 8A. "My Revenue" (doctor-oriented, separate from admin Revenue) 🟡 CHECKPOINT

> **Implemented and validated; awaiting approval.** See
> [`docs/reports/PHASE_8A_CHECKPOINT.md`](./reports/PHASE_8A_CHECKPOINT.md).

**Delivered.**
- Migration `20260727150000_p8a_my_revenue_rpc.sql`: `get_my_revenue_summary(p_start, p_end)`,
  a `SECURITY INVOKER` RPC that reads **only** the RLS-scoped `appointments`
  payment columns (completed, non-deleted, paid-in-range) and hard-denies every
  role except `doctor`/`assistant` (errcode `42501`). It never reads the
  clinic-wide `outstanding_settlements` table, so `grossTotal` is
  appointment-collected revenue only and the scope is, by construction, the
  caller's own (doctor) / supervised-doctor union (assistant). No `p_doctor_id`
  param — RLS already yields the union.
- Types: hand-added `get_my_revenue_summary` to `types/database.ts`.
- Catalog: new `my_revenue` `ClinicReportId` in `CLINIC_REPORT_IDS`,
  `CLINIC_REPORT_LABELS`, `CLINIC_REPORTS` (`roles: ["doctor","assistant"]`,
  `financial: true`, `acceptsDoctor: false`) and `REPORT_CATALOG`
  (`pageRoles: ["doctor","assistant"]`, `financial: true`, **default OFF for
  every role** — opt-in via Customize / Report Permissions).
- Data + UI: `MyRevenueSummaryReportResponse` type, `getMyRevenueSummaryData`,
  `components/reports/my-revenue-summary-report.tsx` (settlement rows omitted),
  and the `app/(protected)/reports/my-revenue` page guarded by
  `requireReportAccess("my_revenue")` (page-role + Reports-page-visible +
  report-visible; hidden ⇒ 404).
- Enforcement everywhere: report discovery + index card (catalog-driven),
  Settings → Customize per-user toggle (catalog-driven), `run_clinic_report`
  AI tool (role + per-user visibility + financial gate re-checked in
  `execute()`), and AI navigation target `reports_my_revenue`.
- Tests: static migration contract, catalog registration, and a live RLS
  integration suite (doctor self-scope, assistant union + re-scope on unassign,
  admin/receptionist/anon denied, cross-clinic isolation).

**Original design specification (as planned).** A dedicated report distinct from
the existing administrative Revenue report.

- **Data scope.** Doctor sees only their own authorized revenue; Assistant sees
  only their assigned doctor(s)' revenue (union); never clinic-wide revenue for
  doctors/assistants.
- **Catalog.** New `ClinicReportId` (e.g. `my_revenue`) registered in
  `REPORT_CATALOG` + `CLINIC_REPORTS`. `pageRoles` = `["doctor", "assistant"]`
  (NOT admin/manager — those use the existing admin Revenue report). `financial:
  true`.
- **Default visibility.** `defaultVisibilityByRole`: doctor **OFF**, assistant
  **OFF**, others OFF/N-A. Primary Admin enables per employee via Customize /
  Report Permissions. (Explicitly documented default: **OFF for everyone**;
  opt-in only.)
- **Data source.** A doctor-scoped revenue RPC (SECURITY INVOKER over
  RLS-scoped appointment payment columns the doctor may read, or SECURITY DEFINER
  that re-derives the caller's `auth_supervised_doctor_ids()`/self and filters).
  It must **not** read clinic-wide settlement/deposit tables that doctors cannot
  see.
- **Enforcement everywhere.** Direct URLs, AI tools, report discovery, exports,
  dashboard shortcuts — all enforce both the data scope and per-user visibility.

## 8B. "My Performance" (doctor's own operational performance) 🟡 CHECKPOINT

> **Implemented and validated; awaiting approval.** See
> [`docs/reports/PHASE_8B_CHECKPOINT.md`](./reports/PHASE_8B_CHECKPOINT.md).

**Delivered.**
- Migration `20260727160000_p8b_my_performance_rpc.sql`:
  `get_my_performance_summary(p_start, p_end)`, a `SECURITY INVOKER` RPC that
  reads the RLS-scoped `appointments`/`follow_ups` and hard-denies every role
  except `doctor` (errcode `42501`). **Scope = the caller's OWN sessions**: an
  explicit `doctor_id = auth.uid()` predicate (not just RLS) so the report
  counts only appointments the caller is the treating doctor for — never the
  broader doctor RLS scope (department / assigned patients booked under another
  doctor). No `p_doctor_id` parameter.
- KPIs (authoritative system data only, no subjective ratings): appointment
  count, completed, cancellation count & rate, no-show count & rate, **replaced
  count & rate kept distinct from cancellations/no-shows (Phase 6)**, unique
  patients, active days, average patients per active day, follow-ups due,
  follow-ups completed, follow-up completion rate, overdue follow-ups, and a
  completed-appointment trend vs the immediately preceding equal-length period
  (null when no prior baseline, so the UI shows a neutral placeholder).
- Types: hand-added `get_my_performance_summary` to `types/database.ts`;
  `MyPerformanceSummaryReportResponse` in `types/reports.ts`.
- Catalog: new `my_performance` `ClinicReportId` in `CLINIC_REPORT_IDS`,
  `CLINIC_REPORT_LABELS`, `CLINIC_REPORTS` (`roles: ["doctor"]`,
  `financial: false`, `acceptsDoctor: false`) and `REPORT_CATALOG`
  (`pageRoles: ["doctor"]`, `financial: false`, `administrative: false`,
  **default OFF for every role** — opt-in via Customize / Report Permissions).
- Data + UI: `EMPTY_MY_PERFORMANCE`, `normalizeMyPerformanceSummary`,
  `getMyPerformanceSummaryData(range)`,
  `components/reports/my-performance-summary-report.tsx`, and the
  `app/(protected)/reports/my-performance` page guarded by
  `requireReportAccess("my_performance")` (page-role + Reports-page-visible +
  report-visible; hidden ⇒ 404). No cross-doctor filter (scope-locked to self).
- Enforcement everywhere: report discovery + index card (catalog-driven),
  Settings → Customize per-user toggle (catalog-driven), AI navigation target
  `reports_my_performance` (`roles: ["doctor"]`, honors report visibility), and
  a defensive `run_clinic_report` definition (doctors do not mount that tool, and
  its role gate denies any other caller).
- Tests: static migration contract, catalog registration, and a live RLS
  integration suite (own-sessions-only scope incl. exclusion of an appointment
  the caller's RLS admits but does not treat, follow-up completion/overdue,
  average patients/day, null trend baseline, cross-clinic isolation, and
  admin/receptionist/assistant/anon denial).

**Product decisions (8B).**
1. **Doctor-only.** `pageRoles`/RPC role guard are strictly `doctor`. Admins and
   managers keep the clinic-wide `doctor_performance` report; assistants have no
   personal performance surface (their operational activity belongs to 8C).
2. **Own sessions, not RLS scope.** The RPC filters on `doctor_id = auth.uid()`
   so "my performance" is the caller's treated appointments only — a stronger
   guarantee than My Revenue's plain RLS scope, chosen because a doctor's RLS
   also admits appointments of their patients booked under other doctors.
3. **Default OFF for everyone.** Opt-in; the primary admin enables it per doctor.
4. **Factual KPIs only.** No composite score, no subjective/manual ratings.

**Original design specification (as planned).** A dedicated report distinct from
the administrative Doctor Performance report.

- **Scope.** Current doctor only.
- **Catalog.** New `ClinicReportId` (e.g. `my_performance`), `pageRoles` includes
  `doctor` (and `assistant` if the product wants assistants to view their doctors'
  performance — to be decided; default doctor-only). `administrative: false` (it is
  self-scoped, not clinic-wide rankings). Default visibility **OFF**, admin-toggle.
- **KPIs (only where backed by authoritative system data):** appointment count;
  completed; cancellation count & rate; no-show count & rate; follow-up count &
  completion rate; overdue follow-ups; average patients/day; trend vs previous
  equivalent period; other factual operational metrics. **No subjective or
  manually entered ratings.**
- **Data source.** A doctor-scoped performance RPC computed from appointments +
  follow-ups the doctor is authorized to read, plus (from Phase 6) replacement
  KPIs kept distinct from cancellations.

## 8C. "My Assistant Performance" (section within My Performance) 🟡 CHECKPOINT

> **Implemented and validated in this session; awaiting approval.** See
> [`docs/reports/PHASE_8C_CHECKPOINT.md`](./reports/PHASE_8C_CHECKPOINT.md).

**Delivered.**
- Migration `20260727170000_p8c_my_assistant_performance_rpc.sql`:
  `get_my_assistant_performance(p_start, p_end)`, a `SECURITY DEFINER` RPC that
  hard-denies every role except `doctor` (errcode `42501`) and returns one row
  per assistant assigned to the **calling** doctor. It re-derives the caller from
  `auth.uid()` and constrains every read to the caller's own clinic and own
  `doctor_id`, so it widens nothing. SECURITY DEFINER is required because
  `assistant_doctor_assignments` is not readable by doctors under RLS.
- **Metrics = factual actor-level counts** from the Phase 8D `activity_events`
  trail: appointments booked, confirmations, check-ins, completions,
  cancellations, no-shows, reschedules, replacements, total status changes,
  follow-ups recorded, follow-up updates, and total actions. **No composite or
  subjective score.** Only actions the 8D trigger actually records (appointment
  lifecycle + follow-ups) are counted; no invoice KPIs are fabricated (there is
  no invoice activity trail yet).
- **Multi-assignment isolation** is a database property: each counted event must
  have `doctor_id = auth.uid()` (its denormalized owning doctor), so an assistant
  who also assists another doctor contributes to THIS report **only** for
  activity on the calling doctor's own entities. The same shared assistant shows
  a different, correctly-scoped view to each doctor they assist.
- Assistants with no in-window activity still appear (zero counts), so a doctor
  sees every assigned assistant. Assistants assigned to a *different* doctor never
  appear.
- Types: hand-added `get_my_assistant_performance` to `types/database.ts`;
  `MyAssistantPerformanceRow` + `MyAssistantPerformanceReportResponse` in
  `types/reports.ts`.
- Data + UI: `EMPTY_MY_ASSISTANT_PERFORMANCE`,
  `normalizeMyAssistantPerformance`, `getMyAssistantPerformanceData(range)`, and
  `components/reports/my-assistant-performance-report.tsx` — a **section within
  My Performance** rendering each assistant separately. The
  `app/(protected)/reports/my-performance` page fetches it alongside the doctor's
  own performance and renders the section only when the doctor has ≥1 assigned
  assistant. The section is a first-class print target
  (`my-assistant-performance`), and the previously-omitted `my-performance` print
  whitelist entry was added so both sections print.
- Tests: static migration contract and a live RLS integration suite (assigned-vs
  -unassigned assistant selection, multi-assignment isolation across two doctors,
  window filtering, cross-clinic isolation, and admin/receptionist/assistant/anon
  denial).

**Product decisions (8C).**
1. **Doctor-only surface, doctor-only RPC.** Mirrors My Performance (8B). An
   assistant must never see another assistant's performance, and admins/managers
   use the clinic-wide staff reports.
2. **A section within My Performance**, not a new catalog report id — it inherits
   the `my_performance` page gate (default OFF, opt-in per doctor) and needs no
   separate visibility toggle. It appears only when both My Performance is enabled
   for the doctor and the doctor has assigned assistants.
3. **Factual counts only, no composite score.** Every metric is a raw count of a
   recorded semantic action; the plan's optional metrics with no reliable
   actor-level source (average response time, invoice actions) are intentionally
   omitted rather than approximated.
4. **Activity trail is the source of attribution.** Present-state entity tables
   remain authoritative for totals; the 8D trail is authoritative for who did what.

**Original design specification (as planned).**

- A doctor may view the operational performance of **assistants assigned to that
  doctor**; multiple assistants shown separately.
- **Metrics** (only where reliable actor-level data exists): follow-ups
  completed; follow-up completion rate; overdue follow-ups; average response/
  completion time; appointment confirmations; appointment status changes;
  reschedules/replacements; invoice-related actions when authorized; task/activity
  completion.
- **Authorization.** A doctor sees performance only for assistants assigned to
  that doctor. An assistant must not see another assistant's performance (unless a
  future explicit rule permits). Many-to-many assignments must not leak activity
  belonging to unrelated doctors. **No vague composite score** unless a
  transparent, approved formula is defined — prefer factual KPIs.
- **Dependency.** Requires **8D** (actor-level activity data) to be meaningful.

## 8D. Unified Activity Timeline / Audit Trail (source of truth for accountability) 🟡 CHECKPOINT

> **Implemented and validated; awaiting approval.** See
> [`docs/reports/PHASE_8D_CHECKPOINT.md`](./reports/PHASE_8D_CHECKPOINT.md).

**Delivered.**
- Migration `20260727140000_p8d_activity_events.sql`: the append-only
  `activity_events` table (clinic, actor, actor role, is_system, semantic action,
  entity type/id, denormalized doctor/patient for scope, previous/new state,
  metadata jsonb, occurred_at); four timeline indexes for
  `(clinic, entity_type, entity_id, occurred_at)`, `(clinic, actor, occurred_at)`,
  `(clinic, doctor, occurred_at)`, and `(clinic, patient, occurred_at)`.
- Spoof-proof write boundary: a single `record_activity_event()` SECURITY DEFINER
  trigger on `appointments` and `follow_ups` derives the semantic action from the
  row transition and stamps `actor_id = auth.uid()` (null ⇒ `is_system`), never a
  client-supplied actor. Authenticated roles have no INSERT grant and no write
  policy.
- Immutability: append-only. No UPDATE/DELETE policies for authenticated roles;
  corrections are represented as new events.
- RLS reads mirror entity visibility: admins/managers/receptionists clinic-wide;
  doctors and assistants only for events whose owning doctor/patient is in their
  authorized scope (assistants via `auth_supervised_doctor_ids()`).
- System-generated actions get `actor_id = null`, `is_system = true`.
- Timeline UI: `components/activity/activity-timeline.tsx` embedded on the
  appointment detail dialog (entity-scoped) and the patient detail page
  (patient-scoped), reading through the RLS-scoped `getActivityTimeline` action
  with keyset pagination, actor attribution, action tone, and en/ar copy.
- Analytics feed: the scoped `activity_events` table + read action is the
  actor-level history source that 8B/8C will consume; entity tables remain
  authoritative for present state.
- Migration & backfill: begin-from-now cutover (trigger captures events going
  forward); no synthetic backfill of pre-existing rows (documented).
- Tests: static migration contract, live RLS/append-only/spoof/scope/system-actor
  integration, and unit catalog/i18n-parity coverage.

**Original design specification (as planned).** A durable, append-only activity
log powering accountability and actor-level KPIs.

- **Entities covered (at least):** appointments, follow-ups, invoices, plus any
  entity required by the approved KPIs.
- **Traceable actions (examples):** appointment created/edited/status changed/
  confirmed/checked-in/completed/cancelled/rescheduled/replaced; follow-up
  created/assigned/completed/closed/reopened; invoice created/edited/discount
  changed/payment-state changed/closed/cancelled/refunded — with previous & new
  values for meaningful changes.
- **Event shape (per event, where applicable):** clinic, actor user, actor role,
  action type, entity type, entity id, timestamp, previous state, new state,
  structured metadata (jsonb), authorization-safe context.
- **The plan must define, and the implementation must deliver:**
  - **Database design.** A partitioned/append-only `activity_events` table (or
    per-domain tables + a unified view); indexes for (clinic, entity_type,
    entity_id, occurred_at) and (clinic, actor_id, occurred_at).
  - **Event-writing boundary.** Prefer DB triggers and/or SECURITY DEFINER RPCs
    that stamp `actor_id = auth.uid()` server-side. **Never** accept a
    client-supplied actor — protect against actor spoofing.
  - **RLS & read authorization.** Read scoped by clinic + role: admins/managers
    clinic-wide (within existing limits); doctors/assistants only events for
    entities in their authorized scope; assistants never see other assistants'
    events beyond approved rules.
  - **Immutability & retention.** Append-only (no UPDATE/DELETE for
    authenticated roles); corrections/reversals represented as **new** events
    (never rewrite history); documented retention expectations.
  - **System-generated actions.** A sentinel/system actor attribution for
    automated events (reminders, cron), clearly distinguishable from human actors.
  - **Timeline UI.** Locations (appointment detail, patient timeline, follow-up
    detail, invoice detail), pagination, filtering (by actor, action, entity,
    date).
  - **Analytics feed.** How events feed My Performance and My Assistant
    Performance; how AI tools and future analytics read events safely (scoped,
    read-only, no PHI leakage).
  - **Migration & backfill.** Strategy for existing records lacking historical
    events (e.g. seed a synthetic "pre-audit baseline" or begin-from-now with a
    documented cutover); backward compatibility so current-state entity tables
    remain authoritative for present state and business totals while the audit
    trail becomes authoritative for **actor-level** history.

**Phase 8 acceptance criteria.** My Revenue + My Performance registered in the
catalog, default OFF, admin-toggle, strictly scoped; My Assistant Performance
respects assignment boundaries and multi-assignment isolation; the activity trail
is append-only, spoof-proof, RLS-scoped, and demonstrably powers the KPIs; all new
surfaces enforce both visibility and data authorization; comprehensive tests.

**Recommended Phase 8 starting point.** Begin with **8D** (the activity-trail
schema, write-boundary triggers/RPCs, and RLS) because 8B/8C depend on
actor-level data; then 8A (My Revenue, which needs only existing appointment
payment data); then 8B; then 8C. **8D, 8A, 8B and 8C are now all implemented and
checkpointed; Phase 8 is functionally complete and awaiting approval.**

---

## Dependency graph (summary)

```
P1 (enum, assignments, report-perms table, page catalog)
 ├─> P2 (report catalog + visibility)  ──> P3 (scope-aware RPCs + assistant RLS)
 │                                            └─> P4 (assistant surface + manager auth)
 │                                                  └─> P5 (placement + customize + resets)
 └─> P6 (replaced workflow) ── independent, shares audit patterns ──┐
                                                                     v
P7 (tests + final report) ── depends on P4–P6                    P8 (delivered):
                                                                 8D audit ─> 8A/8B ─> 8C
```
