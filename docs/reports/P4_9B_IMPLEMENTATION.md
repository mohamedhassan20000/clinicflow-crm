# P4.9B — Assistant Customization Settings UI

**Date:** 2026-07-25  
**Branch:** `feat/p49a-agent-workflows`  
**Status:** Implemented; completes phase P4.9.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.9 execution split, sub-phase P4.9B.  
**Depends on:** Implemented P4.9A placement schema, RLS, entitlement, and server-side resolver.  
**Explicitly excluded:** P4.10 session memory, P4.11 workflows, and every later write-capable AI behavior.

---

## 1. Scope delivered

P4.9B adds the primary-admin settings surface that edits the P4.9A placement storage. It adds no new table, entitlement, tool, prompt, model policy, RPC, or resolution behavior — only the controls that write existing role/user placement rows and the read model that renders them.

| Deliverable | Where |
|---|---|
| Primary-admin settings page + upgrade gate | `app/(protected)/settings/assistant/page.tsx` |
| Area × role matrix + per-user override client editor | `components/settings/assistant-launcher-customizer.tsx` |
| Audited role/user placement mutation actions | `actions/assistant-launcher-settings.ts` |
| `server-only` non-PHI read model for the editor | `lib/ai/launcher-customization.ts` |
| Editor view types + role vocabulary | `lib/ai/launcher-customization-types.ts` |
| Settings navigation entry (admin-only) | `components/settings/settings-nav.tsx` |
| Localized settings copy (en/ar) | `messages/en.json`, `messages/ar.json` |
| Localized action-error copy (en/ar) | `messages/action-errors/en.json`, `messages/action-errors/ar.json` |

## 2. Settings surface and upgrade gate

`/settings/assistant` is a Server Component gated to the clinic's primary admin: `requireRole("admin")` then `isPrimaryClinicAdmin`, with a `/dashboard` redirect for any other admin. It resolves `ai.assistant_customization` through the existing entitlement chain and branches without ever loading placement data for an unentitled clinic:

- **Entitled:** loads the non-PHI read model and renders the editor. A read failure fails soft to a localized `role="alert"` notice; the JSX is constructed outside the fetch's `try`/`catch` so a render-time error is never swallowed.
- **Not entitled (`basic`/`pro`):** renders a non-mutating upgrade gate stating that product defaults remain active. No action, table read, or write is reachable from this branch.

The nav entry is `adminOnly` and points at `/settings/assistant`; secondary admins that reach the route directly are redirected before any data access.

## 3. Mutation actions

Two server actions in `actions/assistant-launcher-settings.ts` own all writes. Both share `requireCustomizationAdmin`, which enforces, in order: `requireMutationRole("admin")`, primary-admin identity, and the `ai.assistant_customization` entitlement — returning localized errors and writing nothing on any failure.

- `setAssistantRoleLauncherPlacement` — Zod-validates `{ area, role, enabled }` against the exact nine P4.8 areas and four roles, then rejects any role/area pair the launcher registry does not permit **before** authorization. `enabled: null` deletes the exact `(clinic_id, area, role)` row (reset to code default); a boolean upserts on the composite key with server-owned `clinic_id` and `updated_by`.
- `setAssistantUserLauncherOverride` — Zod-validates `{ area, userId, enabled }`, then resolves the target through the clinic-scoped read wrapper, requiring the target to be an active, non-deleted same-clinic profile whose role is registry-eligible for the area. `enabled: null` deletes the exact `(clinic_id, user_id, area)` override; a boolean upserts on the composite key.

Both actions perform the write through an authenticated primary-admin Supabase session (`createClient`), so P4.9A's RLS and the composite-key audit trigger execute with the real `auth.uid()`. The `clinic_id` and actor are always server-derived — never taken from client input — and `revalidatePath("/settings/assistant")` refreshes the surface after a successful write.

## 4. Read model

`getAssistantLauncherCustomization` is `server-only` and reads exactly three sources through the reviewed clinic-scoped admin wrapper: the role settings, the user overrides, and the active-staff directory (`admin`/`manager`/`receptionist`/`doctor`, active and not deleted). It builds the editor view entirely from the code-owned registry:

- every registry area is emitted with its `defaultEnabled` and `eligibleRoles`, so the matrix is always complete and driven by code, not by persisted rows;
- only persisted role choices whose role is registry-eligible for the area are surfaced; ineligible stored rows are ignored;
- per-user overrides are attached only when the staff member's current role remains eligible for the area, so a stale override for a since-changed role is not shown as active.

Any read failure throws and is caught by the page's fail-soft branch. The model reads no patient, appointment, invoice, conversation, prompt, message, usage, or billing data.

## 5. Editor UX

`AssistantLauncherCustomizer` is a client component with two tabs:

- **Role defaults** — an accessible area × role table. Cells for ineligible role/area pairs render an em dash with an accessible "not available for this role" label and expose no toggle. Eligible cells show a `Switch` reflecting the explicit choice or the code default, plus a Reset control that appears only when an explicit choice exists.
- **People** — a staff list plus a per-area override panel for the selected member, showing only areas eligible for that member's role. Each area shows whether it inherits the role setting (with the resolved shown/hidden state) or carries a personal override, and a "use role setting" reset appears only for explicit overrides.

Changes apply optimistically with a per-control pending indicator, roll back and surface the localized error on failure, and toast on success. Controls are disabled while any mutation is in flight to prevent overlapping writes. All labels, states, and captions are localized; the matrix scrolls horizontally inside its own container and the controls remain keyboard-operable in RTL.

## 6. Preserved platform guarantees

- **UI-visibility-only:** the surface writes only P4.9A placement rows. It offers no toggle for a role/area the registry does not permit, and showing/hiding a launcher never changes Assistant, patient, financial, page, tool, RLS, or API authorization. The visibility-only guarantee is stated to the admin in-product and enforced structurally by registry eligibility gating in both the action and the read model.
- **Authorization:** every write requires primary-admin identity plus the `ai.assistant_customization` entitlement; the page redirects non-primary admins and gates unentitled clinics before any data access.
- **Tenant isolation and audit:** writes go through the authenticated RLS session, so clinic scoping and the P4.9A audit trigger run with the true actor. `clinic_id`/actor are server-owned; the reset path deletes exactly one composite-keyed row.
- **PHI, billing, usage, rate-limit:** no PHI is read or logged; no AI budget is reserved, no usage incremented, no provider/model selected, and no tool executed. There is no new public endpoint — the read is a Server Component render and writes are server actions.
- **Phase boundary:** no conversational memory and no workflow execution are added; the patient-details launcher keeps its existing doctor-only, already-authorized-id contract and re-authorizes on open.

## 7. Test coverage

23 tests across five files, all passing:

- **Actions** (`tests/unit/actions/p49b-assistant-launcher-settings.test.ts`) — role writes go through the authenticated RLS client with server-owned clinic/actor; reset deletes one exact role row; registry-absent role/area pairs are rejected before authorization; secondary admins and non-entitled clinics are denied without a write; per-user overrides validate a same-clinic active target; missing/cross-tenant targets and unsupported target roles are denied without a write; override reset removes only the selected user's exact area row.
- **Read model** (`tests/unit/ai/p49b-launcher-customization-data.test.ts`) — returns the complete registry matrix with only eligible persisted choices; pins every read to the authenticated clinic and excludes inactive/deleted staff; fails closed when any placement or staff read fails.
- **Scope/regression** (`tests/unit/ai/p49b-scope-and-patient-launcher.test.ts`) — the patient-details launcher keeps its doctor-only clinical contract, attaches the already-authorized patient id, and re-authorizes on open; the phase adds no conversational memory or workflow execution.
- **Editor** (`tests/unit/components/p49b-assistant-launcher-customizer.test.tsx`) — accessible area × role matrix without unsupported toggles; keyboard toggling persists one eligible role decision; reset returns to the code default; per-user override applies and resets while preserving role inheritance; controls stay keyboard-accessible in RTL.
- **Page** (`tests/unit/pages/p49b-assistant-customization-page.test.tsx`) — renders the editor only when entitled; shows a non-mutating upgrade gate on `basic`/`pro`; denies secondary admins before loading any placement rows; fails soft with a localized alert when metadata cannot load.

## 8. Interrupted-session fixes applied this session

The previous session was cut off by a usage limit with two validation regressions left in `app/(protected)/settings/assistant/page.tsx`:

- **JSX constructed inside `try`/`catch`** (`react-hooks/error-boundaries` lint error) — refactored so the fetch runs in `try`/`catch` into a nullable `data` variable and the editor/alert JSX is chosen outside the block.
- **i18n missing-key false failure** — the metadata translator reused the name `t`, so the i18n gate attributed `t("metadataAssistantCustomization")` to the component's `settings` namespace instead of `protected`. Renamed it to `metadataT` (matching the sibling `settings/ai/page.tsx` pattern), resolving the gate against the existing `protected.metadataAssistantCustomization` key.

No product behavior changed; both were mechanical fixes to green the gates.

## 9. Validation

Full suite on 2026-07-25:

| Check | Result |
|---|---|
| Focused P4.9B set (actions/read model/scope/editor/page) | Pass — 5 files, 23 tests |
| Focused live P4.9A RLS/audit integration | Pass — 1 file, 12 tests against local Supabase |
| `npm test` (unit, excludes integration) | Pass — 202 files, 1,471 tests |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass — 0 errors; 25 pre-existing repository warnings in unrelated files |
| `npm run lint:i18n` | Pass — 305 files; 14 documented exceptions |
| `npm run i18n:missing` | Pass — 2,831 base messages; locale variants valid |
| `npm run i18n:unused` | Pass — no unreferenced keys |
| `npm run lint:rtl` | Pass — 425 files; 10 documented exceptions |

## 10. Out of scope / next

P4.9 is complete. P4.10 session memory, P4.11 workflows, patient AI, and all write-capable AI behavior remain unstarted. Per the session directive, no commit was made and P4.10 was not begun.
