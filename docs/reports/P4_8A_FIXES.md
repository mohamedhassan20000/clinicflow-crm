# P4.8A — Independent Review Fixes

**Date:** 2026-07-22  
**Branch:** `feat/p48a-ai-actions`  
**Source review:** `docs/reviews/P4.8A_REVIEW.md`  
**Scope:** Findings P48A-M1, P48A-L1, and P48A-L2 only. P4.8B remains unimplemented.

---

## 1. Outcome

All findings in the P4.8A independent review are remediated.

| Finding | Result | Remediation |
|---|---|---|
| P48A-M1 | Fixed | Closed launchers now resolve only lightweight visibility/entitlement/usage gates. Chat code, history, persistence reads, and capabilities load only after first Sheet open through an authenticated no-store route. |
| P48A-L1 | Fixed | The implementation report now records the actual branch, `feat/p48a-ai-actions`, and the final RTL scan count of 417 files. |
| P48A-L2 | Fixed | Direct coverage now exercises source-page fail-closed states, optional user permission, multi-feature gating, rendered P4.8A presence/absence, every P4.8B host surface, and unchanged future-context suggestions. |

## 2. Deferred launcher architecture

Page rendering calls `resolveAssistantLauncher`, which performs only the code-owned registry, role, Assistant/source-page visibility, subscription, required-feature, usage, and optional user-permission checks. It does not create a Supabase client for conversation storage, query `agent_conversations` or `agent_messages`, resolve tool-derived capabilities, generate a conversation ID, or serialize session data.

`AssistantLauncherEntry` sends only the strict page context, presentation-only label where applicable, and role into the launcher client. The label is never included in either the session or chat request context.

When the Sheet first opens, `AssistantLauncher` starts two operations in parallel:

1. a dynamic `import()` of `AssistantChat` and its AI SDK/tool-presentation dependencies;
2. an authenticated `POST /api/agent/launcher-session` request containing only the strict P4.8A context.

The request authenticates with `authorizeStaffAssistant`, independently parses the context, repeats the launcher gate, and uses private no-store responses. Patient sessions reselect the patient by authenticated clinic, reject non-doctors/deleted or unauthorized patients, and enforce assigned-doctor-or-department access before any conversation history is read. Conversation lookup remains owner, clinic, persona, status, and patient scoped. Non-patient capabilities still come from `resolveAssistantCapabilities`, which derives presentation data from the same registry resolver used for actual tool mounts.

Opening a launcher never reserves or bills an AI turn. Sending a message still uses the unchanged chat route, including authorization, rate limiting, task/persona classification, atomic execution reservation, provider policy, success/failure/abort reconciliation, conversation persistence, and the independently authorized/audited tool registry.

## 3. Performance evidence

The successful production build emits the Assistant Chat dependency set as three event-loaded chunks:

| Chunk set | Raw | Gzip |
|---|---:|---:|
| Dynamic Assistant Chat dependencies | 496,040 bytes | 120,039 bytes |

The launcher chunk contains only the dynamic loader reference; the dependency chunks load when the Sheet-open handler executes the import.

For page serialization, a deterministic dashboard fixture containing the maximum 40 history messages at 512 characters each measured:

| Launcher prop shape | JSON bytes |
|---|---:|
| Former eager session props | 23,708 |
| Current initial `{context, role}` props | 47 |
| Removed from fixture | 23,661 (99.8%) |

This fixture is a reproducible comparison rather than a claim about every production conversation size. The invariant is exact: initial launcher props now contain zero messages and zero capabilities.

## 4. Added regression coverage

- Closed Sheet: no session fetch and no chat render/import activation.
- Lightweight resolver: no conversation or capability resolver calls.
- First open: authenticated hydration, history, remaining usage, and capabilities returned with `private, no-store`.
- Patient first open: patient authorization completes before conversation history is read; a denial prevents the history read.
- Repeated gate: role, Assistant page, source page, subscription, feature, usage, persistence, and optional per-user permission remain fail closed.
- Generic branches: source-page `hidden`, source-page `lookup_failed`, multiple required features, and `requiredUserPermission` denial.
- Rendered server entries: authorized presence and unauthorized absence for patient, appointments, and dashboard.
- P4.8B absence: revenue page, reports page, invoice billing host, staff page, departments page, and doctor-schedule host contain no launcher wiring.
- P4.8B suggestions: revenue, reports, invoices, staff, departments, and doctor-schedule contexts retain the existing context-independent suggestions.
- Deferred UI: localized loading state and retryable fail-soft unavailable state.

## 5. Validation

| Check | Result |
|---|---|
| Focused P4.8A/P4B tests | Pass — 8 files, 81 tests |
| `pnpm test` | Pass — 190 files, 1,347 tests |
| `pnpm test:integration` | Pass — 23 files, 239 tests against local Supabase |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 existing repository warnings |
| `pnpm lint:i18n` | Pass — 301 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,757 base messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 417 files; 10 documented exceptions |
| `pnpm build` | Pass — Next.js 16.2.6; 66 pages generated |
| `git diff --check` | Pass |

The first integration invocation had no local Supabase keys exported. The sandboxed attempt to obtain them could not access the Docker socket. The approved local-stack rerun exported CLI-generated test variables without printing or storing secrets in the repository and passed the complete suite.

The production build reports only the repository's existing middleware-to-proxy deprecation notice.

## 6. Explicit exclusions

P4.8B was not started. No revenue, reports, invoice, staff, departments, or doctor-schedule launcher was added, and suggestions remain context-independent for those future variants. No P4.9 customization schema or settings were added. The independent review report was not modified.
