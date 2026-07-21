# P4.8A — Context Contract, Launcher Core & First Entry Points

**Date:** 2026-07-22  
**Branch:** `feat/p48a-ai-actions`  
**Status:** Implemented; independent-review fixes applied.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.8 execution split, sub-phase P4.8A.  
**Depends on:** P4.6B (staff assistant analytics surface), P4.7A (navigation registry).  
**Explicitly excluded:** P4.8B.

---

## 1. Scope delivered

P4.8A adds one safe page-context contract, one reusable launcher, a deny-by-default server resolver, and the first three roadmap entry points.

| Deliverable | Where |
|---|---|
| Strict `AssistantPageContext` discriminated union and prompt projection | `lib/ai/page-context.ts` |
| Declarative launcher registry and server-side visibility resolver | `lib/ai/launchers.ts` |
| Shared assistant-surface gate with optional feature requirements | `lib/ai/surface.ts` |
| Lightweight server-entry adapter with no session serialization | `components/assistant/assistant-launcher-entry.tsx` |
| Reusable localized Sheet launcher | `components/assistant/assistant-launcher.tsx` |
| Authenticated Sheet-open session hydration boundary | `app/api/agent/launcher-session/route.ts` |
| Context-aware assistant transport without UI-label leakage | `components/assistant/assistant-chat.tsx` |
| Independent server validation in the chat route | `app/api/agent/chat/route.ts` |
| Advisory context added to staff-agent instructions only | `lib/ai/staff-agent.ts` |
| Migrated patient-profile launcher | `app/(protected)/patients/[id]/page.tsx` |
| Appointments launcher with validated visible filters | `app/(protected)/appointments/page.tsx` |
| Dashboard launcher for every permitted dashboard role | `app/(protected)/dashboard/page.tsx`, `components/dashboard/*-dashboard.tsx` |
| English and Arabic launcher copy | `messages/en.json`, `messages/ar.json` |

The old patient-specific launcher component was removed after its behavior was migrated to the shared component. No schema or RLS migration was required.

## 2. Context contract and trust boundary

`AssistantPageContext` is a strict zod discriminated union covering the complete roadmap vocabulary: patient, appointments, dashboard, revenue, reports, invoices, staff, departments, and doctor schedule. P4.8A registers and launches only patient, appointments, and dashboard. The remaining variants are validation-ready so the route has one stable protocol, but are deliberately absent from the launcher registry until P4.8B.

The route treats page context as untrusted input:

- unknown context types and malformed values are dropped without breaking the chat request;
- object variants are strict, UUIDs and calendar dates are validated, and date ranges are bounded;
- display labels such as patient names stay in UI props and are never sent as authorization-bearing payload;
- context is reduced to a compact Arabic or English advisory instruction and appended to the system prompt only;
- context cannot choose the role, task class, model route, tool mount, clinic, patient scope, or billing path.

Patient context retains the pre-P4.8 security model. A doctor-supplied patient UUID is passed through the existing `ensureDoctorConversation` authorization path; only its server-validated conversation patient ID becomes the effective prompt/tool default. Cross-tenant or otherwise unauthorized patient IDs are denied. Appointments and dashboard context is ephemeral and is not persisted as patient scope.

## 3. Launcher registry and visibility resolution

The P4.8A registry contains exactly three areas:

| Area | Roles | Additional page/feature checks |
|---|---|---|
| Patient | Doctor | Assistant visible, patient page visible, active patient, existing doctor conversation authorization |
| Appointments | Admin, receptionist, doctor | Assistant visible, appointments page visible, assistant entitlement/usage/persistence gates |
| Dashboard | Admin, manager, receptionist, doctor | Assistant visible, dashboard visible, assistant entitlement/usage/persistence gates |

Resolution is split at the Sheet boundary. `resolveAssistantLauncher` is the lightweight page-time gate: it checks both the Assistant page and source page, every required feature entitlement, subscription state, usage availability, role eligibility, any declared per-user permission, and a short-lived cached persistence-readiness signal. The readiness probe selects at most one id from each RLS-protected persistence table and never loads conversation history. The resolver returns only the strict context and an available access result; no conversation/history hydration, capability resolution, or chat-session serialization occurs during page rendering. Missing persistence silently omits the optional launcher.

On first Sheet open, the client dynamically imports the chat component and calls the authenticated, no-store `POST /api/agent/launcher-session` boundary. That boundary runs `authorizeStaffAssistant`, applies a dedicated 30-per-minute per-user-and-clinic limiter before parsing, enforces a 2 KiB streaming request-body ceiling, independently parses the P4.8 context, repeats the complete launcher gate, re-authorizes patient context through the clinic/doctor/RLS-backed patient lookup before reading history, verifies persistence, loads at most 40 messages, and resolves non-patient capabilities from the existing tool-mount registry. Throttled requests return `429` with `Retry-After`; oversized requests return `413`; neither reaches session resolution. A failed or revoked gate returns no session and the Sheet degrades to localized retryable unavailable UI.

Future P4.8B context types still validate at the chat protocol boundary but cannot produce or hydrate a launcher in P4.8A.

Resolution is fail-soft for page rendering: an operational lookup failure hides the launcher and reports sanitized telemetry without patient/entity identifiers. This does not make the API permissive; direct requests still pass the independent chat-route and tool-level authorization chain.

## 4. Preserved platform guarantees

- **Authorization and tenant isolation:** launcher visibility grants no data access. The deferred session route authenticates independently, repeats launcher authorization, and re-authorizes patient context before exposing owner/clinic-scoped history. Existing chat-route identity/role checks, registry mounts, per-tool authorization, Supabase RLS, and clinic-scoped RPCs remain authoritative.
- **Audit logging:** page context does not execute a data operation. Every actual tool call continues through the existing audited tool implementations; no audit path was bypassed or weakened.
- **Billing:** task classification, execution reservation, cap enforcement, usage-ledger finalization, and provider accounting are unchanged and run independently of page context.
- **Security:** strict parsing, minimized prompts, no UI display labels in request payloads, no arbitrary query surface, no new database object, and no PHI/entity identifiers in launcher-resolution telemetry.
- **Capabilities:** dashboard and appointments launchers resolve the existing authorized tool-mount union only after the Sheet opens. Patient context retains the existing clinical surface and independently re-authorized patient conversation binding.

## 5. Entry-point behavior

- **Patient profile:** the existing doctor-only launcher now uses the generic component and resolver. Its visible patient name is presentation-only; the UUID is re-authorized server-side.
- **Appointments:** the launcher carries only the server-validated visible range, status, and optional selected doctor filter. It does not expose or grant access to appointment rows.
- **Dashboard:** the launcher is rendered into each role-specific dashboard header after shared server-side resolution. It adds advisory role-dashboard context without changing that role's tools.

The launcher client is now a small shell. Its first-open event starts the chat chunk import and authenticated session fetch in parallel and deduplicates repeated open events. After the first successful open, the hydrated chat remains mounted for that launcher instance.

## 6. Tests

New and expanded tests cover:

- every context variant, strict/invalid/unknown inputs, date bounds, safe bilingual prompt projection, and validation-only future variants;
- registry completeness, P4.8B deny-by-default behavior, the full first-entry-point role matrix, Assistant and source-page hidden/lookup-failed states, multi-feature gates, the optional user-permission branch, usage/persistence, and fail-soft sanitized telemetry;
- closed-launcher behavior proving there is no hydration request, conversation/history load, capability resolution, or chat render before first Sheet open;
- authenticated deferred-session behavior, no-store response semantics, patient re-authorization before history, and retryable fail-soft UI;
- the shared Sheet component for patient, appointments, and dashboard contexts, including localized accessible descriptions;
- request serialization proving UI labels are not transmitted;
- route behavior for malformed context, advisory non-patient context, patient re-binding, and context-independent billing;
- tool-mount parity proving page context cannot widen capabilities;
- live RLS coverage proving same-tenant patient context succeeds, cross-tenant patient context is denied, and non-patient context is not persisted as patient scope;
- rendered server-entry coverage for authorized presence and unauthorized absence in patient, appointments, and dashboard;
- an exhaustive P4.8B absence contract over revenue, reports, the invoice host, staff, departments, and the doctor-schedule host, plus rendered checks that future contexts do not change suggestions.

### Performance evidence

- Production Turbopack output places the deferred Assistant Chat dependency set in three event-loaded chunks totaling **496,040 bytes raw / 120,039 bytes gzip**. The launcher chunk contains the dynamic loader; the chat dependency chunks are requested only by the Sheet-open import.
- A reproducible dashboard fixture with 40 messages (512 characters per message, matching the history-count ceiling) measures **23,708 bytes** for the former launcher prop shape versus **47 bytes** for the current `{context, role}` client payload: **23,661 bytes / 99.8%** removed from that fixture's initial RSC serialization. Real savings vary with message and capability size; closed launchers now serialize zero conversation messages by construction.

## 7. Validation

Final validation on 2026-07-22:

| Check | Result |
|---|---|
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing repository warnings |
| Focused P4.8A/P4B regression set | Pass — 8 files, 81 tests |
| `pnpm test` | Pass — 190 files, 1,347 tests |
| Live integration suite | Pass — 23 files, 239 tests |
| `pnpm lint:i18n` | Pass — 301 files scanned, 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,757 base messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 417 files scanned, 10 documented exceptions |
| `pnpm build` | Pass — Next.js 16.2.6 production build, 66 pages generated |
| `git diff --check` | Pass |

The build also reports the repository's existing Next.js middleware-to-proxy deprecation notice; it is unrelated to P4.8A.

## 8. P4.8B remains out of scope

P4.8B was not implemented. There are no launchers on revenue, reports, invoices, staff, departments, or doctor-schedule pages, and no context-aware suggested-prompt rollout. Their context variants exist only in the shared validation protocol; the registry intentionally refuses them. P4.8B remains the next roadmap sub-phase.
