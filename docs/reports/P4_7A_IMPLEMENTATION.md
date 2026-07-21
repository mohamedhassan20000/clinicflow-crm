# P4.7A — System Knowledge, Guidance & Navigation Tools

**Date:** 2026-07-21
**Branch:** `feat/p47a-system-knowledge`
**Status:** Implemented. No UI (P4.7B owns the capability panel and help-answer presentation).
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.7 execution split, sub-phase P4.7A.
**Companion planning:** `docs/AI_AGENT_PLAN.md` §8 "P4.7 — System Knowledge, Guidance & Capability Transparency".
**Depends on:** P4B (assistant surface), P4.5A (task registry), P4.6A (declarative tool registry), P4.6C (entity-search normalizer, reused for retrieval).

---

## 1. Scope delivered

Everything in the roadmap's P4.7A *in-scope* list, and nothing outside it.

| Deliverable | Where |
|---|---|
| Curated bilingual (ar/en) in-repo help corpus + authoring convention | `lib/ai/help/corpus.ts` (19 articles) |
| Navigation registry over `PageSlug`/`user_page_permissions` | `lib/ai/help/navigation.ts` (31 targets) |
| Permission-aware resolution (role + primary-admin authority + entitlement + page visibility) | `resolveNavigationTarget` / `resolveNavigationTargets` |
| Deterministic ar/en help retrieval | `lib/ai/help/search.ts` |
| `search_help` tool | `lib/ai/tools/search-help.ts` |
| `get_navigation_target` tool | `lib/ai/tools/get-navigation-target.ts` |
| Both tools registered deny-by-default on the P4.6A registry | `lib/ai/tools/registry.ts` |
| `staff_help` certified task class (cheap Haiku route) | `lib/ai/platform/types.ts`, `registry.ts`, `execution.ts` |
| Product-knowledge honesty clause (both personas) | `lib/ai/prompts/help.ts`, `lib/ai/prompts/staff.ts` |
| Presentation metadata for the two tools (`guidance` group) | `lib/ai/tool-presentation.ts`, `messages/{en,ar}.json` |
| Authorization / localization / retrieval / honesty/adversarial tests | `tests/unit/ai/p47a-*.test.ts` |

**Out of scope and not built:** any UI (the capability panel and the cited-article/deep-link answer
presentation are P4.7B); `list_my_capabilities` (P4.7B); auto-generated docs; a public docs site;
agentic "do it for me" control; patient-facing help (P5). No new entitlement key — help rides on
`ai.staff_assistant` (`ai_assistant`) exactly as the roadmap specifies. No new RLS surface, no
migration, no PHI: the corpus is static product documentation.

---

## 2. The help corpus and its authoring convention

`lib/ai/help/corpus.ts` holds 19 curated articles, each with full ar/en parity (title, summary,
prerequisites, ordered steps, notes, keywords). The single rule that makes the corpus worth having is
enforced structurally as well as documented: **an article may only describe behavior that exists.**
Every article was written against the actual route, its actual role guard, and the actual UI copy in
`messages/*.json` — the invoicing steps, the follow-up outcomes ("All fine / Reported a problem / No
response / Note taken"), the WhatsApp 24-hour service window, the "up to 2 shifts per day" working
hours, the primary-admin-only page-visibility toggle, manager staff-creation limits, and the split
between page search and Assistant ranked search — not from a generic idea of what a clinic system does.

Each article declares:

- `navigationTarget` — the destination it teaches, which is what turns an answer into a working deep
  link **and** what makes it honest: the steps and link are only served when that target resolves as
  `available` for the asking user.
- `roles` — deny-by-default; asserted by test to be a subset of the navigation target's roles.
- `requiredFeatures` / `requiredUserPermission` — a workflow belonging to a gated sub-capability
  (for example, the WhatsApp Inbox) or a premium capability (financial insights) the clinic/user
  lacks is not described at all. The general Messaging page/reminder article is deliberately not
  WhatsApp-gated because email reminders/follow-ups remain usable without WhatsApp.

The maintenance rule (roadmap acceptance) stands: every phase changing a user-facing surface updates
its articles. Two tests back it up so drift is caught mechanically, not only by discipline.

---

## 3. The navigation registry and permission-aware resolution

`lib/ai/help/navigation.ts` declares 31 targets across the tenant app. **It is not an authorization
source** — it is a map of destinations plus each one's *declared* preconditions, and every decision is
re-derived at resolution time from the same machinery the shell and middleware use:

1. `ROLE_PAGE_SLUGS` (the page-level matrix) **and** the target's own role list (mirroring the route's
   `requireRole` / role redirect) — both must admit the caller; neither is trusted to be a superset of
   the other.
2. `isPrimaryClinicAdmin` for AI and Customize settings, matching those surfaces' oldest-active-admin
   authority rule. Secondary admins receive no route or actionable steps.
3. Plan entitlements + `subscriptionAllowed` for targets behind a real module (for example Inbox →
   `whatsapp`, AI settings → `ai_assistant`). Messaging itself is not WhatsApp-gated.
4. `getPageVisibilityState` over `user_page_permissions` — the per-user admin toggle.

The verdict is one of six statuses, kept distinct because they send the user to different people:
`available`, `role_forbidden`, `primary_admin_required`, `not_entitled`, `hidden_by_admin`,
`lookup_failed`. **`href` is present
only on `available`** — a route the caller cannot open never enters model context, so the assistant
cannot offer a link that would 404, redirect, or reveal a hidden surface. The section name (breadcrumb)
is returned on every status, which is what lets the answer be honest and specific: *"that lives under
Settings → Messaging, but it isn't enabled for your account — ask your administrator."* A failed
visibility lookup **fails closed** (`lookup_failed`, no link).

The single- and batch-target paths are one function (`resolveOne`) with shared visibility and
primary-admin readers injected — deliberately, so there is never a second copy of an authorization
decision to drift. The batch path (used by `search_help`) resolves page visibility once per distinct
`PageSlug` and primary-admin authority once per search.

A registry-integrity test caught a real inconsistency during implementation: two targets initially
listed `manager`, whose role matrix excludes the `patients`/`appointments` pages. The declarations were
corrected to mirror `ROLE_PAGE_SLUGS`. (The resolver would have denied them anyway via gate 1; the fix
keeps the declaration honest.)

---

## 4. Deterministic retrieval (`search_help`)

`lib/ai/help/search.ts` scores the query against each article's title/keywords/summary/body in **both**
locales, reusing the P4.6C Arabic/English normalizer and transliteration so a question typed with
diacritics, alef/taa-marbuta variants, Arabic-Indic digits, or in Latin transliteration reaches the
canonical article. There is no embedding model on purpose: a few dozen curated articles make exact
normalized-token scoring both sufficient and *auditable* — a test can assert query → article, which is
what keeps the phase's central promise ("answer only from the corpus") verifiable.

Two guards against confident-but-wrong retrieval:

- **Stop tokens** are stripped before transliteration. An all-stopword query ("how do I") transliterates
  to nothing and returns no results, rather than matching Arabic keywords by accident.
- **A minimum-score floor** (`WEIGHT_BODY + WEIGHT_SUMMARY`) means a single incidental body word — "email
  the report to the ministry" grazing the invoicing article's "deliver by email" — does not surface an
  article as an answer. A real query lands on a curated keyword or the title, which clears the floor.

The four article filters are the security core. Three remove an article **without a trace** — role,
unentitled module, missing per-user permission — because naming a surface the caller can never reach
discloses the shape of other roles' functionality to no useful end. Admin-hidden pages and
primary-admin-only workflows requested by a secondary admin are deliberately **not** silent: the
article is returned with its section but with **no steps and no link**, plus model-facing guidance to
name where the feature lives and who can handle it. That honest unavailable answer is the phase's
headline acceptance criterion.

---

## 5. The tools

Both tools re-assert `assertStaffToolAccess` on every invocation (an admin can hide the assistant or a
subscription can lapse mid-conversation), audit each call via the existing `logAgentTool` ledger
(`tableName: null` — neither reads a database table), and carry model-facing `guidance` that is
exhaustively enumerated so adding a status/reason is a compile error rather than a vague fall-through.

- **`search_help(query, limit?)`** returns curated results plus a `corpus_only` marker and, on empty,
  explicit `no_results_guidance` telling the model to decline rather than invent. Audited article ids are
  joined into a string (the audit summariser drops arrays; the ids are static non-PII slugs that belong in
  the ledger). The raw query is not logged.
- **`get_navigation_target(target)`** takes a closed enum of registered ids — not an arbitrary path, so
  the model cannot probe — and returns `status`, `section`, `label`, `guidance`, and `link` (only when
  available).

`search_help` is the only assistant tool answering from something other than the clinic database, and the
only one whose source is trusted (curated, PR-reviewed, no tenant data). The `harden()` untrusted-text
pass at the mount boundary still runs over its results, harmlessly.

---

## 6. The `staff_help` task class — the gate is now load-bearing

P4.6A's registry recorded caveat M6: the task-class gate was *enforced* but excluded nothing, because
every tool declared both administrative classes. **P4.7A is the first genuinely narrower class.**

Only the three data-free P4.7 tools include the `staff_help` task class, so a help turn mounts
**exactly** `search_help`, `get_navigation_target`, and `list_my_capabilities` — no tool that reads
clinic data exists in it. That
containment is now a real, tested property on real data (not a synthetic mount), and it is what makes the
class safe to route to a cheaper model: the budget is small because the reachable work is small.

- **Route:** a distinct `staff-haiku-bootstrap-v1` alias (same Haiku tier as the patient route, but
  separately certifiable/rollback-able; a shared alias would let a patient-side model change silently
  retarget staff help). It ignores the `AI_MODEL_DOCTOR`/`AI_MODEL_PATIENT` legacy overrides, which exist
  only to preserve pre-P4.5 pinned choices the help class never had.
- **Policy:** `maxSteps 4`, `maxOutputTokens 700` — tighter than administrative (`8`/`1500`). Both staff
  personas allowed.
- **Router:** `isHelpIntent` (deterministic, keyword-based like the operational router) routes "how do
  I…" / "where is…" / "كيف أ…" / "أين أجد…" turns to `staff_help` **before** the persona split, so a
  doctor's how-to question is answered on the cheap route too. It defers to an *aggregation/list* matcher
  (narrower than the full operational matcher) so "how many invoices are outstanding" keeps its data
  tools while "how do I issue an invoice" becomes help. Help tools are additive in every other class, so a
  misrouted intent never costs the user the answer — only, at worst, a little budget.

Two accepted keyword-router trade-offs follow from that guard, both of which touch budget only and never
authorization or correctness (help stays additive everywhere, and a `staff_help` turn genuinely reaches
no data tool):

- **The guard does not catch every data false-positive.** It filters *aggregation/list* phrasings, not a
  singular-entity data request worded with a help opener. "how do I see patient X's appointments" or "how
  do I find a patient with diabetes" route to `staff_help`, whose mount excludes data tools, so that turn
  answers with guidance rather than the record. Both readings are legitimate for that phrasing, and the
  user recovers the data by rephrasing to "show me …" (which the `show me (?!how)` branch keeps on the
  data class) — so the cost is at most one extra turn, never a wrong or unauthorized answer.
- **The guard also blocks some genuine help questions from the cheap route.** A bare "report"/"list"
  (and Arabic "تقرير"/"قائمة") in the guard means "how do I run a report" — which *has* a dedicated
  `run-clinic-report` article — falls to the pricier administrative/operational class instead of
  `staff_help`. It is still answered correctly (help tools are mounted there too); it just does not get
  the cheap route the class exists to provide.

The conversion is one-directional and safe: a missed help turn answers correctly on a roomier budget, and
a help false-positive still answers within its authorized (help-only) surface for that turn. What the
guard does *not* promise is that every ambiguous "how do I <verb> <entity>" lands on the class its author
had in mind — a keyword router cannot, and the additive mount is what makes that acceptable.

---

## 7. Prompt & presentation

- `lib/ai/prompts/help.ts` adds a product-knowledge clause appended to **both** staff personas: answer
  ClinicFlow-usage questions only from `search_help`, never from the model's knowledge of similar
  software; use `get_navigation_target` before directing anyone; be honest and specific when a page is not
  available. Prompting is the weakest of the three defenses (retrieval-only source and link-gating are the
  structural ones) and is here for completeness — a model that ignores it still cannot obtain a link to a
  page the user may not see.
- `lib/ai/tool-presentation.ts` gains a `guidance` group and label keys `toolSearchHelp` / `toolNavigation`
  (ar/en) so a documentation lookup never renders as "reviewing records". This is presentation metadata
  (label + non-financial group), not UI — the P4.7B chat surface consumes it.

---

## 8. Tests

The P4.7A tests span three files, plus affected registry/mount/presentation suites.

- `tests/unit/ai/p47a-navigation-registry.test.ts` — registry integrity (every `pageSlug` real;
  every role a subset of the page matrix; ar/en labels present), and resolution across all six statuses:
  link only when reachable, no href on any denial, hidden-page and secondary-admin honesty,
  fail-closed on lookup failure, Messaging-without-WhatsApp availability, unknown id → denial,
  Arabic localization, and shared visibility/primary-admin reads.
- `tests/unit/ai/p47a-help-search.test.ts` — ar/en retrieval to the right article; cross-script
  matching; no spurious match for uncovered questions; role/entitlement/permission silent removal;
  admin-hidden page returns location without steps/link.
- `tests/unit/ai/p47a-help-tools.test.ts` — deny-by-default mount; **the `staff_help` mount is
  exactly the three data-free P4.7 tools**; help tools additive in clinical/operational turns; tool execution +
  audit; task-class routing (en/ar/doctor, aggregation-guard, cheaper-policy assertions); corpus↔registry
  integrity (role subset, ar/en step-count parity, unique ids), closed navigation schema, and
  deterministic ar/en instruction-injection fixtures.
- Updated: `p4a-doctor-tools`, `p46a-staff-analytics-tools`, `p46b-tool-presentation`, `p45a-platform`
  (route count + bootstrap-status assertion) for the two new tools and the third certified route.

**Validation:** the original P4.7A baseline was typecheck/lint/i18n/build clean. The current
post-remediation counts and full validation are recorded in
`docs/reports/P4_7_COMPREHENSIVE_FIXES.md`.

---

## 9. Notes for P4.7B and later

- `list_my_capabilities` and the capability panel are P4.7B. The `capabilityDescription` metadata the
  panel will read is already present on both new registry entries.
- The corpus is intentionally small and shipped-surface-complete, not exhaustive. Adding an article is one
  entry in `corpus.ts` (+ a navigation target if the destination is new); the integrity tests enforce the
  invariants automatically.
- The `staff_help` route carries a `bootstrap_approved` certification with rollback to
  `staff-sonnet-bootstrap-v1`; formal scored ar/en evaluation of the help class remains P6A, as for every
  other route.
