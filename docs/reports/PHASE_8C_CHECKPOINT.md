# ClinicFlow Phase 8C Checkpoint

Date: 2026-07-27
Scope: Phase 8C only — "My Assistant Performance" (a section within My Performance)
Status: Complete; awaiting product approval

## Executive summary

Phase 8C is complete. It delivers **My Assistant Performance**, a section within
a doctor's My Performance page that shows the operational activity of the
assistants assigned to **that doctor**, each assistant listed separately, exactly
as specified in `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` §8C.

The metrics are factual actor-level counts drawn from the Phase 8D
`activity_events` trail — appointments booked, confirmations, check-ins,
completions, cancellations, no-shows, reschedules, replacements, total status
changes, follow-ups recorded, follow-up updates, and total actions. There is **no
composite or subjective score**. Attribution is scoped in the database: a doctor
sees only assistants assigned to them, and for each assistant only the activity
performed on the doctor's **own** entities — so an assistant who also assists
another doctor never leaks that other doctor's activity into this report.

The surface inherits the My Performance gate (doctor page-role + Reports-page
visible + report visible, default OFF, opt-in per doctor). It renders only when
the doctor has at least one assigned assistant.

No other sub-phase was touched. No Git operations were performed.

## What was implemented

### Database — `20260727170000_p8c_my_assistant_performance_rpc.sql`

- **`get_my_assistant_performance(p_start timestamptz, p_end timestamptz)`** —
  `SECURITY DEFINER`, `search_path = public, pg_temp`, `owner to postgres`.
  Returns `jsonb` `{ "assistants": [ … ] }`, one entry per assistant assigned to
  the calling doctor.
- **Doctor-only.** Every role except `doctor` is hard-denied with errcode
  `42501`, mirroring My Performance (8B). An assistant must never see another
  assistant's performance through this surface; admins/managers use the
  clinic-wide staff reports.
- **Why SECURITY DEFINER.** `assistant_doctor_assignments` is not readable by
  doctors under RLS (assistant-self / admin / manager only), and assistant
  profile names must be resolved. The RPC re-derives the caller from `auth.uid()`
  and constrains **every** read to `clinic_id = auth_clinic_id()`,
  `a.doctor_id = auth.uid()`, and (for events) `e.doctor_id = auth.uid()`, so it
  can widen nothing.
- **Scope / multi-assignment isolation.** For each assigned assistant, counts are
  aggregated from `activity_events` where `actor_id = <assistant>`,
  `clinic_id = <caller clinic>`, `doctor_id = auth.uid()` (the event's
  denormalized owning doctor), and `occurred_at` within range. The
  `doctor_id = auth.uid()` predicate is the isolation guarantee: activity the
  assistant performed for a *different* doctor carries that doctor's id and is
  excluded.
- **Assistant selection.** Only active, non-deleted `assistant`-role profiles
  assigned to the caller. Assistants with no in-window activity still appear with
  zero counts (LEFT JOIN), so every assigned assistant is shown; assistants
  assigned only to a *different* doctor never appear.
- **Factual counts only.** `totalActions`, `appointmentsBooked`, `confirmations`,
  `checkIns`, `completions`, `cancellations`, `noShows`, `reschedules`,
  `replacements`, `statusChanges` (the set of lifecycle status transitions),
  `followUpsRecorded`, `followUpUpdates`. No composite score; no invoice KPIs
  (there is no invoice activity trail yet, so none are fabricated).
- **No financial data.** The RPC reads no payment columns and no
  settlement/deposit tables — it is operational only.
- Execute is revoked from `public` and granted only to `authenticated,
  service_role`.

### Types

- Hand-added the `get_my_assistant_performance` function signature to
  `types/database.ts` per the minimal hand-addition policy (no new
  tables/columns; no wholesale local regeneration).
- `types/reports.ts` — `MyAssistantPerformanceRow` and
  `MyAssistantPerformanceReportResponse`.

### Data and UI

- `lib/reports/data.ts` — `EMPTY_MY_ASSISTANT_PERFORMANCE`,
  `normalizeMyAssistantPerformance`, and `getMyAssistantPerformanceData(range)`
  (no doctor filter — the RPC already scopes to the caller).
- `components/reports/my-assistant-performance-report.tsx` — a section (via
  `ReportSectionShell`) rendering each assistant separately: a heading with the
  assistant's name and total-action count, plus a `MetricGrid` of the factual
  counts. A defensive empty state renders if the list is empty.
- `app/(protected)/reports/my-performance/page.tsx` — fetches the assistant
  performance alongside the doctor's own performance and renders the section
  **only** when `assistants.length > 0`, so doctors with no assigned assistants
  see no empty panel. The results column now stacks both sections.
- `components/reports/print-all-button.tsx` — added the
  `my-assistant-performance` print section id.
- `app/globals.css` — added `my-assistant-performance` **and** the
  previously-omitted `my-performance` to the section-print whitelist, so both My
  Performance sections print independently.

### English/Arabic copy

- `reports.myAssistantPerformanceSummary`,
  `reports.operationalActivityOfYourAssistants`,
  `reports.noAssistantsAssignedToYou`, `reports.totalActionsCount` (pluralized),
  and the metric labels `appointmentsBooked`, `confirmations`, `checkIns`,
  `completions`, `reschedules`, `statusChanges`, `followUpsRecorded`,
  `followUpUpdates` (reusing existing `cancellations`, `noShows2`, `replaced2`).

## Product decisions

1. **Doctor-only surface and RPC.** Mirrors 8B; assistants and admins/managers
   are excluded from this personal, assistant-scoped view.
2. **A section within My Performance, not a new catalog report.** It inherits the
   `my_performance` visibility gate (default OFF, opt-in per doctor) and needs no
   separate toggle. It shows only when My Performance is enabled for the doctor
   **and** the doctor has ≥1 assigned assistant.
3. **Factual counts only, no composite score.** Plan-listed metrics with no
   reliable actor-level source (average response/completion time, invoice
   actions) are intentionally omitted rather than approximated.
4. **Multi-assignment isolation enforced in the database**, not the UI, via the
   `doctor_id = auth.uid()` event predicate.

## Validation results

| Validation | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| Production build | Passed; 69 static pages, `/reports/my-performance` route present |
| ESLint | Passed; 0 errors, 24 pre-existing warnings (none in new files) |
| `pnpm lint:rtl` | Passed; 448 files, 10 exceptions |
| `pnpm lint:i18n` | Passed; 317 files, 14 exceptions |
| `pnpm i18n:missing` | Passed; 2,975 base leaf messages |
| `pnpm i18n:unused` | Passed; no unused messages |
| Database lint | No new findings; the same four pre-existing warning sites remain (`get_my_assistant_performance` adds none) |
| Clean local migration replay | Passed from an empty local database through `20260727170000` |
| `git diff --check` | Passed |

## Test results

| Test run | Result |
| --- | --- |
| Complete non-integration unit suite | 228 files; 1,655 tests passed |
| Complete live integration catalog | 32 files; 340 tests passed |
| New Phase 8C static migration contract | 7 tests passed |
| New Phase 8C live RLS suite | 9 tests passed |

The live Phase 8C suite proves: a doctor sees exactly the assistants assigned to
them and none that are not; the shared assistant's counts for the calling doctor
include only that doctor's own-entity, in-window activity (1 booked + 2 confirmed
+ 1 rescheduled + 1 follow-up = 5 actions, `statusChanges` = 2), excluding both
the three A2-scoped confirmations and an out-of-window completion; the same
shared assistant shows the other doctor a different, A2-scoped view (3
confirmations); a second assigned assistant shows only their own scoped activity;
clinic B's assistant activity never appears in a clinic A scope; and admin,
receptionist, assistant, and anonymous callers are denied (`42501` for
authenticated non-doctor roles).

## Files added

- `supabase/migrations/20260727170000_p8c_my_assistant_performance_rpc.sql`
- `components/reports/my-assistant-performance-report.tsx`
- `tests/unit/db/p8c-my-assistant-performance-migration.test.ts`
- `tests/unit/integration/p8c-my-assistant-performance-rls.test.ts`
- `docs/reports/PHASE_8C_CHECKPOINT.md`

## Files modified

- `types/database.ts` — added `get_my_assistant_performance` signature.
- `types/reports.ts` — added `MyAssistantPerformanceRow` +
  `MyAssistantPerformanceReportResponse`.
- `lib/reports/data.ts` — empty constant, normalizer, fetch helper.
- `app/(protected)/reports/my-performance/page.tsx` — fetch + conditionally
  render the assistant section.
- `components/reports/print-all-button.tsx` — `my-assistant-performance` print
  section id.
- `app/globals.css` — print whitelist for `my-performance` and
  `my-assistant-performance`.
- `messages/en.json`, `messages/ar.json` — My Assistant Performance copy + metric
  labels.
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` — marked 8C checkpointed.

## Known limitations

- Metrics are limited to the entities the Phase 8D trail covers (appointments and
  follow-ups). There is no invoice activity trail yet, so no invoice/financial
  actor KPIs are shown. Adding invoice coverage to 8D would let this section grow
  new counts with no scope changes.
- Follow-up *completion rate*, *overdue follow-ups*, and *average response time*
  from the plan are not shown as per-assistant KPIs: those are doctor-level
  properties of appointments/follow-ups rather than reliable actor-level facts,
  and 8C deliberately prefers factual counts over derived approximations.
- Counts begin from the 8D begin-from-now cutover; there is no synthetic backfill
  of pre-audit activity (documented in the Phase 8D checkpoint).
- Attribution reflects the actor recorded by the 8D trigger. Follow-up events
  denormalize the owning doctor best-effort (linked appointment's doctor, else
  the patient's assigned doctor); a follow-up with no derivable owning doctor is
  not attributed to any doctor's report (fails closed).
- The four pre-existing database-lint warning sites remain (unchanged by 8C).
- Local migration verified locally; production migration/deployment is out of
  this session's scope.

## Intentionally not done

- No new report catalog id / Customize toggle: 8C is a section within My
  Performance and inherits that report's gate by design.
- No Git commit, push, merge, rebase, reset, or branch operation was performed.
