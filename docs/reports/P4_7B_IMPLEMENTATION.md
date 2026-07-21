# P4.7B — Capability Panel & Guidance UX

**Date:** 2026-07-21
**Branch:** `feat/p47b-capability-panel`
**Status:** Implemented; comprehensive-review fixes applied, pending focused re-review.
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.7 execution split, sub-phase P4.7B.
**Companion planning:** `docs/AI_AGENT_PLAN.md` §8 "P4.7 — System Knowledge, Guidance & Capability Transparency".
**Depends on:** P4B (assistant surface), P4.5A (task registry), P4.6A (declarative tool registry + `capabilityDescription` metadata), P4.6B (`resolveAssistantCapabilities` surface resolution), P4.7A (help/navigation tools + `staff_help` class).

---

## 1. Scope delivered

Everything in the roadmap's P4.7B *in-scope* list, and nothing outside it.

| Deliverable | Where |
|---|---|
| `list_my_capabilities` tool (server-resolved, no clinic data) | `lib/ai/tools/list-my-capabilities.ts` |
| Registered deny-by-default on the P4.6A registry, in every task class | `lib/ai/tools/registry.ts` |
| Dynamic capability generation from the registry's `capabilityDescription` | `lib/ai/capabilities.ts` (`AssistantCapabilityItem`, `items`) |
| Permission-aware capability presentation (role, entitlement, per-user grant) | authorized union from shared `resolveToolMount` resolution |
| Capability panel in the assistant UI (always-accessible, grouped, ar/en) | `components/assistant/capability-panel.tsx`, wired into `assistant-chat.tsx` |
| Server-side locale plumbed so descriptions render in the user's language | `lib/ai/surface.ts`, `app/(protected)/assistant/page.tsx` |
| Presentation metadata + ar/en labels for the new tool and the panel chrome | `lib/ai/tool-presentation.ts`, `messages/{en,ar}.json` |
| Union/subset authorization, permission, localization, audit, UI, and link tests | `tests/unit/ai/p47b-capability-panel.test.ts`, `tests/unit/components/p46b-assistant-analytics-ui.test.tsx` |

**Out of scope and not built:** new standalone help pages (roadmap *Out*); any RLS or P4.6/§6.8 role-matrix change; a new entitlement key (the panel and tool ride on `ai.staff_assistant` like every other assistant capability); anything from P4.8 or later. P4.7B now renders cited articles and safe destination links directly from structured tool output. No migration, no PHI: `list_my_capabilities` reads registry metadata resolved against the caller's own entitlements/permissions, never a tenant table.

---

## 2. One registry resolver, authorized union plus active subsets

The authoritative P4.7 contract is the cross-task capability union requested during comprehensive remediation: the panel and `list_my_capabilities` show everything the user is authorized to ask across task classes supported for their role. They do not claim that every capability is mounted in the current turn.

That is enforced structurally. `STAFF_TASK_CLASSES_BY_ROLE` declares only the certified classes the router can select for each staff role. `resolveToolMount(ctx)` behaves in two explicit modes:

- with `taskClass`, it resolves the narrower active-turn mount and rejects unsupported role/class pairings;
- without `taskClass`, it resolves the exact authorized set union across the role's supported classes.

`resolveAssistantCapabilities` maps the unscoped union's definitions into localized/grouped items. The panel receives those items and `list_my_capabilities` resolves the same union at execution time. Tests assert panel = tool = authorized union; every supported task-class mount is a subset; and the set union of all active mounts equals the displayed union exactly. This proves both that no authorized cross-turn capability is omitted and that no unauthorized capability appears.

---

## 3. `list_my_capabilities` — a data-free meta tool

`lib/ai/tools/list-my-capabilities.ts` mounts for **every** staff role under `ai.staff_assistant` alone (no analytics feature), in **every** task class (`HELP_TASKS`), exactly like the P4.7A help tools — "what can I ask you?" is a fair question in any turn and from any role. It:

- re-asserts `assertStaffToolAccess` on every invocation (an admin can hide the assistant or a subscription can lapse mid-conversation), so `harden()` converts a mid-session revocation into the standard structured denial (`permission_denied: page_hidden`) rather than a leaked capability list;
- reads **no clinic table** — its answer is `resolveAssistantCapabilities`, i.e. registry metadata resolved against this caller's entitlements and per-user permissions — so it audits via `logAgentTool` with `tableName: null` and records only a `capability_count`, never the descriptions themselves (they are static, non-PII product copy already in the model's context);
- returns `capability_only: true` plus `capability_scope: "authorized_task_class_union"`, so the model treats the list as complete without implying that every listed tool is mounted in the current turn.

**The `staff_help` containment property is preserved.** P4.7A made `staff_help` the first genuinely narrower mount — help tools only, no tool that reads clinic data. `list_my_capabilities` joins that class, and it too reads no clinic-data table, so the property the class exists to guarantee is unchanged. The mount test asserts exactly the three data-free P4.7 tools and re-states the containment invariant explicitly.

### One initialization subtlety worth recording

`list_my_capabilities` is listed in the registry, and its natural implementation calls `resolveAssistantCapabilities`, which depends on the tools index, which depends on the registry — a static import would close that cycle and race the tools index's own top-level `DOCTOR_TOOL_NAMES` initialization (it did, and one existing registry-integrity test caught it immediately with `AI_TOOL_REGISTRY` undefined). The fix is a **lazy `await import("@/lib/ai/capabilities")` inside `execute`**: the shared resolution is still the single source of truth, but it loads at call time after all modules are initialized, so no static cycle exists. This is the standard cycle-break and is commented at the call site.

---

## 4. Dynamic, grouped, localized capability generation

`lib/ai/capabilities.ts` gains `AssistantCapabilityItem` (`{ name, group, description }`) and produces `items` from the resolved authorized union:

- **`description`** is the registry's own `capabilityDescription[locale]` — the *same wording placed in the model's context when the tool mounts* — so the panel and the model describe a capability identically, from one place. No new i18n keys per capability; adding a tool to the registry adds it to the panel automatically.
- **`group`** reuses the P4.6B presentation grouping (`clinical` / `operational` / `financial` / `guidance`) the chat already renders tool activity with, so a financial capability reads as financial in the panel (amber, "Finance" heading) just as a financial result does.
- **Order** is group-then-registry: `clinical → operational → financial → guidance`, guidance last because "how to use the app" and "what can I ask" frame the rest rather than being clinic work. Stable across requests (asserted).

The mapper is defensive about a missing `capabilityDescription` (empty string, not a throw), which only matters on the degrade paths and the synthetic mounts some P4.6B tests force — a resolution failure must degrade the panel, never break the chat, exactly as P4.6B already guaranteed for the boolean capability flags.

Locale is now threaded server-side: `resolveStaffAssistantPage(user, locale)` ← `getLocale()` in the page, mapped to the `PromptLocale` the mount already takes. The default remains `"en"`, so existing callers and tests are unaffected.

---

## 5. The capability panel UI

`components/assistant/capability-panel.tsx` is an always-accessible, collapsible section of the assistant surface, opened from a **"What can I ask?"** toggle in the chat header (`aria-expanded`/`aria-controls`, a labelled close button, `useId` wiring, and focus restoration to the trigger on close). It renders **only** its server-resolved authorized-union `items`, grouped with localized headings and per-group icons; when `items` is empty it says so honestly rather than inventing a generic list. The copy states that each turn uses only the subset needed for that question.

`ToolActivity` also consumes structured P4.7 output directly: `search_help.results[]` become localized article citations with same-origin deep links only when the resolver returned one; unavailable articles remain cited but unlinked; `get_navigation_target` uses destination-specific “Open {section}” copy; and `run_clinic_report` alone uses “Open the full report.” This does not depend on model-authored Markdown.

The toggle appears only where a capability set exists to show — the assistant page — and is absent on the doctor patient sheet, which passes `capabilities: null` (its launcher resolution never resolves capabilities). It updates with role/entitlement/permission changes automatically because it is server-rendered from the live mount on every page load; there is no client cache and no code path that could show a capability the user lost.

Presentation is theme-aware and RTL-safe (logical properties throughout; the RTL and i18n-strings gates pass).

---

## 6. Tests

The server and component suites cover the capability contract and presentation directly.

- **Mount & gating:** `list_my_capabilities` mounts for every staff role; absent without `ai_assistant`; present in the `staff_help` class (answerable in every class).
- **The union/subset invariant (headline):** panel/tool names equal the unscoped authorized union; every supported active mount is a subset; their set union is exact; an unsupported role/class pair mounts nothing; `capability_only` and `capability_scope` markers are present.
- **Permission awareness through the shared resolution:** entitled+granted admin gets the financial capabilities (grouped `financial`); a manager without the per-user grant does not, but keeps operational; a receptionist never sees financial or clinic-analytics capabilities; a doctor sees only clinical + guidance groups; a clinic without `ai.staff_analytics` loses the analytics/financial surface but keeps the base assistant (patient lookup, help, capability transparency).
- **Localization / ordering / audit:** Arabic descriptions returned under an Arabic session locale; items ordered clinical→operational→financial→guidance; the call audits a `capability_count` with `tableName: null`; a mid-session hidden assistant page yields the structured `page_hidden` denial rather than a leaked list.
- **Direct UI/accessibility:** open/close, `aria-expanded`/`aria-controls`, group headings, Arabic item text, empty state, long-list scrolling, close-button focus restoration, cited Arabic help article + working link, hidden article without link, and report-vs-navigation link copy.

**Validation:** the original P4.7B baseline was typecheck/lint/i18n/build clean. The post-remediation full validation and current counts are recorded in `docs/reports/P4_7_COMPREHENSIVE_FIXES.md`.

---

## 7. Notes for reviewers and later phases

- **Capability discovery grants nothing.** The panel and tool are display/answer data derived from registry authorization; every active tool still re-asserts role, entitlement, permission, and RLS inside `execute()`, and the chat route denies independently of anything shown. A forged/stale panel cannot return data — it returns descriptions.
- **Adding a future tool needs no panel work.** A registry entry with a `capabilityDescription`, presentation group, and supported task class appears in the authorized union automatically when the caller passes its gates; the exact-union test guarantees the panel/tool cannot acquire an independent capability.
- **`staff_help` is now three data-free tools**, still with no clinic-data tool — the containment property P4.7A introduced is intact and re-asserted.
- The `staff_help` route continues to answer `list_my_capabilities` on the cheap Haiku tier when a turn routes there; because the tool is additive in every class, a turn that routed elsewhere still answers correctly, only on a roomier budget — the same one-directional cost trade-off P4.7A documented for help.
