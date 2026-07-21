# P4.7 Comprehensive Phase Review — Implementation of Fixes

**Phase:** P4.7 (P4.7A + P4.7B)
**Input:** `docs/reviews/P4.7_COMPREHENSIVE_REVIEW.md` (2026-07-21)
**Date:** 2026-07-21
**Scope:** P47-M1 through P47-M5 and P47-L1 through P47-L3. The capability-union behavior required by the remediation brief is preserved. The review report was not modified, and P4.8A was not started.

No migration or RLS change was required. The fixes affect navigation/help authorization resolution, static corpus accuracy, capability-contract definition and tests, structured help presentation, accessibility coverage, and roadmap/report accuracy.

---

## 1. Summary

All eight findings are addressed and the full executable validation available in this environment is green. P4.7 is ready for focused re-review; this report does not self-approve the phase or advance the roadmap to P4.8A.

| Severity | Findings | Outcome |
|---|---|---|
| Medium | P47-M1–P47-M5 | Fixed |
| Low | P47-L1–P47-L3 | Fixed |

The security boundary remains unchanged: help content is static and contains no tenant data; `staff_help` still mounts exactly three data-free P4.7 tools; capability discovery returns registry metadata rather than PHI/clinic records; active tools still re-authorize inside `execute()` and continue to rely on the existing clinic/RLS boundaries.

---

## 2. P47-M1 — primary-admin-only navigation is now modeled explicitly

`lib/ai/help/navigation.ts`, `lib/ai/help/search.ts`, `lib/ai/tools/get-navigation-target.ts`, `tests/unit/ai/p47a-{navigation-registry,help-search}.test.ts`

- Added `requiresPrimaryClinicAdmin` to navigation-target declarations and applied it to `settings_ai` and `settings_customize`, matching the real settings surfaces.
- Added the distinct `primary_admin_required` resolution status and exhaustive model guidance.
- Single-target resolution checks `isPrimaryClinicAdmin`; batch help resolution shares one primary-admin lookup across all protected articles.
- Authority-check failures fail closed as `lookup_failed`; secondary admins receive neither a route nor actionable steps.
- `search_help` names the protected workflow and its owning primary administrator, but returns empty steps/notes and no link.
- Added primary-admin and failure fixtures for both navigation and help retrieval.

`settings_ai` also declares the real Assistant entitlement precondition, so direct registry resolution mirrors both authority checks on that route.

---

## 3. P47-M2 — Messaging is no longer falsely WhatsApp-gated

`lib/ai/help/navigation.ts`, `lib/ai/help/corpus.ts`, `tests/unit/ai/p47a-{navigation-registry,help-search}.test.ts`

- Removed the WhatsApp feature requirement from the general `settings_messaging` destination and `configure-reminders` article.
- Kept WhatsApp-specific surfaces such as Inbox/reply guidance behind the WhatsApp feature.
- Rewrote both locales to state the real split: appointment reminders and overdue-invoice email settings remain usable without WhatsApp; WhatsApp delivery requires the feature and an active connection.
- Replaced the old false-denial fixture with paired tests proving Messaging stays available while WhatsApp-only destinations/articles remain unavailable.

---

## 4. P47-M3 — the cross-task authorized capability union is now the formal contract

`lib/ai/tools/{index,context,registry,list-my-capabilities}.ts`, `lib/ai/capabilities.ts`, `components/assistant/capability-panel.tsx`, `messages/{en,ar}.json`, `tests/unit/ai/p47b-capability-panel.test.ts`

The requested union behavior is preserved. The panel and `list_my_capabilities` show every capability the user is currently authorized to ask across supported staff task classes, not only the tools mounted for the current turn.

- Added `STAFF_TASK_CLASSES_BY_ROLE` / `staffTaskClassesForRole` as the certified router-reachable task-class scope for each staff role.
- `resolveToolMount` now has two explicit modes:
  - with `taskClass`: the narrower active-turn mount;
  - without `taskClass`: the exact authorized union across supported classes for the role.
- Unsupported role/task-class pairings fail closed with an empty mount.
- Both modes use the same registry role, feature, and per-user permission gates; no second capability matrix was introduced.
- `list_my_capabilities` now returns `capability_scope: "authorized_task_class_union"`, and its description explicitly warns that the current turn may mount only a subset.
- Panel copy in both locales explains the same cross-task-union/current-turn-subset contract.

The load-bearing test now checks every staff role and proves both directions:

1. every tool in every supported active task-class mount exists in the authorized union; and
2. the set union of those active mounts equals the displayed union exactly.

Therefore an unauthorized capability cannot appear, while an authorized cross-turn capability cannot be silently omitted.

---

## 5. P47-M4 — cited help and destination links are rendered from structured output

`lib/ai/tool-presentation.ts`, `components/assistant/assistant-chat.tsx`, `messages/{en,ar}.json`, `tests/unit/ai/p46b-tool-presentation.test.ts`, `tests/unit/components/p46b-assistant-analytics-ui.test.tsx`

- `summarizeToolResult` now receives the tool name, extracts safe citations from `search_help.results[]`, and preserves unavailable citations without inventing links.
- Every nested and top-level link passes the existing same-origin absolute-path sanitizer; external, protocol-relative, backslash, JavaScript, and malformed links remain rejected.
- `ToolActivity` renders the article title as a deterministic citation and a localized deep link only when structured output contains an authorized route.
- Navigation destinations use localized “Open {section}” copy. Only `run_clinic_report` uses “Open the full report.”
- The presentation no longer depends on model-authored Markdown becoming clickable.
- Component coverage includes the roadmap's Arabic receptionist invoice article/deep link, the hidden-page no-link case, and report-vs-navigation copy.

---

## 6. P47-M5 — help-corpus statements now match shipped behavior

`lib/ai/help/corpus.ts`, `tests/unit/ai/p47a-help-tools.test.ts`

Both locales were corrected and pinned by targeted contract assertions:

- `find-patient-file` now distinguishes the Patients page's stored-field/partial `ILIKE` search from the Assistant's ranked bilingual/fuzzy patient search.
- `add-staff-member` now states that managers may create doctor, receptionist, and manager accounts but may not create an administrator; primary-admin-only Customize control is stated separately.
- `ask-assistant-financial` now says managers need the per-user grant while administrators hold the permission implicitly.
- `configure-reminders` documents the real email/WhatsApp channel split described under P47-M2.

---

## 7. P47-L1 — deterministic adversarial fixtures added

`tests/unit/ai/p47a-help-tools.test.ts`

- English and Arabic instruction-injection prefixes remain routed to `staff_help` when the underlying request is a help question.
- The data-free help mount is still asserted as exactly `search_help`, `get_navigation_target`, and `list_my_capabilities`.
- An injected `search_help` query is treated as retrieval text, returns the curated invoicing article with `corpus_only: true`, and does not echo the injected instruction.
- The navigation tool's closed Zod enum rejects arbitrary paths such as `/operator/clinics` before execution.

These are deterministic router/tool-boundary fixtures. The later scored live-model adversarial program remains P6A scope.

---

## 8. P47-L2 — direct UI/accessibility coverage added

`components/assistant/assistant-chat.tsx`, `tests/unit/components/p46b-assistant-analytics-ui.test.tsx`, `tests/e2e/p4b-assistant.spec.ts`

- The close action now restores keyboard focus to the capability toggle.
- Component tests cover open/close state, `aria-expanded`/`aria-controls`, localized group headings, Arabic capability text, empty state, 30-item scrolling behavior, focus restoration, and destination-specific help/navigation/report links.
- The existing authenticated Assistant Playwright flow now expands the capability panel, runs WCAG 2A/2AA/2.1A/2.1AA Axe rules against the expanded panel, closes it, and verifies trigger focus restoration.

The component coverage executed successfully. The browser/Axe test is committed but could not execute in this environment because Playwright configuration requires the absent local Supabase publishable/secret keys; the runner stopped during configuration before starting a browser.

---

## 9. P47-L3 — roadmap and reports reconciled

`docs/AI_AGENT_PLAN.md`, `docs/reports/P4_7A_IMPLEMENTATION.md`, `docs/reports/P4_7B_IMPLEMENTATION.md`

- Removed the contradictory “implements none of P4.7” status.
- Recorded P4.7 as implemented with comprehensive fixes applied and pending focused re-review; P4.8A remains not started.
- Replaced active-turn parity language with the authorized-union/active-subset contract everywhere it was normative.
- Updated navigation, Messaging, primary-admin, three-tool help mount, structured citation/link, accessibility, and test descriptions.
- Left `docs/reviews/P4.7_COMPREHENSIVE_REVIEW.md` byte-for-byte unchanged.

---

## 10. Validation

| Check | Result |
|---|---|
| Targeted P4.7 + presentation/UI suites | ✅ 6 files, **129/129 tests** |
| Full non-integration unit suite (`pnpm test`) | ✅ **184 files, 1,259/1,259 tests** |
| Typecheck (`pnpm typecheck`) | ✅ clean |
| Full ESLint (`pnpm lint`) | ✅ 0 errors; 25 pre-existing warnings outside P4.7 |
| Changed-file ESLint | ✅ clean |
| RTL gate (`pnpm lint:rtl`) | ✅ 413 files; 10 documented exceptions |
| i18n string gate (`pnpm lint:i18n`) | ✅ 299 files; 14 documented exceptions |
| Message parity (`pnpm i18n:missing`) | ✅ 2,749 base leaves; locale variants valid |
| Unused message keys (`pnpm i18n:unused`) | ✅ none |
| Production build (`pnpm build`) | ✅ Next.js 16.2.6; 65 static pages generated |
| Diff whitespace (`git diff --check`) | ✅ clean before report creation; rechecked below |
| Integration suite (`pnpm test:integration`) | ⚠️ 23 suites stopped before collection because `LOCAL_SUPABASE_SECRET_KEY` / `LOCAL_SUPABASE_PUBLISHABLE_KEY` are absent |
| P4.7 browser/Axe flow | ⚠️ stopped during Playwright configuration for the same absent local Supabase keys |

The production build emits the repository's existing Next.js warning that the `middleware` convention is deprecated in favor of `proxy`; it is unrelated to P4.7.

No P4.7 change adds a tenant-data query, database policy, mutation, or new entitlement. No PHI or clinic data is added to the help corpus, capability payload, panel, citations, or audit metadata.
