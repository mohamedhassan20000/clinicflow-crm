# Roles / Reports / Assistant Extension — Final Comprehensive Review (Phases 1–8)

**Status:** ✅ APPROVED — production-ready (see the 2026-07-27 re-review section at the end). Original cycle: CHANGES REQUESTED (blocking defects found; all now resolved).
**Scope reviewed:** Phases 1–8 of the Roles / Reports / Assistant / Placement / Replacement extension
**Review date:** 2026-07-27 (original cycle); re-reviewed 2026-07-27 (post-remediation)
**Reviewer:** Claude Code — production-grade review against `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` and the Phase 1–7 + 8A/8B/8C/8D checkpoints
**Verdict (original):** **NOT APPROVED.** Two database-independent code defects make Settings → Customize and the Staff-with-assistant surface crash, and the extension's migrations are not applied to the database the running app targets. Verified against source, the local Supabase schema, and the live remote database — not by reading the reports alone.
**Verdict (re-review):** ✅ **APPROVED.** RRAE-R1/R2/R3/R3a all independently verified resolved; no new blocking/high issues; no regressions.

This file is the authoritative handoff for this review cycle. Re-reviews must read it first, verify each finding by its stable ID, mark resolved items completed, keep unresolved items open, add new findings under new IDs, and append a dated re-review section. Prior findings must never be deleted.

---

## 1. Review method

- Read the plan and all six checkpoint/final-report documents.
- Inspected the actual working-tree code (the entire extension is uncommitted on `main`): report/page-permission actions, the scoped admin-client wrapper, the launcher-customization loader, the report catalog, the new RPC migrations, the assistant-write RLS, and the 8D activity trail.
- Queried the **local** Supabase container directly (`docker exec … psql`): confirmed the `assistant` enum value, `user_report_permissions`, and `activity_events` all exist locally and every extension migration (through `20260727170000`) is applied.
- Reproduced both reported regressions against the **remote** Supabase project the dev server actually targets (`NEXT_PUBLIC_SUPABASE_URL`), using the repo's own `@supabase/supabase-js` and service-role key (read-only SELECTs the app already runs).

---

## 2. Root-cause analysis of the two reported regressions

### RRAE-R1 — BLOCKER — Settings → Customize crashes with the global "Something went wrong" — caused by the implementation, independent of the database

**Affected:** `actions/report-permissions.ts:103,227,293` (and transitively `app/(protected)/settings/customize/page.tsx:21-24`), `lib/supabase/admin.ts:1239-1298` (`CLINIC_SCOPED_TABLES` and sibling allow-lists).

**Root cause.** `createClinicScopedAdminClient(...)` wraps the service-role client in a Proxy whose `from()` handler calls `assertKnownTable(table)`, which **throws synchronously** for any table not present in one of its four reviewed allow-lists (`lib/supabase/admin.ts:1306-1319`). The table `user_report_permissions` (added in Phase 1, migration `20260727122000`) was **never added to any allow-list**. Every `actions/report-permissions.ts` function queries it through the scoped admin client:

- `listStaffReportPermissions()` (line 103) — invoked by the Customize page inside `Promise.all([...])` with no try/catch. The synchronous throw rejects the `Promise.all`, the Server Component throws, and the `(protected)/error.tsx` boundary renders "Something went wrong."
- `saveUserReportVisibilityChanges()` (line 227) and `resetUserReportVisibilityToRoleDefaults()` (line 293) — the same throw breaks saving and resetting report visibility.

**Why it is database-independent.** `assertKnownTable` throws *before any network/DB call*, purely from the table name. So this crash happens on the fully-migrated **local** DB exactly as on the remote DB. The missing table on the remote project (see RRAE-R3) is a red herring for this regression — even with the table present, the page crashes.

**Trigger condition (precise).** The throw is reached when `ids.length > 0` (`report-permissions.ts:100-115`), i.e. the clinic has at least one non-primary-admin staff member — effectively always.

**Verified empirically.** Confirmed `user_report_permissions` is absent from all four allow-list sets (`CLINIC_SCOPED_TABLES`, `READ_ONLY_CLINIC_SCOPED_TABLES`, `JOIN_SCOPED_TABLES`, `EXPLICIT_SCOPE_TABLES`). Confirmed `report-permissions.ts` obtains its client via `createClinicScopedAdminClient`. A raw-client reproduction against remote returns `PGRST205` gracefully; the scoped client turns the same call into an uncaught throw — matching the observed global error boundary.

**Blast radius.** The entire per-employee report-visibility feature (Phase 2/5 UI + the Phase 8 My Revenue / My Performance opt-in toggles) is non-functional, and it takes the whole Customize page down.

**Note on the reports.** The Phase 7 final report and checkpoints state Customize report configuration and "primary-admin customization" were tested live and passed. That is not consistent with the code: the scoped client throws before any DB interaction. The passing `report-catalog` unit tests never exercise `createClinicScopedAdminClient`, which is how this escaped.

---

### RRAE-R2 — BLOCKER (latent) — Staff settings page and assistant-edit prefill crash whenever an assistant exists — same allow-list root cause

**Affected:** `app/(protected)/settings/staff/page.tsx:68-73`, `actions/settings.ts:88-93` (`getAssistantSupervisingDoctorIds`), `lib/supabase/admin.ts` allow-lists.

**Root cause.** The table `assistant_doctor_assignments` (Phase 1, migration `20260727121000`) is **also absent** from every scoped-client allow-list, yet both call sites query it through `createClinicScopedAdminClient`:

- `staff/page.tsx:67-73` runs the query only when `staff.some(s => s.role === "assistant")`. So the Staff settings page throws the global error boundary **as soon as the clinic has ≥1 assistant**.
- `getAssistantSupervisingDoctorIds()` (`settings.ts:89`) throws every time an admin opens an assistant's edit form (supervising-doctor prefill).

**Why it did not surface on the running app.** The dev server targets the remote DB, where the `assistant` enum value does not exist, so no profile can have `role = 'assistant'`; the guard `staff.some(... "assistant")` is always false and the query is skipped. This defect therefore lies dormant on the current environment but fires the moment the migrations are applied and a single assistant is created — i.e. exactly when the feature is meant to work. The write path (`replace_assistant_doctor_assignments` via the RLS `createClient`, `settings.ts:70-79`) is fine, so an assistant can be *created*, after which the Staff page reload crashes.

**Verified empirically.** `assistant_doctor_assignments` confirmed absent from all four allow-list sets; both call sites confirmed to use the scoped client.

---

### RRAE-R3 — BLOCKER (deployment) — the extension's migrations are not applied to the database the app targets; this is the direct cause of the observed Assistant-placement error

**Affected:** deployment/runtime configuration; surfaced by `lib/ai/launcher-customization.ts:37` and `app/(protected)/settings/assistant/page.tsx:51-66`.

**Root cause.** `.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at the **remote** Supabase project (`ayze…​.supabase.co`), and the server/admin clients use that URL (`lib/supabase/server.ts:9`, `lib/supabase/admin.ts:14`). None of the Phase 1–8 migrations are applied there — every checkpoint explicitly scoped production migration out. `supabase migration list` shows the `20260727*` migrations with an empty Remote column; a live query confirms the remote DB has neither the `assistant` enum value nor `user_report_permissions`/`activity_events`.

**Mechanism for the observed message.** `getAssistantLauncherCustomization` filters profiles with `.in("role", ["admin","manager","receptionist","doctor","assistant"])` (`launcher-customization.ts:37`, added in this extension). Against the remote DB the literal `'assistant'` cannot be cast to `user_role`, so Postgres returns `22P02 invalid input value for enum user_role: "assistant"`. `staffResult.error` is set, the loader throws (`launcher-customization.ts:41-45`), the page's `try/catch` (`assistant/page.tsx:52-56`) swallows it, and it renders the inline `assistantCustomizationLoadError` = "Assistant placement settings could not be loaded." — an exact match.

**Verified empirically.** Reproduced `22P02 invalid input value for enum user_role: "assistant"` against the remote project for both `.in("role", […,'assistant'])` and `.eq("role",'assistant')`.

**Consequence beyond this page.** Because the target DB is un-migrated, the *entire* extension is currently inert in the running environment: no assistant role, no per-user report permissions, no replaced status, no activity trail, and none of the My Revenue / My Performance / My Assistant Performance reports. Production readiness cannot be asserted until the migration chain is applied to the deployment target and the app is re-verified there.

**Minor robustness (RRAE-R3a, non-blocking).** A single failed profiles query hard-fails the whole Assistant-placement page. Once the migrations are applied this is moot, but the loader is brittle: it treats a transient/absent-schema error the same as a fatal one.

---

## 3. What was reviewed and found sound

These were inspected in source (not trusted from the reports) and are well-constructed:

- **8D activity trail** (`20260727140000`): append-only is genuinely enforced — grants revoked from `anon/authenticated`, `SELECT` re-granted, and **no** INSERT/UPDATE/DELETE policy exists, so authenticated writes are denied outright. The single `record_activity_event()` `SECURITY DEFINER` trigger stamps `actor_id = auth.uid()` (null ⇒ `is_system`); clients cannot forge actor/role/clinic/timestamp. Read policy mirrors entity visibility per role, assistants constrained to `auth_supervised_doctor_ids()`. `actions/activity.ts` reads through the **RLS** client (`createClient`) and fails closed to an empty timeline — correct, and notably *not* affected by the RRAE-R1/R2 allow-list bug (though `activity_events` is likewise unlisted, no scoped-admin path touches it).
- **8A `get_my_revenue_summary`**: `SECURITY INVOKER`, hard role guard to doctor/assistant (`42501`), reads only RLS-scoped `appointments` payment columns, never `outstanding_settlements`. Scope is correct by construction.
- **8B `get_my_performance_summary`** and **8C `get_my_assistant_performance`**: doctor-only guards; 8C is `SECURITY DEFINER` but re-derives the caller from `auth.uid()` and constrains every read to `v_clinic_id` + `doctor_id = auth.uid()`, giving correct multi-assignment isolation via the denormalized `activity_events.doctor_id` predicate. Widens nothing.
- **Assistant operational writes** (`20260727127000`): anti-spoof `WITH CHECK` on `doctor_id = any(auth_supervised_doctor_ids())` for both INSERT and UPDATE (USING + WITH CHECK), so a forged/stale/out-of-scope `doctor_id` is rejected at RLS regardless of the caller.
- **Report catalog / visibility model**: `REPORT_CATALOG` is internally consistent with `CLINIC_REPORT_IDS`; report *pages* read visibility through the RLS client in `lib/server-report-permissions.ts`, which correctly **fails closed** on lookup error — so report pages degrade safely even where RRAE-R1 breaks the admin configuration surface.
- **Separation principle** (visibility ≠ authorization) holds in the code paths reviewed: financial/administrative reports keep their `pageRoles`, and the scoped RPCs enforce data scope independently of any toggle.

---

## 4. Severity summary

| ID | Severity | Area | Environment-independent? | Effect |
|----|----------|------|--------------------------|--------|
| RRAE-R1 | Blocker | `report-permissions.ts` + admin-client allow-list | Yes | Customize page global crash; report-visibility save/reset broken everywhere |
| RRAE-R2 | Blocker (latent) | `settings/staff` + `getAssistantSupervisingDoctorIds` + allow-list | Yes (fires once an assistant exists) | Staff page crash with any assistant; assistant-edit prefill crash |
| RRAE-R3 | Blocker (deployment) | migrations not applied to target DB | — | Entire extension inert on the running app; Assistant-placement inline error |
| RRAE-R3a | Minor | `launcher-customization.ts` | — | Non-graceful single-query failure |

---

## 5. Recommended remediation (for the implementing session — not applied here)

1. **RRAE-R1 / RRAE-R2:** add `user_report_permissions`, `assistant_doctor_assignments`, and (for consistency/future use) `activity_events` to the appropriate reviewed allow-list in `lib/supabase/admin.ts` — `user_report_permissions` and `assistant_doctor_assignments` carry their own `clinic_id` and belong in `CLINIC_SCOPED_TABLES` (so automatic `clinic_id` scoping applies). Then verify Settings → Customize and Settings → Staff (with an assistant present) load, save, and reset against a migrated DB.
2. **RRAE-R3:** apply the full migration chain (`20260727120000` → `20260727170000`) to the deployment-target Supabase project and re-run the acceptance checks against that environment, not only local.
3. **Testing gap:** add a test that exercises `createClinicScopedAdminClient` against every table the extension queries through it (an allow-list contract test would have caught R1/R2 at build time), and a browser/e2e path that opens Customize and the Staff page with an assistant present.
4. **RRAE-R3a (optional):** let the Assistant-placement loader distinguish a missing-enum/schema error from a fatal one, or render the inline notice without treating it as unrecoverable.

Per the review instructions, no code was modified and no Git operation was performed. Because blocking issues were found, the review stops here with **CHANGES REQUESTED**; an APPROVED / production-ready verdict is not warranted until RRAE-R1, RRAE-R2, and RRAE-R3 are resolved and re-verified.

---

## Re-review — 2026-07-27 (independent, post-remediation)

**Reviewer:** Claude Code (Opus 4.8) — independent end-to-end re-review of Phases 1–8.
**Verdict:** ✅ **APPROVED — production-ready.**
**Method:** Did not trust the prior review or the fixes report. Re-inspected the working-tree source (`lib/supabase/admin.ts`, `lib/ai/launcher-customization.ts`, `actions/report-permissions.ts`, `actions/settings.ts`, `app/(protected)/settings/staff/page.tsx`, `lib/server-report-permissions.ts`, the scoped-admin contract test), ran typecheck and the relevant unit suites, queried the **live linked remote** (`ayzetxywrqouqpurbjuv`, the project `NEXT_PUBLIC_SUPABASE_URL` targets) for enum values, tables, RPC security modes, grants, and RLS policy expressions, and confirmed the remote migration ledger.

### Finding-by-finding disposition

| ID | Status | Independent evidence |
|----|--------|----------------------|
| **RRAE-R1** | ✅ **RESOLVED** | `user_report_permissions` is now in `CLINIC_SCOPED_TABLES` (writable, auto `clinic_id` scoping) — [admin.ts:1272](../../lib/supabase/admin.ts). `assertKnownTable` no longer throws for it, so `report-permissions.ts` list/save/reset and the Customize `Promise.all` execute. Confirmed live: the primary-admin-only `ALL` policy + self-read policy exist on the remote. |
| **RRAE-R2** | ✅ **RESOLVED** | `assistant_doctor_assignments` is now in `READ_ONLY_CLINIC_SCOPED_TABLES` — reads pass, and insert/upsert/update/delete throw `read-only access` at call time (verified by contract test + wrapper code at [admin.ts:1417-1428](../../lib/supabase/admin.ts)). Staff page and `getAssistantSupervisingDoctorIds()` read paths work; writes remain RPC-only. Live: only a SELECT policy exists on the table (no authenticated write policy). |
| **RRAE-R3** | ✅ **RESOLVED** | `supabase migration list --linked` shows all 19 extension migrations (`20260727120000`→`20260727170000`) present in the **Remote** column. Live query confirms the `assistant` + `replaced` enum values, the `assistant_doctor_assignments` / `user_report_permissions` / `activity_events` tables, and all 6 key functions exist on the target project. The original `22P02` cause is gone. |
| **RRAE-R3a** | ✅ **RESOLVED (as scoped)** | The redundant `.in("role", […,'assistant'])` filter is removed from the placement loader's profiles query ([launcher-customization.ts:31-40](../../lib/ai/launcher-customization.ts)); role integrity now rests on the DB enum, eliminating the rollout-order failure. The loader still throws on a genuine infra error across its three queries — this matches the review's "Minor/optional" classification and is an accepted, non-blocking residual, not a new defect. |

### Regression check (previously-sound items re-verified live, not trusted)

- **Append-only activity trail:** `activity_events` has exactly one policy (SELECT); `authenticated` holds only `SELECT`, `anon` none — no INSERT/UPDATE/DELETE path. `record_activity_event()` is `SECURITY DEFINER` and stamps `auth.uid()`. Read policy correctly scopes doctor→self/patient scope and assistant→`auth_supervised_doctor_ids()`.
- **Phase 8 RPCs:** `get_my_revenue_summary` / `get_my_performance_summary` = `SECURITY INVOKER` with `42501` role guards; `get_my_assistant_performance` = `SECURITY DEFINER` re-deriving `auth.uid()` with a role guard; `replace_appointment` = `SECURITY DEFINER` with role guard. All confirmed on the live schema.
- **Assistant anti-spoof writes:** `appointments` and `follow_ups` INSERT/UPDATE `WITH CHECK` constrain the assistant branch to `doctor_id = ANY(auth_supervised_doctor_ids())` (directly and via appointment/patient existence for follow-ups) — verified live.
- **Primary-admin customization boundary:** `user_report_permissions` `ALL` policy requires `is_primary_clinic_admin(clinic, auth.uid())` and `NOT is_primary_clinic_admin(clinic, user_id)` — the primary admin cannot be targeted. Report discovery fails closed (`lib/server-report-permissions.ts` returns `[]`/`lookup_failed` on infra error).
- **Scoped-admin allow-list contract test** (`tests/unit/lib/admin-client-scope.test.ts`) is genuinely source-driven: it walks `actions/`, `app/`, `lib/` via the TypeScript AST, collects every literal table queried through a `createClinicScopedAdminClient` receiver, and asserts none throws — so a future unclassified table fails at unit time, not runtime.

### Validation run this session

- `pnpm typecheck` — clean.
- `tests/unit/lib/admin-client-scope.test.ts` + `tests/unit/ai/p49b-launcher-customization-data.test.ts` — 19 passed.
- `report-catalog`, `p8d-activity-events`, `p46b-assistant-capabilities`, `p48a-launchers`, `p49b-assistant-launcher-customizer`, `assistant-placement-defaults` — 80 passed.
- Live remote schema, RPC, grant, and RLS-policy inspection — all consistent with the plan.

### Conclusion

All previously reported findings (RRAE-R1, RRAE-R2, RRAE-R3, RRAE-R3a) are fully resolved. No new blocking or high-severity issues were found, and no regressions were introduced by the remediation (which was narrowly scoped to `lib/supabase/admin.ts` and `lib/ai/launcher-customization.ts` plus tests/docs). The entire Roles / Reports / Assistant Extension implementation (Phases 1–8) is **production-ready**.

No code was modified and no Git operation was performed during this re-review.
