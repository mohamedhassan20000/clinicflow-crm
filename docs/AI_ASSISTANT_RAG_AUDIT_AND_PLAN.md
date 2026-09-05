# AI Assistant + RAG — Audit and Implementation Plan

**Status:** audit only. No code, schema, migration, UI, or configuration was changed to produce this document.
**Scope:** the in-app staff Assistant, its shortcuts, conversation persistence, AI orchestration, entitlements, retrieval, and the security boundary around all of it.
**Method:** every claim below is anchored to a file, line, table, policy, or migration that was read during this audit.

---

## 1. Executive Summary

ClinicFlow already has a **mature, multi-layer AI platform** — considerably more built-out than the phrase "AI assistant" usually implies. It has a certified model registry with per-task budget policies, a three-mode credential system (managed gateway / BYOK / hybrid with fallback middleware), an atomic cost-reservation ledger, a 22-tool staff registry with deny-by-default role and entitlement gating, a human-in-the-loop workflow engine, and a genuinely strong prompt-injection defense layer with an adversarial evaluation corpus in CI.

Against that, the two gaps you asked about are narrow and well-defined:

**Gap 1 — the Assistant has persistence but no conversation *management*.** `agent_conversations` and `agent_messages` exist and are correctly RLS-isolated per user. But `loadLatestDoctorConversation` (`lib/ai/conversations.ts:79`) selects `order("updated_at", desc).limit(1)`, so a user can only ever resume **one** thread per patient-partition. Every earlier conversation becomes an unreachable row. There is a `title` column that nothing renders, a `status = 'archived'` value that nothing sets, and no list, sidebar, rename, or delete anywhere in the UI. "New Chat" silently orphans the previous thread.

**Gap 2 — there is no RAG.** No pgvector, no embeddings, no vector column anywhere in 136 migrations. This was a deliberate, documented decision (`docs/AI_AGENT_PLAN.md:1099`, `docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md:143`) and it was the right call for the problem it was made against — entity resolution by name, where trigram search is cheaper, faster, and auditable. It is the wrong call for the problem that remains: answering paraphrased questions about clinic policy, product behaviour, and FAQ prose.

Alongside those, the audit surfaced **two High-severity defects** in the existing conversation layer that should be fixed before any of it is built on:

- `agent_messages` RLS omits the role check its parent policy carries (§7.2).
- Message replay order is nondeterministic because both rows of a turn are written in one statement and share an identical `created_at`, with no tiebreaker in the read query (§7.3).

**Recommendation:** a five-phase plan. Fix the two defects first (Phase 0), then build real conversation management on the *existing* tables (Phases 1–2), then add a tightly scoped pgvector knowledge index for semantic prose only (Phases 3–4) — with patient, appointment, and financial data explicitly **excluded** from embeddings and left on the existing real-time RLS-backed tools. No new AI infrastructure is created; every phase extends what is already there.

---

## 2. Current Assistant Architecture

### 2.1 Request path, end to end

| Step | Location |
|---|---|
| Route | `app/(protected)/assistant/page.tsx` (server component) |
| Access resolution | `resolveStaffAssistantPage(user, locale)` — `lib/ai/surface.ts` |
| UI | `components/assistant/assistant-chat.tsx` (1338 lines) or `components/assistant/assistant-access-gate.tsx` |
| Transport | `useChat` + `DefaultChatTransport` → `POST /api/agent/chat` |
| API | `app/api/agent/chat/route.ts` (287 lines, `maxDuration = 60`) |
| Agent | `createStaffAgent()` — `lib/ai/staff-agent.ts` |
| Persistence | `ensureDoctorConversation` / `persistDoctorTurn` — `lib/ai/conversations.ts` |

The page runs `Promise.all([getTranslations, requireUser(), getLocale()])`, then `resolveStaffAssistantPage`. If page visibility resolves to `hidden` it redirects to `/dashboard`; otherwise it renders `AssistantChat` with `initialConversationId`, `initialMessages`, `initialActiveContext`, `historyTruncated`, `remaining`, `role`, and `capabilities`. Copy branches on `isClinical = role === "doctor" || role === "assistant"`.

`getStaffAssistantSurfaceAccess` returns a five-state union — `available | upgrade | cap_reached | subscription_inactive | temporarily_unavailable` — each rendered by `AssistantAccessGate` with its own copy.

### 2.2 The chat route

`app/api/agent/chat/route.ts:81` executes, in order:

1. `authorizeStaffAssistant()` — `lib/ai/authorization.ts`
2. `checkRateLimit("staff-assistant", user.clinicId, { limit: 30, windowSeconds: 60, failureMode: "open" })`
3. Zod parse of a `.strict()` body: `{ id: uuid, context?: unknown, message: { id, role: "user", parts: [{type:"text", text}] } }`, text capped at 4 000 chars
4. `parseAssistantPageContext(parsed.data.context)` — invalid context is **dropped**, not rejected
5. `getEntitlements(user.clinicId)` → `staffTaskForRole(role, { analyticsEntitled, workflowsEntitled, messageText })`
6. `prepareAiExecution({ user, requestId: createAiRequestId(...), task, persona, surface: "staff_assistant" })` — reserves budget
7. `ensureDoctorConversation(...)` in parallel with the clinic-name lookup
8. `createStaffAgent(...)` → `agent.stream({ messages: convertToModelMessages(uiMessages), abortSignal: request.signal })`
9. `result.toUIMessageStreamResponse({ originalMessages, onError, onFinish, consumeSseStream: consumeStream })`

Two details worth noting, both deliberate and both correct:

- **Only the last message is sent from the client.** `prepareSendMessagesRequest` transmits `{id, context, message: messages.at(-1)}`; the server rebuilds history from the database. The client cannot inject fabricated prior turns.
- **`onFinish` does not treat `streamFailed` as fatal.** The route's comment (lines ~230–250) explains that `onError` fires for every tool-error part, not only stream-fatal errors; the real signals are `finishReason === "error"` and empty assistant text. A turn that recovered from a tool error is persisted and billed as `success` with `errorClass: "recovered_tool_error"`.

### 2.3 Model and provider layer

Stack: Vercel AI SDK v6 (`ai@^6.0.230`), `@ai-sdk/anthropic@^3.0.98`, `@ai-sdk/react@^3.0.232`, Zod v4 for tool schemas. No raw `@anthropic-ai/sdk`.

`lib/ai/client.ts` exports only `createAiRequestId`, `assertAiInputWithinPolicy`, `prepareAiExecution`, `staffTaskForRole` — callers pick a certified *task*, never a model id.

`lib/ai/platform/registry.ts` defines `MODEL_ROUTES` (three aliases: `staff-sonnet-bootstrap-v1` → claude-sonnet-4.5; `staff-haiku-bootstrap-v1` and `patient-haiku-bootstrap-v1` → claude-haiku-4.5), each carrying `privacy.zeroDataRetentionRequired: true`, `noTrainingRequired: true`, pricing micros, and a certification block. Seven task policies:

| Task | Model | maxSteps | maxOutputTokens | maxInputTokens/step |
|---|---|---|---|---|
| `staff_clinical_summary` | sonnet | 8 | 1500 | 48k |
| `staff_administrative` | sonnet | 8 | 1500 | 48k |
| `staff_operational_query` | sonnet | 6 | 1200 | 48k |
| `staff_help` | haiku | 4 | 700 | 12k |
| `staff_workflow` | sonnet | 3 | 1200 | 32k |
| `patient_booking` | haiku | 6 | 800 | 16k |
| `patient_faq` | haiku | 4 | 600 | 12k |

Three credential modes: `managed` via Vercel AI Gateway (`lib/ai/platform/managed-gateway.ts`, with an HMAC-pseudonymised `user` tag and ZDR enforced in production), `byok_strict` via `createAnthropic()` (`lib/ai/platform/tenant-provider.ts`, fails closed on empty secret so an ambient `ANTHROPIC_API_KEY` can never serve a BYOK turn), and `hybrid` which wraps the direct model in `hybridFallbackMiddleware` with an audited `onFallback`.

### 2.4 Client rendering

`ChatSession` (`assistant-chat.tsx:912`) uses `useChat<StaffAssistantUIMessage>` with `experimental_throttle: 40`. `AssistantChat` (line 1286) is a shell that re-keys `<ChatSession key={session.id}:{activeContextVersion}>` so a server-refreshed active context resets local state cleanly.

`MessageBubble` (line 687) maps `message.parts`: `type === "text"` renders `<p className="whitespace-pre-wrap">`; `isToolUIPart(part)` renders `<ToolActivity>` (line 293). **There is no markdown renderer** — a model reply containing tables or lists renders as literal asterisks and pipes.

Error handling is unified across three transports (pre-stream JSON, stream error chunk, `tool-output-error` part) through `ERROR_COPY_KEYS` (line ~204) and `errorCopyKey()` (line 229). The route emits only `AssistantErrorCode` values (`lib/ai/errors.ts`); the client maps them to localized copy.

### 2.5 Current limitations

| # | Limitation | Evidence |
|---|---|---|
| L1 | One resumable conversation per user per patient-partition; all older threads unreachable | `lib/ai/conversations.ts:79` — `.order("updated_at", desc).limit(1)` |
| L2 | No conversation list, sidebar, rename, archive, or delete | no component references `agent_conversations.title`; `status='archived'` never written |
| L3 | Tool activity is lost on reload | `toUiMessages` (`conversations.ts:44`) keeps only `role in ('user','assistant')` |
| L4 | Replay order nondeterministic (see §7.3) | `loadMessages` orders by `created_at` alone; both rows share one transaction timestamp |
| L5 | Hard 40-message window, no summarisation | `HISTORY_LIMIT = 40` (`conversations.ts:14`); user sees a `historyTrimmed` banner |
| L6 | No markdown rendering | `assistant-chat.tsx:687` |
| L7 | No semantic retrieval — the model cannot answer paraphrased policy/FAQ questions | §6 |
| L8 | No retention/TTL on plaintext clinical text in `agent_messages` | no scheduled job; no `deleted_at`/TTL column |

---

## 3. Assistant Shortcuts Audit

### 3.1 Architecture

Every shortcut in the product is the **same component**: `AssistantLauncher` (`components/assistant/assistant-launcher.tsx:67`). It renders a `Sparkles` button labelled `t("askAboutPatient")` for patient context or `t("askAssistant")` otherwise (lines 131–139).

It **does not navigate**. It opens a `Sheet` (`side="inline-end"`, `sm:max-w-2xl`), lazily `import()`s `assistant-chat`, and on first open POSTs to `/api/agent/launcher-session` with `{ context }` (`loadSession`, lines 88–117), then renders `<AssistantChat mode="sheet" pageContext={context} contextLabel={contextLabel} />`.

Two adapters exist for different host trees:
- `assistant-launcher-entry.tsx` — `AssistantLauncherEntry`, the server-component adapter.
- `assistant-launcher-scope.tsx` — a React context plus `ScopedAssistantLauncher`, for client-tree hosts (dialogs, sheets) that cannot render a server component inline.

### 3.2 Complete inventory

| Host | Line | Context passed | Adapter |
|---|---|---|---|
| `app/(protected)/patients/[id]/page.tsx` | 165 / 400 | `{type:"patient", patientId}` + `contextLabel` | `AssistantLauncherEntry`; only when `isScopedClinical && !patient.is_deleted` |
| `app/(protected)/appointments/page.tsx` | 180 / 379 | `{type:"appointments", dateRange, status?, doctorId?}` | `AssistantLauncherEntry` |
| `app/(protected)/appointments/page.tsx` | 192 / 361 | `{type:"invoices", filter:"all"}` | `AssistantLauncherScope` |
| `components/appointments/billing-dialog.tsx` | 485 | invoices (via scope) | `ScopedAssistantLauncher` |
| `app/(protected)/dashboard/page.tsx` | 204–215, 224 | `{type:"dashboard"}` | helper `dashboardAssistantLauncher()`, used in 4 role variants (488, 586, 614, 773) |
| `app/(protected)/revenue/page.tsx` | 160 / 288 | `{type:"revenue", dateRange}` | `PageHeader actions` |
| `app/(protected)/reports/revenue/page.tsx` | 58 / 81 | `{type:"reports", report:"revenue", range}` | `ReportPageHeader actions` |
| `app/(protected)/reports/cancellations/page.tsx` | 57 / 80 | `report:"cancellations"` | same |
| `app/(protected)/reports/no-shows/page.tsx` | 55 / 78 | `report:"no_shows"` | same |
| `app/(protected)/reports/follow-ups/page.tsx` | 51 / 74 | `report:"followups"` | same |
| `app/(protected)/reports/doctors/page.tsx` | 54 / 77 | `report:"doctor_performance"` | same |
| `app/(protected)/reports/receptionists/page.tsx` | 54 / 77 | `report:"receptionist_performance"` | same |
| `app/(protected)/reports/my-revenue/page.tsx` | 38 / 53 | `report:"my_revenue"` | `PageHeader actions` |
| `app/(protected)/reports/my-performance/page.tsx` | 45 / 60 | `report:"my_performance"` | `PageHeader actions` |
| `app/(protected)/settings/staff/page.tsx` | 54 / 109 | `{type:"staff"}` | `AssistantLauncherEntry` |
| `app/(protected)/settings/staff/page.tsx` | 55 / 121 | `{type:"doctor-schedule"}` | `AssistantLauncherScope` |
| `components/settings/staff-profile-sheet.tsx` | 664 | doctor-schedule (via scope) | `ScopedAssistantLauncher` |
| `app/(protected)/settings/departments/page.tsx` | 33 / 58 | `{type:"departments"}` | `AssistantLauncherEntry` |

Plus two non-launcher entry points:
- **Global nav item** — `lib/page-permissions.ts:93-95` (`slug:"assistant"`, `href:"/assistant"`, visible by default to all five staff roles), icon `BrainCircuit` in `components/layout/sidebar.tsx:16`, route-protected in `lib/supabase/middleware.ts:15`.
- **In-assistant navigation target** — `lib/ai/help/navigation.ts:236` registers `{ id:"assistant", href:"/assistant", keywords:["assistant","ai","chat","ask"] }` so `get_navigation_target` can link to it.

### 3.3 Does context flow, and is it trusted?

Yes to the first, **carefully no** to the second. `lib/ai/page-context.ts` defines a strict zod discriminated union of nine variants, all `.strict()`, with `MAX_CONTEXT_RANGE_DAYS = 400`. `parseAssistantPageContext()` returns `null` on invalid input rather than throwing.

`buildAssistantPageContextPrompt(context, locale)` appends an "Advisory page context:" line to the system prompt in Arabic or English, and the prompt **explicitly states that the context grants no access**. In the chat route (lines ~160–172):

```ts
const authorizedPageContext: AssistantPageContext | null =
  pageContext?.type === "patient"
    ? conversation.patientId ? { type: "patient", patientId: conversation.patientId } : null
    : pageContext;
```

Only the `patient` variant participates in the RLS-backed conversation binding and is rebuilt from the *validated* conversation result. Every other variant stays advisory and ephemeral. No prefilled prompt string is ever passed — contexts only bias the suggestion chips (`suggestionsFor()`, line 753) and the system prompt.

### 3.4 Visibility resolution

`lib/ai/launchers.ts:78` holds `ASSISTANT_LAUNCHER_REGISTRY` — nine declarative entries of `{area, contextType, pageSlug, requiredFeatures, requiredUserPermission?, defaultEnabledByRole}` — resolved by `resolveAssistantLauncher()` (line 277) and `resolveAssistantLauncherSession()` (line 294). Per-clinic and per-user placement overrides live in `lib/ai/launcher-placement.ts` (`resolveAssistantLauncherPlacementValue`: entitlement → code default → role row → user row), backed by `assistant_launcher_settings` and `assistant_launcher_user_overrides`.

`/api/agent/launcher-session` is deliberately separate from the streaming route so that opening a Sheet **never reserves or bills an AI turn**. It has its own 2 KB body cap with a streaming reader, its own 30/60s rate limit keyed on `${clinicId}:${userId}`, and returns `Cache-Control: private, no-store`.

### 3.5 What is missing / what must change

| # | Gap | Change needed |
|---|---|---|
| S1 | Every launcher resumes the *same single* global thread (`loadLatestDoctorConversation` with `patient_id is null`). Opening the Assistant from the revenue page continues yesterday's staff-scheduling chat. | Launchers should **seed a fresh thread** with the context recorded on it, and offer "continue previous" explicitly (Phase 2). |
| S2 | No command palette, no global keyboard shortcut, no floating widget. `cmdk` is present (`components/ui/command.tsx`) but used only for comboboxes. | Optional — out of scope for this plan; noted as a follow-up. |
| S3 | `contextLabel` is UI-only and never reaches the API. Correct today; must stay that way when conversation titles are introduced (a title derived from the label would leak an unvalidated client string). | Derive titles server-side only. |
| S4 | Sheet mode has no history affordance at all. | Sidebar is page-mode only; sheet gets a compact "recent" popover at most. |

---

## 4. Current Conversation / Session Architecture

### 4.1 Schema

`supabase/migrations/20260718160000_p4a_ai_doctor_tools.sql:29`:

```sql
create table public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  user_id uuid not null,
  persona public.agent_persona not null default 'doctor',
  patient_id uuid,
  title text check (title is null or length(btrim(title)) between 1 and 200),
  locale text not null default 'en' check (locale in ('ar','en')),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_conversations_user_clinic_fkey
    foreign key (user_id, clinic_id) references public.profiles(id, clinic_id) on delete cascade,
  constraint agent_conversations_patient_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients(id, clinic_id)
    on delete set null (patient_id)
);
```

Indexes: `agent_conversations_owner_idx (clinic_id, user_id, updated_at desc)` and `agent_conversations_id_clinic_unique_idx (id, clinic_id)`. `active_context jsonb not null default '{}'` was added by `20260725120000_p410a_conversation_context.sql:32`.

`agent_messages` (line 92): `id`, `conversation_id`, `clinic_id`, `role agent_message_role ('user','assistant','tool')`, `content text not null default ''`, `tool_name text`, `created_at timestamptz not null default now()`. Composite FK `(conversation_id, clinic_id) → agent_conversations(id, clinic_id) on delete cascade`. Index `(conversation_id, created_at)`.

The **composite tenant-integrity FK pattern** used here — composite unique `(id, clinic_id)` on the parent plus composite FK on the child — is used consistently across the schema and means a cross-tenant reference is not expressible at the type level. This is good design and should be preserved in every new table.

### 4.2 Lifecycle

- **`ensureDoctorConversation`** (`conversations.ts:147`) selects by `(id, clinic_id, user_id, persona='doctor', status='active')`. If found, it enforces `existing.patient_id === requestedPatientId` and loads history. If not found, it returns a **virtual** conversation — no row is written — so an aborted or failed first turn leaves no empty row behind. A patient-bound request is re-authorized through `assertDoctorPatientContextAccess` before the virtual conversation is returned.
- **`assertDoctorPatientContextAccess`** (line 110) re-checks role ∈ {doctor, assistant}, then that the patient is live in the clinic and either assigned to the doctor or in their department. Its docstring is explicit that "launcher session requests are browser input, so the patient page's earlier RLS check cannot be treated as authorization for the later request" — correct reasoning.
- **`persistDoctorTurn`** (line 210) upserts the conversation with `{ onConflict: "id", ignoreDuplicates: true }`, **re-selects it through the full owner/clinic/persona scope** (defending against a concurrent first turn with the same client-generated id), folds active-context proposals, inserts both message rows in one `insert`, touches `updated_at`, and sets `title` from `userText.trim().slice(0, 120)` — but only `.is("title", null)`, so the title is write-once and there is no rename path.
- **`loadLatestDoctorConversation`** (line 79) is the only read entry point, and it returns exactly one row.

### 4.3 Active context (session memory)

`lib/ai/conversation-context.ts` provides `ActiveContext`, `ConversationContextRecorder`, `parseActiveContext`, `applyProposals`, `buildActiveContextPrompt`. Persisted in `agent_conversations.active_context`; rendered as removable chips for `patient | appointment | invoice | staff | department | report` (`CONTEXT_TYPE_ORDER`, `assistant-chat.tsx:96`). Mutated by server actions `chooseAssistantConversationContext` / `clearAssistantConversationContext` (`actions/assistant-context.ts`), followed by `router.refresh()`.

Critically: **ids in the active context are server-derived from RLS-authorized lookups, never asserted by the model**, and every tool re-authorizes the effective id. A trigger `trg_agent_conversations_clear_context` (`20260725120000:63`) clears context on relevant updates.

### 4.4 Where "New Chat" actually lives

Entirely on the client. `assistant-chat.tsx:~1141` renders a `Plus` button labelled `t("newChat")` whose handler is:

```ts
setSession({ id: createConversationId(), messages: [], historyTruncated: false, activeContext: {} })
```

The new UUID becomes a real row only when the first turn completes. The previous conversation is left in the database, still `status='active'`, but with a lower `updated_at` — which means it is now **permanently unreachable**, because the only read path takes `limit(1)` ordered by `updated_at desc`.

That is the single most consequential finding in this section: **the product already accumulates conversation history it can never show anyone.**

---

## 5. Current AI Infrastructure

### 5.1 Tool registry

`lib/ai/tools/registry.ts` defines `AI_TOOL_REGISTRY` and `AI_TOOL_REGISTRY_BY_NAME`. Each entry:

```ts
type AiToolDefinition = {
  name; build: (ctx: DoctorToolContext) => Tool;
  roles: readonly UserRole[];                    // deny-by-default
  requiredFeatures: readonly string[];           // all must resolve true
  requiredUserPermission?: AiUserPermissionKey;
  describedByUserPermissions?: readonly AiUserPermissionKey[];
  taskClasses: readonly AiTaskClass[];
  workflow: { kind: "read"|"action"|"orchestrator"; costUnits: number };
  capabilityDescription: { en: string; ar: string };
};
```

Twenty-two staff tools across clinical (`get_patient_summary`, `search_patient_visits`, `list_doctor_appointments`), shared (`search_authorized_patients`, `check_availability`), operational/analytics (`get_clinic_summary`, `get_patient_stats`, `get_appointment_stats`, `list_appointments`, `count_new_patients`, `list_pending_followups`, `run_clinic_report`), financial (`get_revenue_summary`, `compare_revenue_periods`, `list_outstanding_invoices` — all requiring `ai.financial_insights`), help (`search_help`, `get_navigation_target`, `list_my_capabilities`), and workflow (`execute_read_only_workflow` orchestrator plus `send_appointment_reminders`, `send_invoice_reminders`, `create_pending_booking`).

Six patient tools in `lib/ai/patient-tools.ts` are a **separate mount**: `verify_patient_identity`, `check_availability`, `create_preliminary_booking`, `list_my_appointments`, `cancel_my_appointment`, `answer_clinic_faq`. The `patient_faq` task class mounts only the last one.

### 5.2 Mount resolution and hardening

`resolveToolMount(ctx)` (`lib/ai/tools/index.ts`) filters by role → every `requiredFeatures` via `hasFeature` → task-class intersection → per-user permission via `hasAiUserPermission`. `STAFF_TASK_CLASSES_BY_ROLE` maps admin/manager/receptionist to `[staff_administrative, staff_operational_query, staff_help]` and doctor/assistant to `[staff_clinical_summary, staff_help]`.

A `staff_workflow` turn exposes **only the orchestrator** to the model; the nested read/action step tools live in a server closure (`workflowStepMount`) so the model cannot invoke them as peers. This is a well-designed containment boundary.

`harden(name, ctx, builtTool)` wraps every `execute`:
- `AiToolAuthorizationError` → a structured `{permission_denied: true, reason, guidance}` result (from an exhaustive `DENIAL_GUIDANCE` record) rather than a throw, so the model can explain the denial instead of failing the turn.
- Other errors → audited as `tool_error` and rethrown.
- Every result passes through `sanitizeUntrustedDeep` + `withProvenance`, with truncated paths surfaced as `text_truncated_fields`.
- Outcome classified by `outcomeOf()` and written to the audit ledger via `logAgentTool` → `log_agent_tool_call` RPC.

### 5.3 Tool context

`DoctorToolContext` (`lib/ai/tools/context.ts`): `{ user: AuthedUser, locale, patientId?, taskClass?, grantedPermissions?, activePatientId?, activeContext?, conversationId?, contextRecorder?, workflowStepMount?, aiRequestId? }`. Its docstring — *"Identity is captured from the authorized session at the surface boundary (never from the model)"* — accurately describes the implementation.

`PatientToolContext` (`lib/ai/patient-authorization.ts`) is `{ clinicId, conversationId, locale, aiRequestId }` with **`patientId` deliberately absent**; identity is resolved server-side from channel routing via the `resolve_patient_ai_context` RPC. This is the correct shape for an unauthenticated channel.

### 5.4 Entitlements — three independent layers

1. **`lib/entitlements.ts`** — `hasFeature()` hard-gates AI on `entitlements.planSlug === "pro_ai"`, and every namespaced key additionally requires `ai_assistant`. `getEntitlements` is `unstable_cache`d per clinic (tag `entitlements:<clinicId>`, 300s). Fails closed on any error.
2. **`lib/ai/authorization.ts`** — `authorizeStaffAssistant()` plus per-tool asserts (`assertClinicalToolAccess`, `assertAnalyticsToolAccess`, `assertClinicAnalyticsToolAccess`, `assertFinancialInsightsAccess`, `assertWorkflowAccess`, `assertWorkflowActionAccess`). Role matrices are deliberately kept as separate lists (`OPERATIONAL_ASSISTANT_ROLES`, `CLINIC_ANALYTICS_ASSISTANT_ROLES`, `FINANCIAL_ASSISTANT_ROLES`) so each layer denies independently.
3. **SQL** — `ai_assert_analytics_caller(p_scope)`, `effective_ai_feature(clinic, feature)`, `resolve_ai_commercial_limits`.

Then `prepareAiExecution` (`lib/ai/platform/execution.ts:294-330`) re-checks everything a fourth time before any provider call: surface↔task↔persona coherence, `ai_assistant`, `ai.staff_assistant` / `ai.patient_suggest`, `ai.scheduling` for booking, `ai.workflows` for workflow turns, `hasAiProviderMode`, and `policy.allowedCredentialModes`.

Feature keys: `ai.staff_assistant`, `ai.patient_suggest`, `ai.patient_auto`, `ai.managed`, `ai.byok`, `ai.hybrid_fallback`, `ai.staff_analytics`, `ai.financial_insights`, `ai.assistant_customization`, `ai.workflows`, `ai.followup_generation`, `ai.scheduling` (`lib/ai/commercial-policy.ts`).

Per-user grants live in `user_ai_permissions` (`20260720130000_p46a_staff_analytics.sql:62`), currently only `ai.financial_insights`; admins implicit, managers explicit and default-OFF, gated by `ai_permission_is_grantable`.

### 5.5 Usage, budget, and cost

- **Rate limit** — `lib/rate-limit.ts`, Upstash Redis sliding window via Lua.
- **Legacy fair-use meter** — `lib/ai/usage.ts`, `AI_USAGE_METRIC = "ai_messages"` over `usage_counters`, retained for BYOK/hybrid clinics.
- **Budget ledger (the real quota)** — `reserve_ai_budget` RPC does an atomic compare-and-reserve with a `leaseToken` and `RESERVATION_LEASE_SECONDS = 600`, reserving `calculateWorstCaseCostMicros(policy, route)`. Per-step `observeStep()` builds `AiUsageAttempt` rows. `finalize()` calls `reconcile_ai_budget`, idempotent with one retry, splitting `actualCostMicros` vs `managedCostMicros` (BYOK contributes 0; hybrid counts only successful post-fallback attempts).
- **Request id** — `createAiRequestId` is a deterministic SHA-256-derived UUID over `{clinicId, actorId, conversationId, messageId}`: retry-stable and content-free.
- **Tables** — `ai_budget_periods`, `ai_budget_reservations`, `ai_usage_events` (immutable, mutation blocked by `prevent_ai_usage_event_mutation()`), `ai_commercial_terms`. `ai_usage_events` carries an explicit comment: *"Never stores prompts, completions, tool payloads, patient ids, message bodies, or credentials."*

### 5.6 Prompts, redaction, injection defense

- `lib/ai/prompts/doctor.ts`, `staff.ts`, `patient.ts`, `help.ts` — full EN + AR prompts. The administrative prompt includes explicit aggregate-honesty rules (never derive a figure by subtracting from a total; handle `Other`, `suppression_reason:"aggregated"`, `grouped_bucket_count`, `distribution_withheld`).
- `lib/ai/redact.ts` — `redactText()` (emails, 7+ digit runs), `ageFromDateOfBirth()`, `redactPatientIdentity()` (drops national_id, file_number, phone, email, raw DOB), `toolAuditSummary()`.
- `lib/ai/untrusted-text.ts` — `sanitizeUntrustedDeep()` performs NFC normalisation, strips C0/C1, zero-width, and bidi-override "Trojan Source" characters, rewrites fence and `<|…|>` / `<system>` / `role:` patterns, collapses whitespace, applies field-aware caps (`NAME_TEXT_LENGTH=200` vs `FREE_TEXT_LENGTH=2000`), depth cap 12. `withProvenance()` stamps `data_provenance: untrusted_tenant_text: …` without overwriting an existing marker.
- `lib/ai/guardrails.ts` — `wrapUntrustedContent()`, `detectInjectionAttempt()` (EN, MSA, and Egyptian/Gulf/Levantine dialects), `detectEmergency()`; documented as flag-only, not a control.
- `lib/ai/eval/` — `injection-corpus.ts` (490 lines), `eval-set.ts` (889 lines), `grade.ts`, `authorized-tools.ts`, wired to `test:ai-adversarial`.

This is a genuinely strong injection posture and the RAG design in §9 must plug into it rather than around it.

---

## 6. Current RAG Capabilities

**There is no RAG.** Repo-wide search across 136 migrations and all of `lib/` finds:

- Exactly one extension: `create extension if not exists "pg_trgm"` (`20260504000000_baseline_schema.sql:14`). **No pgvector.**
- Zero `vector` columns, zero embedding columns, zero similarity-search-over-embeddings functions. The single textual hit for "vector" is the English word in a comment (`20260720170000_p46_phase_review_cycle3_fixes.sql:32`).

This was explicit and documented:
- `docs/AI_AGENT_PLAN.md:1099` — "embeddings (rejected — normalized trigram search suffices for name resolution)".
- `docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md:143` — "Deterministic DB search for entity resolution — zero model/embedding cost; embeddings reserved for genuinely semantic retrieval only (none needed in P4.6–P4.9)".

Note the wording of the second: embeddings were *reserved*, not forbidden. The target design in §9 is the case that reservation anticipated.

Three deterministic retrievers stand in today:

| Retriever | Location | Mechanism | Security |
|---|---|---|---|
| Patient entity resolution | `search_patients_ranked()` — `20260720120000_p46c_entity_search.sql` | pg_trgm `similarity`/`word_similarity` over generated columns `patients.search_name` / `search_phone`, GIN-indexed | **`security invoker`** — RLS applies. Correct. |
| Patient FAQ | `search_patient_clinic_faq()` — `20260727180000_p5a_patient_tools_booking.sql:796` | `pg_trgm similarity()` over `normalize_search_text()`, substring match scored 0.8, `limit 3`, language-preferred with fallback | `security definer`, `set search_path=''`, service-role only, re-checks `effective_ai_feature` + open conversation. App threshold `score >= 0.18` in `lib/ai/tools/answer-clinic-faq.ts`. |
| Product / help knowledge | `lib/ai/help/corpus.ts` (1170 lines, ~19 `HELP_ARTICLES`), `lib/ai/help/search.ts`, `lib/ai/help/navigation.ts` (811 lines) | In-memory weighted token scoring: title 6 / keyword 5 / summary 2 / body 1, `MIN_SCORE = 3`, EN+AR stop tokens, cross-script matching via `transliterateQuery`, limit 3 (max 5), ties broken by article id for determinism | Articles pre-filtered by `roles` / `requiredFeatures` / `requiredUserPermission` (silently removed) vs page-hidden (named but not taught, with `unavailable_reason`). |

`search.ts` carries the comment: *"There is no embedding model and no index here on purpose… exact normalized-token scoring is both sufficient and auditable."*

**Where this breaks down.** All three are lexical. A user asking *"what happens if a patient doesn't show up twice in a row?"* will not match a help article titled "No-show policy configuration" unless the shared tokens clear `MIN_SCORE = 3`. Arabic paraphrase is worse — trigram similarity across MSA and dialect phrasings of the same concept is weak. This is precisely the class of query semantic retrieval solves, and precisely the class the current system cannot answer.

---

## 7. Security & RLS Findings

### 7.1 What is correct (and should not be disturbed)

**Conversation isolation is per-user, not per-clinic, and enforced in the database.** The current policy (`20260727136000_phase7_authorization_hardening.sql:524`):

```sql
create policy "agent_owner_all_conversations" on public.agent_conversations
for all to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (array['admin','manager','doctor','receptionist','assistant']::public.user_role[])
  and ( patient_id is null
        or ( public.auth_role() = any (array['doctor','assistant']::public.user_role[])
             and exists (select 1 from public.patients p
                         where p.id = agent_conversations.patient_id
                           and p.clinic_id = agent_conversations.clinic_id
                           and p.is_deleted = false and p.deleted_at is null)))
)
with check ( /* identical */ );
```

`USING` and `WITH CHECK` are identical, so a user cannot write a row they could not read. A clinic admin **cannot** read another staff member's conversations; the original migration's comment states this intent directly: *"A conversation is private to its creator; audit visibility for admins comes from audit_logs, not from reading each other's chats."*

**There is no service-role write path to the agent tables.** `lib/supabase/admin.ts` exposes `createAdminClient()` (the only place `SUPABASE_SERVICE_ROLE_KEY` is read anywhere in `lib/`, `app/`, `actions/`) and a hardened `createClinicScopedAdminClient(clinicId)` Proxy that blocks `.rpc()`, `.schema()`, and `.storage`, rejects any table outside a reviewed allow-list, auto-injects `clinic_id` on writes, and auto-appends `.eq("clinic_id", clinicId)` on reads.

**`agent_conversations`, `agent_messages`, and `ai_budget_reservations` are absent from every allow-list** (`CLINIC_SCOPED_TABLES:1876`, `READ_ONLY_CLINIC_SCOPED_TABLES:1927`, `JOIN_SCOPED_TABLES:1938`, `EXPLICIT_SCOPE_TABLES:1945`). They are unreachable through the wrapper. The chat route uses the RLS client (`app/api/agent/chat/route.ts:30` imports `createClient` from `@/lib/supabase/server`). **RLS is the persistence boundary, exactly as the migration comment claims.** This is the strongest possible arrangement and any new conversation table must match it.

**Deny-all tables:** `ai_budget_periods`, `ai_budget_reservations`, `ai_usage_events`, `ai_provider_connections`, `ai_clinic_provider_policies`, `clinic_channels` all have RLS enabled with `revoke all … from public, anon, authenticated` — service-role only.

**Multi-tenancy primitives:** single-tenant-per-user via `profiles.clinic_id`; no join table. Helpers `auth_profile()`, `auth_clinic_id()`, `auth_role()` are `stable security definer` and filter on `is_active and not is_deleted and deleted_at is null`. `is_primary_clinic_admin()` and `auth_supervised_doctor_ids()` back the admin and assistant-supervision paths.

### 7.2 Finding H1 — `agent_messages` policy omits the role check

`20260718160000_p4a_ai_doctor_tools.sql:115`:

```sql
create policy "agent_owner_all_messages" on public.agent_messages
for all to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and exists (select 1 from public.agent_conversations c
              where c.id = agent_messages.conversation_id
                and c.clinic_id = agent_messages.clinic_id
                and c.user_id = auth.uid())
) with check ( /* identical */ );
```

The parent policy was revised three times (`20260718210000`, `20260727136000`) to carry a `public.auth_role() = any (...)` term and a live-patient existence check. **This policy was never revised.** It checks only clinic and ownership.

The subquery does select from `agent_conversations`, but a policy's subquery is itself subject to that table's RLS — which means today the check does transitively inherit the role gate. The exposure is narrower than it first appears, but the asymmetry is real and fragile: the message policy's correctness is an emergent property of another table's policy rather than a stated invariant. If the parent policy is ever relaxed, or if the subquery is ever rewritten as `security definer`, message-level isolation silently degrades with no test covering it.

**Severity: High.** Fix by mirroring the parent's role term and patient-liveness check explicitly.

### 7.3 Finding H2 — nondeterministic message replay order

`persistDoctorTurn` writes both rows of a turn in a single statement (`conversations.ts:~340`):

```ts
const rows = [ { role: "user", content: userText }, ... ];
if (input.assistantText.trim()) rows.push({ role: "assistant", content: ... });
await input.supabase.from("agent_messages").insert(rows);
```

`created_at` defaults to `now()`, which in PostgreSQL is **transaction start time** — identical for both rows. `loadMessages` (`conversations.ts:60`) then reads:

```ts
.order("created_at", { ascending: false }).limit(HISTORY_LIMIT + 1)
```

with no secondary sort key. Row order for equal sort keys is unspecified.

Consequences: (a) a reloaded conversation can render the assistant's answer above the user's question; (b) worse, `convertToModelMessages(uiMessages)` feeds that same sequence back to the model, so a swapped pair produces a malformed conversation transcript — two consecutive `assistant` turns or a trailing `user`/`assistant` inversion — which degrades reply quality in ways that are hard to diagnose; (c) `HISTORY_LIMIT + 1` truncation can drop the wrong row of a boundary pair.

**Severity: High.** Fix with a monotonic `seq` column (or `bigint generated always as identity`) and order by `(created_at, seq)`, or minimally by `(created_at, id)` for stability plus an explicit ordinal for correctness.

### 7.4 Finding M1 — `user_ai_permissions` self-read is not tenant-scoped

`20260720160000_p46_phase_review_cycle2_fixes.sql:122`:

```sql
create policy "Users can read own ai permissions" on public.user_ai_permissions
for select using (user_id = auth.uid());
```

No `clinic_id = public.auth_clinic_id()` term. Safe today because `profiles` is one-row-per-user and a user therefore has exactly one clinic — but the safety is incidental to the data model, not stated in the policy. If multi-clinic membership is ever introduced (a plausible SaaS evolution), this policy leaks a user's grants across tenants with no code change to flag it.

**Severity: Medium.** Add the clinic term.

### 7.5 Finding M2 — no retention policy on clinical text

`agent_messages.content` stores conversation text verbatim in plaintext. In a clinical assistant, that content routinely includes patient names, symptoms, and treatment discussion — PHI by any definition. There is no TTL, no scheduled purge, no `deleted_at`, and no export/erasure path. `ai_usage_events` by contrast is explicitly documented as content-free, which shows the retention question was considered for telemetry but not for conversation bodies.

**Severity: Medium.** Add a configurable retention window with a scheduled purge, and a per-conversation delete that actually deletes.

### 7.6 Finding M3 — `clinic_faq` is an unvalidated content source

`clinic_faq` has exactly one authenticated policy:

```sql
create policy "clinic_faq_staff_read_own" on public.clinic_faq
for select to authenticated using (clinic_id = public.auth_clinic_id());
```

**No write policy at all.** Rows are written only through `createClinicScopedAdminClient` in `lib/ai/patient-faq-settings.ts:46`, driven by `actions/patient-ai.ts`. Content is authored by clinic staff and consumed by the patient agent as its answer corpus.

Today `answer_clinic_faq` results pass through `sanitizeUntrustedDeep`, so the injection risk is contained. But the moment this corpus is embedded and retrieved into the *staff* Assistant's context (as §9 proposes), a malicious or compromised clinic-staff account gains a persistent write primitive into another persona's prompt context. This must be treated as untrusted tenant text at every retrieval boundary, not merely at the current one.

**Severity: Medium** (today), **High if RAG is built without addressing it.**

### 7.7 Finding L1 — `auth_clinic_id()` / `auth_role()` granted to `anon`

`20260504000000_baseline_schema.sql:670-678` grants execute on these helpers to `anon` as well as `authenticated`. They return `null` for an unauthenticated caller (`auth.uid()` is null), so there is no direct leak. It is nonetheless unnecessary attack surface on `security definer` functions.

**Severity: Low.**

### 7.8 Summary of what is *not* a problem

Worth stating explicitly, because these were checked and found sound:

- **Contextual shortcuts do not confer access.** Only the `patient` variant is re-authorized, and it is rebuilt from the validated conversation row, not from the client payload (`chat/route.ts:160-172`).
- **Unauthorized patient/document retrieval.** Staff persona tools receive the RLS server client via `DoctorToolContext`; they are not on the service-role path. `search_patients_ranked` is `security invoker`.
- **Storage.** No AI code path touches storage — `createClinicScopedAdminClient` throws on `.storage`, and no file under `lib/ai/` imports the storage helpers. `patient-assets` and `clinic-documents` are private buckets with path-regex-locked, existence-checked policies.
- **Cross-tenant references** are structurally unexpressible via the composite-FK pattern.
- **AI entitlement enforcement** is four-deep and fails closed at every layer.

---

## 8. Target Conversation Architecture

**Design constraint (confirmed):** strict per-user privacy, no admin read path. Oversight stays in `audit_logs`. Every guarantee below is enforced in PostgreSQL RLS; **no isolation whatsoever depends on frontend filtering or on a server query remembering to add a `.eq()`.**

### 8.1 Schema changes (extend, do not replace)

Keep `agent_conversations` and `agent_messages`. Add:

| Change | Table | Purpose |
|---|---|---|
| `seq bigint generated always as identity` (or per-conversation ordinal) | `agent_messages` | deterministic replay order — fixes H2 (§7.3) |
| `parts jsonb` (nullable, additive) | `agent_messages` | persist tool-invocation parts so `ToolActivity` survives reload; `content` stays as the plain-text fallback |
| `last_message_at timestamptz` | `agent_conversations` | list ordering without touching `updated_at`, which the `set_updated_at` trigger already owns |
| `context_kind text` (the launcher's `AssistantPageContext.type`) | `agent_conversations` | so the sidebar can show where a thread was started; **server-derived only**, never from `contextLabel` |
| index `(clinic_id, user_id, status, last_message_at desc)` | `agent_conversations` | powers the sidebar list |

RLS on `agent_messages` is rewritten to mirror the parent policy's role and patient-liveness terms explicitly (fixes H1, §7.2). No new table is added for conversations — the existing one is already correctly shaped and correctly isolated.

### 8.2 Server layer

New functions in `lib/ai/conversations.ts`, all taking the **RLS client** (`@/lib/supabase/server`), never an admin client:

- `listConversations({ supabase, user, cursor, limit })` — selects `id, title, patient_id, context_kind, last_message_at, status` filtered `.eq("clinic_id", user.clinicId).eq("user_id", user.id).eq("persona","doctor").eq("status","active")`, ordered by `last_message_at desc`, keyset-paginated. The `.eq("user_id")` is defence in depth; RLS is the actual guarantee.
- `loadConversation({ supabase, user, conversationId })` — replaces the implicit "latest" read. Returns `null` if RLS filters the row out; the caller must not distinguish "not yours" from "does not exist".
- `renameConversation` / `archiveConversation` / `deleteConversation` — server actions in a new `actions/assistant-conversations.ts`, each re-scoped and each writing an `audit_logs` entry. Delete is a real delete (`agent_messages` cascades via the composite FK), satisfying M2's erasure requirement.
- `loadLatestDoctorConversation` is **retained** for launcher hydration but changes meaning (see §10).

`ensureDoctorConversation`'s virtual-first-turn behaviour is preserved unchanged — it is a good property and the sidebar simply will not show a thread until its first turn lands.

### 8.3 Why frontend filtering is not part of this design

Stated explicitly because it is the requirement you raised:

A conversation list is the classic place where a `.eq("user_id", currentUser.id)` in a query becomes the only thing standing between User A and User B's clinical chat. In this design it is not, for three compounding reasons:

1. `agent_conversations`' RLS `USING` clause contains `user_id = auth.uid()`. A query that forgets the filter returns **zero extra rows**, not another user's rows.
2. The route uses the RLS-bound client from `lib/supabase/server`; the agent tables are absent from every `createClinicScopedAdminClient` allow-list, so no code path can accidentally acquire a service-role handle to them. This must be preserved as an invariant when new tables are added.
3. `WITH CHECK` mirrors `USING`, so rename/archive/delete cannot target a row the caller cannot read — the classic IDOR shape (`UPDATE … WHERE id = $1` with an attacker-supplied id) fails at the database.

The client receives only rows the database already decided it may see. The sidebar renders what it is given.

### 8.4 UI

- **Page mode** (`mode === "page"`): a left sidebar listing conversations by `title` with relative `last_message_at` and a `context_kind` badge, a "New Chat" button at the top, and a per-row overflow menu (Rename / Archive / Delete) with a confirm dialog on delete. Selecting a row navigates to `/assistant?c=<id>`, so the server component loads it — history is not fetched client-side.
- **"New Chat"** keeps its current client-only semantics (a fresh UUID, virtual until the first turn), but the previous thread is now reachable in the sidebar instead of being orphaned.
- **Sheet mode**: no sidebar. At most a compact "recent conversations" popover, deferred to a follow-up.
- New i18n keys under the existing `assistant` namespace, in **both** `messages/en.json` and `messages/ar.json` — the namespace currently has exact 190-key parity and that must hold.

### 8.5 Context window

`HISTORY_LIMIT = 40` stays as the model-context bound. The sidebar reads metadata only, so listing is cheap regardless of thread length. Rolling summarisation is explicitly deferred (§12).

---

## 9. Target RAG Architecture

**Design constraint (confirmed): pgvector, tightly scoped.** Embeddings cover semantic prose only. Patient, appointment, clinical, and financial records are **never embedded** — they stay behind the existing real-time RLS-backed tools.

### 9.1 The boundary — three distinct retrieval modes

This is the most important table in this document. Misclassifying a data source here is how RAG systems leak.

| Mode | What it covers | Mechanism | Freshness | Authorization |
|---|---|---|---|---|
| **RAG retrieval** | Semi-static *prose*: product/help knowledge (`HELP_ARTICLES`), `clinic_faq` entries, clinic policy documents | pgvector ANN + pg_trgm hybrid over `ai_knowledge_chunks` | eventual (re-indexed on write) | filter by `clinic_id`, `source_kind`, plus the article-level `roles` / `requiredFeatures` / `requiredUserPermission` predicates that `lib/ai/help/search.ts` already applies |
| **Real-time structured tools** | Patients, appointments, visits, invoices, revenue, staff, schedules, reports — **everything with a row-level owner** | the existing 22-tool registry, RLS-bound Supabase client, `security invoker` RPCs | live | full existing four-layer stack (role → feature → user permission → per-tool assert → RLS) |
| **AI actions** | Sending reminders, creating bookings | workflow orchestrator, dry-run snapshot + `dry_run_snapshot_hash`, human confirmation via `confirmAssistantWorkflow` | live | `assertWorkflowActionAccess` + `ai.workflows` + explicit user confirm |

**Nothing moves from column 2 to column 1.** Concretely, the following must never be embedded, and the report records this as a hard design rule:

- `patients` (including `search_name` / `search_phone`) — already served correctly by `search_patients_ranked()`, `security invoker`
- `appointments`, `visits`, medical notes, `patient_documents`, `medical_note_attachments`
- `invoices`, revenue figures, any aggregate a report produces
- `agent_messages` (a user's own conversation history)
- staff profiles, schedules, `assistant_doctor_assignments`

The reason is not squeamishness about cost. It is that an embedding index is a **flattened, permission-erased copy** of its source. Row-level authorization on patients depends on `assigned_doctor_id`, `department_id`, soft-delete state, and `auth_supervised_doctor_ids()` — predicates that change after indexing and that a similarity search cannot re-evaluate. Any index over that data is a standing risk of serving a doctor a chunk about a patient they lost access to yesterday. The existing architecture already solves this correctly with live tools; RAG must not undo it.

### 9.2 Data → indexing → retrieval → context → AI

**Data.** Three `source_kind` values at launch:
- `help` — the ~19 `HELP_ARTICLES` from `lib/ai/help/corpus.ts`, global (not clinic-scoped), already carrying `roles` / `requiredFeatures` / `requiredUserPermission` metadata.
- `clinic_faq` — per-clinic rows from the existing `clinic_faq` table.
- `clinic_policy_doc` — new, per-clinic staff-authored policy prose (opt-in; deferred to a later phase if not needed at launch).

**Indexing.** A new table, following the established composite-FK tenancy pattern:

```
ai_knowledge_chunks
  id uuid pk
  clinic_id uuid null            -- null = global corpus (help articles)
  source_kind text check (source_kind in ('help','clinic_faq','clinic_policy_doc'))
  source_id text                 -- article id / clinic_faq.id / document id
  locale text check (locale in ('ar','en'))
  content text                   -- the sanitized chunk
  content_hash text              -- skip re-embedding unchanged chunks
  embedding vector(N)
  required_roles user_role[]     -- mirrored from the source's own gate
  required_features text[]
  required_user_permission text
  indexed_at timestamptz
  -- composite FK (clinic_id) → clinics, unique (id, clinic_id)
```

Index: HNSW on `embedding` (cosine), plus a GIN trigram index on `content` for the lexical half of the hybrid.

Ingestion is a server-only job. Content is passed through `sanitizeUntrustedDeep` **before embedding**, so injection payloads in tenant FAQ text never enter the index in executable form. `content_hash` makes re-indexing idempotent and cheap. Because both target corpora are small and change rarely, this can start as an on-write hook plus a manual reindex action — no queue infrastructure is needed at this scale.

Embeddings are generated through the existing platform layer, not a new client: a new certified route in `lib/ai/platform/registry.ts` (e.g. `embedding-bootstrap-v1`), a new task class `staff_knowledge_retrieval`, and cost accounted through the same `ai_usage_events` ledger. **This is the point of "reuse existing infrastructure"** — no second provider path, no second budget system, and ZDR requirements carry over automatically.

**Permission-aware retrieval.** A `security definer` RPC, `search_knowledge_chunks(p_query_embedding, p_locale, p_limit)`, that:
1. resolves the caller via `auth_clinic_id()` / `auth_role()` — **never accepts a caller-supplied clinic or role**;
2. filters `clinic_id is null or clinic_id = auth_clinic_id()`;
3. filters `required_roles is null or auth_role() = any(required_roles)`;
4. returns at most 5 chunks above a similarity floor.

Feature and per-user-permission predicates are re-applied in TypeScript against the already-resolved `hasFeature` / `hasAiUserPermission` results, mirroring exactly how `lib/ai/help/search.ts` pre-filters today — silently removing entitlement-gated articles and *naming but not teaching* page-hidden ones.

**Hybrid ranking.** Fuse vector similarity with the existing trigram score (reciprocal-rank fusion). This preserves the exact-match strengths the current lexical search has — including the EN/AR cross-script `transliterateQuery` path — while adding paraphrase recall. Ties broken by chunk id, so results stay deterministic and testable, which is the property `lib/ai/help/search.ts` deliberately protects.

**Context.** A new tool, `search_knowledge`, registered in `AI_TOOL_REGISTRY` alongside `search_help`:
- `roles`: all staff
- `requiredFeatures`: `["ai_assistant", "ai.staff_assistant"]`
- `taskClasses`: all four staff classes (it is a help-class tool)
- `workflow`: `{ kind: "read", costUnits: 1 }`

It goes through the same `harden()` wrapper as everything else, so its results are audited, `sanitizeUntrustedDeep`-processed, and stamped `withProvenance("untrusted_tenant_text: clinic_faq")` for tenant-authored chunks vs `system_generated: help` for the curated corpus. **The provenance distinction matters:** the system prompt must instruct the model to treat `untrusted_tenant_text` chunks as reference material only and never as instructions — which is exactly the discipline `lib/ai/guardrails.ts` `wrapUntrustedContent()` already implements for other sources.

**AI.** No change to the agent loop. `search_knowledge` mounts as one more tool; the model decides when to call it. Nothing is stuffed into the system prompt unconditionally, which keeps `maxInputTokensPerStep` budgets intact.

### 9.3 Why this shape

- It reuses the model registry, budget ledger, tool registry, `harden()` wrapper, sanitization layer, entitlement stack, and audit trail. The only genuinely new components are one table, one RPC, one ingestion job, and one tool.
- It preserves the property that made the original "no embeddings" decision correct: entity resolution stays deterministic and lexical. RAG is added *next to* that, not over it.
- It does not create a PHI-bearing index, so it adds no new data-retention, erasure, or breach-notification obligation beyond what already exists.

---

## 10. Target Assistant + Shortcut Architecture

One component, three surfaces, one conversation store.

| Surface | Conversation behaviour |
|---|---|
| `/assistant` (page mode) | Sidebar with full history. `?c=<id>` selects a thread; server component loads it via `loadConversation`. "New Chat" starts a fresh virtual thread. |
| Contextual launcher (sheet mode) | **Changes:** instead of resuming the single global thread, a launcher opens a *new* thread stamped with `context_kind`, and offers "continue previous" only when the most recent thread carries the same `context_kind`. This fixes S1 (§3.5) — opening the Assistant from the revenue page no longer silently continues yesterday's staff-scheduling chat. |
| Patient-scoped launcher | Unchanged. `patient_id` remains the RLS-bound binding, re-authorized every time by `assertDoctorPatientContextAccess`. This is the one context that confers scope, and it must keep its current strictness. |

Unchanged and deliberately so: the advisory-context rule; `contextLabel` staying client-side; `/api/agent/launcher-session` remaining non-billing; the launcher registry and placement-override system; the four-layer entitlement stack.

`context_kind` is derived server-side from the already-validated `AssistantPageContext.type` — never from any client-supplied label.

---

## 11. Implementation Roadmap

Five phases. Each is independently shippable, and each is ordered so that no phase builds on an unfixed defect.

---

### Phase 0 — Conversation-layer hardening

**Objective.** Fix H1 and H2 before anything is built on the conversation tables.

| Area | Work |
|---|---|
| **DB / RLS** | New migration: add `seq bigint generated always as identity` to `agent_messages`; backfill deterministically by `(created_at, id)`. Drop and recreate `agent_owner_all_messages` with the parent policy's `auth_role()` term and patient-liveness check made explicit. Add `clinic_id = public.auth_clinic_id()` to `user_ai_permissions`' self-read policy (M1). |
| **Backend** | `lib/ai/conversations.ts`: `loadMessages` orders by `("created_at", asc), ("seq", asc)` and takes the *first* `HISTORY_LIMIT` after a stable sort, removing the `toReversed()` dance. |
| **Frontend** | None. |
| **AI/RAG** | None. |
| **Tests/QA** | Unit test asserting a persisted turn replays as `[user, assistant]` when both rows share a timestamp (this test fails today). RLS integration test: a second user cannot select another user's `agent_messages` rows by conversation id. Regenerate DB types — note the known ~1184-line local-vs-remote drift; hand-add the new column surgically. |
| **Depends on** | Nothing. |

---

### Phase 1 — Conversation list backend

**Objective.** Make every conversation a user owns reachable, with rename / archive / delete.

| Area | Work |
|---|---|
| **DB / RLS** | Add `last_message_at timestamptz`, `context_kind text` to `agent_conversations`; index `(clinic_id, user_id, status, last_message_at desc)`. Existing RLS already covers the new columns — **no policy change needed**, which is the point of extending rather than replacing. |
| **Backend** | `lib/ai/conversations.ts`: add `listConversations`, `loadConversation`, `renameConversation`, `archiveConversation`, `deleteConversation`. New `actions/assistant-conversations.ts` server actions, each re-authorizing through `authorizeStaffAssistant()` and writing `audit_logs`. `persistDoctorTurn` sets `last_message_at` and `context_kind` (server-derived). |
| **Frontend** | None yet. |
| **AI/RAG** | None. |
| **Tests/QA** | Ownership tests for every new action (User B cannot rename/delete User A's thread — must fail at RLS, verified by removing the defensive `.eq()` in the test). Pagination test. Audit-log assertions. |
| **Depends on** | Phase 0. |

---

### Phase 2 — Sidebar, New Chat, and shortcut rework

**Objective.** Ship the conversation UX and fix the shortcut-resumption problem (S1).

| Area | Work |
|---|---|
| **DB / RLS** | None. |
| **Backend** | `app/(protected)/assistant/page.tsx` reads `?c=<id>` and calls `loadConversation`; `resolveStaffAssistantPage` returns the conversation list. `resolveAssistantLauncherSession` returns a context-matched thread or a fresh id. Persist `parts jsonb` in `agent_messages` and rehydrate tool parts in `toUiMessages`. |
| **Frontend** | New `components/assistant/conversation-sidebar.tsx`. Wire the existing `newChat` button to it. Rename dialog + delete confirm. New `assistant.*` i18n keys in **both** `messages/en.json` and `messages/ar.json` (preserve exact parity). RTL verified. |
| **AI/RAG** | None. |
| **Tests/QA** | Component tests for the sidebar; a test mirroring `tests/unit/components/p48a-entry-points.test.ts` asserting each launcher host produces the expected `context_kind`; manual QA of `/assistant?c=<id>` with a foreign id (must render empty, not error-leak). |
| **Depends on** | Phase 1. |

---

### Phase 3 — pgvector foundation

**Objective.** Stand up the index and ingestion with **no** user-visible behaviour change.

| Area | Work |
|---|---|
| **DB / RLS** | `create extension if not exists vector`. Create `ai_knowledge_chunks` per §9.2 with composite-FK tenancy, RLS enabled, `revoke all … from public, anon, authenticated` (service-role write only). HNSW cosine index + GIN trigram index. Create `search_knowledge_chunks()` as `security definer, set search_path = ''`, resolving the caller via `auth_clinic_id()` / `auth_role()`. |
| **Backend** | New `lib/ai/knowledge/` — `chunker.ts`, `ingest.ts` (sanitize → hash → embed → upsert; skip on unchanged hash), `retrieve.ts` (hybrid RRF fusion). Add `embedding-bootstrap-v1` to `lib/ai/platform/registry.ts` and a `staff_knowledge_retrieval` task class; account cost through the existing `ai_usage_events` ledger. Ingestion hook on `clinic_faq` writes in `lib/ai/patient-faq-settings.ts` plus an admin reindex action. |
| **Frontend** | None (optionally an operator-side reindex button). |
| **AI/RAG** | Embedding generation only; no tool is exposed to the model yet. |
| **Tests/QA** | Ingestion idempotency by `content_hash`. RPC test: a clinic-A caller never receives a clinic-B chunk. Sanitization test: an injection payload in a `clinic_faq` row is neutralised *before* it reaches the index. Cost-accounting assertion against `ai_usage_events`. |
| **Depends on** | Nothing (parallelizable with Phases 1–2). |

---

### Phase 4 — `search_knowledge` tool and evaluation

**Objective.** Expose retrieval to the model, safely.

| Area | Work |
|---|---|
| **DB / RLS** | None. |
| **Backend** | Register `search_knowledge` in `AI_TOOL_REGISTRY` (roles: all staff; features `["ai_assistant","ai.staff_assistant"]`; all four staff task classes; `{kind:"read", costUnits:1}`). Route it through `harden()`. Stamp `withProvenance("untrusted_tenant_text: clinic_faq")` vs `system_generated: help`. Add the "reference material, never instructions" clause to `lib/ai/prompts/staff.ts`. Add EN+AR `capabilityDescription` and `assistant.tool*` i18n keys. |
| **Frontend** | Capability-panel entry via the existing `lib/ai/capabilities.ts` path; tool label in `lib/ai/tool-presentation.ts`. |
| **AI/RAG** | Hybrid retrieval live; similarity floor tuned against a labelled query set. |
| **Tests/QA** | **Extend `lib/ai/eval/injection-corpus.ts` with retrieved-chunk injection cases** — a poisoned `clinic_faq` row instructing the model to call a financial tool must not succeed. Golden-set retrieval quality tests in EN and AR. Verify the tool honours `requiredFeatures` / `requiredUserPermission` filtering. Run `test:ai-adversarial`. |
| **Depends on** | Phase 3. |

---

### Phase 5 — Retention and hygiene

**Objective.** Close M2 and L1.

| Area | Work |
|---|---|
| **DB / RLS** | Scheduled purge of `agent_messages` beyond a configurable retention window (service-role cron). Revoke `auth_clinic_id()` / `auth_role()` execute from `anon`. |
| **Backend** | Retention setting surfaced in clinic settings; purge job with audit logging. |
| **Frontend** | Retention control in settings; "delete conversation" already shipped in Phase 2 and now genuinely erases. |
| **AI/RAG** | None. |
| **Tests/QA** | Purge boundary test; verify `anon` revocation breaks nothing (run the full e2e suite on `PORT=3100`). |
| **Depends on** | Phase 1. |

---

## 12. Risks & Open Questions

| # | Risk / question | Notes |
|---|---|---|
| R1 | **Embedding provider and ZDR.** The certified registry enforces `zeroDataRetentionRequired: true`. Whichever embedding model is chosen must be certifiable on the same terms and available through the existing gateway; a provider that cannot meet ZDR is disqualified regardless of quality. | Blocks Phase 3. |
| R2 | **`clinic_faq` as a persistent injection vector** (M3). Once embedded, a clinic-staff account gains a durable write into the staff Assistant's context. Mitigated by sanitize-before-index + provenance stamping + the Phase 4 eval cases, but it is the single largest new attack surface this plan introduces and warrants explicit sign-off. | Phase 3/4. |
| R3 | **Embedding dimensionality is effectively permanent.** Changing it later means a full reindex and an index rebuild. Decide `vector(N)` deliberately at Phase 3. | Phase 3. |
| R4 | **DB type regeneration drift.** Local `supabase gen types` drifts ~1184 lines from the committed remote-generated file. New objects must be hand-added surgically to `types/database.ts` rather than wholesale-regenerated. | Every phase touching schema. |
| R5 | **`HISTORY_LIMIT = 40` vs context budget.** Making history reachable does not make it *usable* beyond 40 messages. Rolling summarisation is deliberately deferred; if long threads become common, it moves onto the roadmap. | Post-Phase 2. |
| R6 | **Corpus size vs infrastructure.** ~19 help articles plus per-clinic FAQ is small enough that an on-write ingestion hook is sufficient. If `clinic_policy_doc` grows to real document volume, ingestion needs a proper queue. | Revisit before adding `clinic_policy_doc`. |
| R7 | **Open — does the sheet-mode launcher need history at all?** §10 proposes context-matched fresh threads with no sidebar. If users expect sheet-mode continuity, a compact recents popover is a small addition. Worth a QA observation before committing. | Phase 2. |
| R8 | **Open — retention window default.** M2's fix needs a number. Regulatory guidance for clinical records in the target market should set it; it is not an engineering choice. | Phase 5. |
| R9 | **Cost.** Retrieval adds an embedding call per query. At haiku-class embedding pricing over a small corpus this is marginal, but it must flow through `ai_budget_periods` so a clinic cannot be surprised. The `staff_knowledge_retrieval` task class exists for exactly this accounting. | Phase 3. |

---

## 13. Final Recommendation

Build in the order given. **Phase 0 first, without exception** — H2 in particular is currently corrupting the transcript fed back to the model on every reloaded conversation, and building a conversation sidebar on top of nondeterministic message ordering would make the defect far more visible and far more expensive to fix.

Then ship conversation management (Phases 1–2) before RAG (Phases 3–4). Conversation management is the gap users actually feel today — the product is silently accumulating history it cannot show anyone — and it requires no new infrastructure, no new provider, and no new attack surface. RAG is the more interesting piece of engineering and the less urgent one.

Throughout, the governing principle is **extend, don't duplicate**. This codebase already has a certified model registry, a budget ledger, a hardened tool registry, a four-layer entitlement stack, a sanitization layer, and an adversarial eval suite. Every element of this plan plugs into those. The genuinely new artifacts across all five phases are: two columns and one index on existing tables, one new table, one RPC, one ingestion module, one tool, and one sidebar component. Anything larger than that would be a sign of drift.

### Classified findings

| ID | Sev | Current problem | Why it matters | Recommended solution | Phase |
|---|---|---|---|---|---|
| **H1** | High | `agent_messages` RLS (`20260718160000:115`) omits the `auth_role()` and patient-liveness terms its parent policy carries (§7.2) | Message isolation is currently an emergent property of another table's policy rather than a stated invariant; it degrades silently if the parent is ever relaxed, and no test covers it | Recreate the policy mirroring the parent's terms explicitly; add an RLS integration test | 0 |
| **H2** | High | Both rows of a turn share one transaction `created_at`; `loadMessages` sorts on it with no tiebreaker (§7.3) | Replay order is nondeterministic — the UI can invert a turn, and `convertToModelMessages` feeds a malformed transcript back to the model, degrading replies in ways that are hard to diagnose | Add `seq bigint generated always as identity`; order by `(created_at, seq)`; backfill deterministically | 0 |
| **H3** | High | Only the most recent conversation per partition is reachable (`conversations.ts:79`, `limit(1)`); `title` is never rendered, `status='archived'` never set (§4.4) | The product accumulates clinical conversation history that no user can ever reach, and "New Chat" silently orphans work | `listConversations` + `loadConversation` + sidebar with rename/archive/delete, all RLS-enforced | 1–2 |
| **M1** | Medium | `user_ai_permissions` self-read policy lacks a `clinic_id` term (§7.4) | Safe only incidentally, via one-clinic-per-profile; leaks across tenants the day multi-clinic membership arrives, with no code change to signal it | Add `clinic_id = public.auth_clinic_id()` | 0 |
| **M2** | Medium | No retention, TTL, or erasure path for plaintext clinical text in `agent_messages` (§7.5) | PHI accumulates indefinitely with no purge and no subject-erasure capability — a compliance gap, not just a hygiene one | Configurable retention + scheduled purge + real per-conversation delete | 2 (delete) / 5 (retention) |
| **M3** | Medium → High under RAG | `clinic_faq` has no authenticated write policy and is staff-authored, service-role-written, and model-consumed (§7.6) | Becomes a persistent staff-side injection primitive into the staff Assistant's context once embedded | Sanitize before indexing; stamp `untrusted_tenant_text` provenance; add retrieved-chunk injection cases to the eval corpus | 3–4 |
| **M4** | Medium | Contextual launchers all resume the single global thread (§3.5, S1) | Opening the Assistant from the revenue page silently continues an unrelated prior conversation — confusing, and it pollutes model context with irrelevant history | Context-matched thread selection; launchers seed a fresh thread stamped with `context_kind` | 2 |
| **M5** | Medium | Tool-invocation parts are dropped on persist (`toUiMessages`, `conversations.ts:44`) | Reloading a conversation erases the record of what the Assistant actually did — the audit trail exists in `audit_logs` but the user-facing one does not | Persist `parts jsonb`; rehydrate `ToolActivity` | 2 |
| **L1** | Low | `auth_clinic_id()` / `auth_role()` granted execute to `anon` (`20260504000000:670`) | No direct leak (both return null unauthenticated), but unnecessary surface on `security definer` functions | Revoke from `anon` | 5 |
| **L2** | Low | No markdown rendering in `MessageBubble` (`assistant-chat.tsx:687`) | Model replies with tables or lists render as literal syntax | Add a sanitized markdown renderer | Follow-up |
| **L3** | Low | No command palette or global keyboard shortcut; `cmdk` present but unused for this | Assistant is reachable only by clicking nav or a page-level launcher | Optional Cmd+K entry point | Follow-up |

---

AUDIT COMPLETE — IMPLEMENTATION NOT STARTED
