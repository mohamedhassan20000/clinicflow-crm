# P4.8B — Contextual Launcher Rollout

**Date:** 2026-07-22  
**Branch:** `feat/p48a-ai-actions`  
**Status:** Implemented; comprehensive-review fixes applied; P4.8 complete.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.8 execution split, sub-phase P4.8B.  
**Depends on:** Approved P4.8A launcher and page-context architecture.  
**Explicitly excluded:** P4.9 and every later phase.

---

## 1. Scope delivered

P4.8B completes the contextual Assistant rollout without changing the P4.8A protocol or creating a new data-access path.

| Area | Host | Context supplied |
|---|---|---|
| Revenue | `/revenue` header | Visible date range only; unsupported page filters are deliberately omitted |
| Reports | All six shipped report detail pages | Exact shared `ClinicReportId` and visible date range |
| Invoices | Appointment billing dialog | Generic invoice filter only; no patient name, appointment id, or invoice content |
| Staff | `/settings/staff` header | Area marker only |
| Departments | `/settings/departments` header | Area marker only |
| Doctor schedule | Doctor schedule tab in the staff profile Sheet | Recurring working-hours editor marker only; no doctor identity or fabricated date range |

The P4.8A `AssistantLauncher`, `AssistantLauncherEntry`, authenticated first-open hydration route, and strict `AssistantPageContext` union remain the single implementation. No page duplicates Assistant logic.

For nested client hosts, `AssistantLauncherScope` carries only a server-authorized `{ context, role }` value. Its default is `null`, so the invoice dialog and doctor-schedule tab render no launcher outside an authorized source page. Conversation history, capabilities, and chat dependencies remain deferred until the Sheet first opens.

## 2. Deny-by-default launcher matrix

The registry now contains all nine P4.8 areas. Every definition still requires the Assistant feature, active subscription, remaining usage, visible Assistant page, visible source page, an eligible role, and successful server lookups.

| Area | Eligible roles | Additional requirements | Source page |
|---|---|---|---|
| Patient | Doctor | Existing patient re-authorization | Patients |
| Appointments | Admin, receptionist, doctor | None beyond Assistant | Appointments |
| Dashboard | Admin, manager, receptionist, doctor | None beyond Assistant | Dashboard |
| Revenue | Admin, manager | `ai.financial_insights` entitlement and per-user financial permission | Revenue |
| Reports | Admin, manager, receptionist | `ai.staff_analytics` | Reports |
| Invoices | Admin | `ai.financial_insights` entitlement and financial permission | Appointments |
| Staff | Admin, manager | `ai.staff_analytics` | Settings |
| Departments | Admin, manager | `ai.staff_analytics` | Settings |
| Doctor schedule | Admin, manager | `ai.staff_analytics` | Settings |

The invoice role set intentionally matches the shipped billing-dialog host: receptionists may operate the non-AI billing workflow but can never receive financial AI tools, while managers do not have the Appointments source page. The underlying billing dialog remains unchanged and usable when the launcher is absent.

## 3. Context-aware suggestions

Suggested prompts now prefer the current page context, but only when the server-resolved capability union contains the supporting tool and, for reports, the exact current `ClinicReportId`:

- appointment prompts require appointment-list, statistics, or availability tools;
- revenue prompts require the matching financial summary, comparison, or outstanding-invoice tool and state that only clinic-wide values for the visible date range are supported;
- report prompts require `run_clinic_report` and membership in structured `allowedReportIds`, derived from the shared report policy, role, entitlement, and financial-grant resolution;
- invoice prompts require `list_outstanding_invoices` or the help tool;
- staff and department prompts require `get_clinic_summary` or the help tool;
- doctor-schedule exposes only schedule-management help because the recurring-hours host intentionally shares no doctor identity.

If capabilities are missing, revoked, not entitled, do not contain the supporting tool, or exclude the exact report, the specialized prompt is absent. When the general Reports launcher is available but the current report is not, the UI states that the current report cannot be analyzed. Suggestions are presentation only and never mount a tool or influence task classification.

English and Arabic titles, descriptions, and suggestion copy were added with matching interpolation variables. The shared Sheet remains direction-logical (`side="inline-end"`), and no physical-direction style was introduced.

## 4. Preserved trust boundaries

- **Untrusted browser context:** both the launcher-session route and chat route parse the same strict zod union. Invalid, unknown, over-specified, malformed-date, oversized-range, and invalid-UUID input is rejected or dropped at the appropriate boundary.
- **Independent re-authorization:** first-open hydration authenticates again and repeats registry, role, page visibility, subscription, entitlement, usage, and personal-permission checks. Sending a message separately repeats chat-route and tool authorization.
- **Tool mounting:** page context is omitted from tool-mount authorization inputs. Only an independently re-authorized patient id can become a clinical default; every P4.8B context remains non-patient advisory metadata.
- **Tenant and RLS:** no service-role path, schema, migration, RLS policy, RPC, or query surface was added. Existing authenticated clients, clinic-scoped RPCs, and per-tool checks remain authoritative.
- **PHI:** no patient name or entity label is transmitted by the new launchers. Invoice and doctor-schedule contexts deliberately exclude patient and doctor identity. Launcher telemetry remains identifier-free.
- **Billing, limits, rate limiting, and audit:** opening a launcher does not reserve or bill a turn. The hydration route has its own per-user-and-clinic limiter and 2 KiB pre-parse ceiling. The chat route independently retains its limiter, atomic execution reservation, provider accounting, cap enforcement, reconciliation, persistence, and audited tool execution.
- **Missing schema:** a cached, content-free readiness probe silently omits launchers when either Assistant persistence table is unavailable; it never eagerly loads history or capabilities.
- **Fail-soft UX:** any launcher lookup or session failure hides/degrades only the optional Assistant enhancement; revenue, reports, billing, staff, departments, and schedule workflows remain available under their existing authorization.

## 5. Test coverage

P4.8B adds or expands coverage for:

- exact nine-area registry completeness and every P4.8B role matrix denial;
- financial feature and personal-permission gates, staff-analytics gates, source-page visibility, usage, subscription, and fail-closed lookup behavior;
- valid P4.8B first-open hydration plus malformed-context rejection;
- all six report-detail hosts, revenue, invoice, staff, departments, and doctor-schedule entry points;
- server-entry presence/absence and nested-scope fail-closed rendering;
- localized Sheet titles/descriptions and accessible dialog descriptions for every context;
- capability-backed contextual prompt presence, the full role × report × financial-grant matrix, and unauthorized current-report messaging;
- date-only revenue context and recurring-hours-only doctor-schedule semantics;
- launcher-session allowed bursts, throttling, limiter-backend degradation, and oversized bodies that never reach hydration;
- missing-schema silent omission plus cached readiness behavior;
- asynchronous failure announcement and retry-focus behavior;
- an English top-level and Arabic/RTL nested-launcher browser flow with focus restoration and accessibility checks;
- Arabic/English key and interpolation parity;
- context exclusion from tool-mount inputs;
- live persistence isolation proving every P4.8B non-patient context produces a general conversation with `patient_id = null`.

## 6. Validation

Final validation on 2026-07-22:

| Check | Result |
|---|---|
| Focused P4.8/P4.5 wiring tests | Pass — 10 files, 148 tests |
| `pnpm test` | Pass — 192 files, 1,403 tests |
| `pnpm test:integration` | Pass — 23 files, 245 tests against local Supabase |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 existing repository warnings |
| `pnpm lint:i18n` | Pass — 302 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,786 base messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 418 files; 10 documented exceptions |
| `pnpm build` | Pass — Next.js 16.2.6; 66 pages generated |
| `git diff --check` | Pass |

The first integration invocation had no local Supabase variables and collected no tests. The successful rerun used CLI-derived local-stack variables in-process without printing or storing credentials. The production build reports only the repository's existing middleware-to-proxy deprecation notice.

## 7. Explicit exclusions

P4.9 was not started. No launcher-customization entitlement, schema, RLS policy, settings page, role matrix editor, or per-user placement override was added. There is no mutable AI tool, workflow engine, conversational entity memory, generic query surface, or patient-facing AI work in this phase.
