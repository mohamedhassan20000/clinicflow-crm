# P4B Implementation Report

**Execution sub-phase:** P4B — Staff assistant UI  
**Date:** 2026-07-18  
**Status:** Complete and ready for review

## Overview

P4B completes the staff-facing surface for the read-only doctor assistant built in P4A. It adds a streamed AI SDK route, a bilingual assistant workspace, and a patient-scoped Sheet launcher while preserving the existing P4A authorization, redaction, audit, entitlement, usage-cap, and read-only tool boundaries.

The implementation intentionally accepts only the current user message from the browser. Conversation history is loaded on the server through the authenticated, RLS-respecting Supabase client, and conversation identifiers are checked against the current clinic, user, persona, status, and patient context before reuse. The model is constructed exclusively from the four P4A doctor tools; P4B adds no tools and makes no authorization-policy changes.

The assistant surface is available only to Admin and Doctor roles. Clinics without the `ai_assistant` entitlement receive an upgrade gate, inactive subscriptions receive a subscription gate, exhausted clinics receive a cap-reached state, and entitlement/usage lookup failures fail closed with a temporary-unavailability state. The API independently repeats role, entitlement, subscription, rate-limit, and usage-cap checks before invoking the model.

Model, tool-stream, route, and persistence failures are converted to safe localized UI responses and captured in Sentry without message content, tool payloads, or patient data. Completed turns are persisted in the P4A conversation tables and counted against the existing clinic AI usage cap. Client cancellation stops generation and does not persist or count the cancelled turn.

## Files changed

### Assistant route and server integration

- `app/api/agent/chat/route.ts` — authenticated streaming route, strict compact request validation, rate/usage checks, server-owned history, safe errors, Sentry capture, persistence, and usage accounting.
- `lib/ai/doctor-agent.ts` — P4A doctor prompt/tool assembly through AI SDK `ToolLoopAgent`, including the typed UI message contract.
- `lib/ai/conversations.ts` — owner-scoped conversation lookup, patient-context validation, history loading, creation, and completed-turn persistence through the RLS client.
- `lib/ai/surface.ts` — server-side entitlement, subscription, usage-cap, and degradation-state resolver for assistant surfaces.

### Staff and patient UI

- `app/(protected)/assistant/page.tsx` — Admin/Doctor assistant page with server-side access resolution and latest-conversation resume.
- `app/(protected)/assistant/loading.tsx` — assistant-page loading state.
- `components/assistant/assistant-chat.tsx` — bilingual streaming `useChat` client, current AI SDK message-part rendering, safe tool activity, prompt suggestions, cancellation, new-chat handling, and graceful error UX.
- `components/assistant/assistant-access-gate.tsx` — upgrade, cap, inactive-subscription, and temporary-unavailability states.
- `components/assistant/patient-assistant-launcher.tsx` — patient-context Sheet launcher and gated assistant content.
- `app/(protected)/patients/[id]/page.tsx` — authorized assistant launcher integration with parallel access/conversation loading.

### Navigation, permissions, and localization

- `lib/page-permissions.ts` — new `assistant` `PageSlug`, Admin/Doctor defaults, and `/assistant` mapping.
- `lib/supabase/middleware.ts` — `/assistant` protected-route registration.
- `components/layout/sidebar.tsx` — assistant navigation icon.
- `messages/en.json` — English navigation, assistant, access, error, and tool-status copy.
- `messages/ar.json` — equivalent Arabic/RTL copy.

### Dependencies and tests

- `package.json` — added the React binding for the installed AI SDK and aligned the AI SDK patch version.
- `pnpm-lock.yaml` — dependency lock update.
- `tests/unit/api/p4b-chat-route.test.ts` — route denial, validation, degradation, streaming, persistence, and usage-accounting coverage.
- `tests/unit/ai/p4b-surface-access.test.ts` — upgrade, cap, and available access-state coverage.
- `tests/unit/components/p4b-assistant-chat.test.tsx` — streamed message rendering and patient-context UI coverage.
- `tests/unit/lib/dashboard-navigation.test.ts` — Admin/Doctor assistant navigation and role-blocked navigation coverage.
- `tests/e2e/p4b-assistant.spec.ts` — real staff login/entitlement flow with a mocked model stream, plus the patient-profile Sheet launcher.

## Database changes (if any)

None. P4B uses the `agent_conversations`, `agent_messages`, usage-counter, entitlement, and RLS infrastructure delivered by P4A. No migration, policy, RPC, enum, or generated database type was added or changed for P4B.

## Tests added/updated

- Added API-route tests proving unauthenticated, role-blocked, non-entitled, inactive-subscription, cap-exhausted, malformed, and rate-limited requests fail safely before model execution.
- Added the successful streaming-route test, including server-owned conversation assembly, completed-turn persistence, and usage accounting.
- Added access-state unit coverage for upgrade, cap-reached, and available states.
- Added assistant component tests for the current AI SDK message-parts stream and patient-scoped presentation.
- Updated dashboard-navigation tests to prove only Admin and Doctor roles receive the new gated page.
- Added the required Playwright staff-chat happy path with a deterministic mocked model stream and a real local Supabase user, subscription, clinic, and patient.
- Re-ran the P4A live-RLS suite to verify P4B continues to rely on the reviewed P4A tool and conversation boundaries.

## Validation performed

- `pnpm build` — passed; production compilation, TypeScript validation, and route generation completed with `/assistant` and `/api/agent/chat` present.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with zero errors; 25 pre-existing repository warnings remain outside P4B.
- `pnpm lint:rtl` — passed (369 files, 10 documented exceptions).
- `pnpm lint:i18n` — passed (292 files, 14 documented exceptions).
- `pnpm i18n:missing` — passed (2,568 base leaf messages; Arabic/English parity preserved).
- `pnpm i18n:unused` — passed.
- `pnpm test` — passed: 154 test files, 855 tests.
- Focused P4B unit suite — passed: 4 files, 19 tests.
- Relevant middleware/navigation suite — passed: 3 files, 45 tests.
- Live local-Supabase P4A RLS suite — passed: 1 file, 15 tests.
- P4B Playwright acceptance — passed: 1 Chromium test exercising login, streamed chat, and patient Sheet context.
- `git diff --check` — passed.
- React quality review — completed for component structure, hook dependencies, message-part rendering, serializable server/client boundaries, keyboard/accessibility behavior, and streaming-scroll performance; no P4B blocker found.

All LLM responses are mocked in automated tests in accordance with the roadmap. No patient or clinic content was sent to an external model during validation.

## Known limitations (if any)

- Production model calls require the P4A AI Gateway credentials/configuration and the roadmap-required DPA/zero-data-retention posture before real clinical data is enabled. Automated tests intentionally mock the model.
- The UI resumes the latest general conversation and the latest conversation for each patient, and supports starting a new conversation. A historical conversation browser/archive is not part of P4B.
- Stored chat history contains the textual user and assistant messages. Tool calls remain in the existing audited P4A path and are shown as safe generic activity during the live stream; raw tool inputs/outputs are never exposed in the chat UI.
- The assistant remains strictly read-only. Patient-facing AI, booking mutations, and all other write tools belong to P5 and were not implemented.
