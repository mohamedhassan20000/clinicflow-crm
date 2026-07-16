# Summary

Implemented Phase 3 only: dirty-form unload protection and scoped discard confirmation for appointment and patient forms, a localized dashboard skip link and focus target, localized login validation, and localized status announcements on the seven specified legacy loading boundaries. No router interception, history manipulation, dependency, server-action contract, or Phase 4 work was added.

# Files changed

- `components/shared/unsaved-changes-guard.tsx` — shared `beforeunload` guard.
- `components/appointments/appointment-form.tsx` — dirty guard, pristine prefill handling, and dirty-only Cancel confirmation.
- `components/patients/patient-form.tsx` — dirty guard and dirty-only Cancel confirmation.
- `components/layout/dashboard-shell.tsx` — localized skip link and `main-content` focus target.
- `components/auth/login-form.tsx` — existing localized validation keys.
- `app/(protected)/dashboard/loading.tsx`, `app/(protected)/patients/loading.tsx`, `app/(protected)/appointments/loading.tsx`, `app/(protected)/followups/loading.tsx`, `app/(protected)/revenue/loading.tsx`, `app/(protected)/reports/loading.tsx`, `app/(protected)/settings/staff/loading.tsx` — localized loading status wrappers.
- `messages/en.json`, `messages/ar.json` — matching Phase 3 shell, discard-dialog, and loading-announcement copy.
- `tests/unit/components/p3-unsaved-changes-guard.test.tsx` — focused listener lifecycle coverage.
- `tests/unit/components/p3-login-localization.test.tsx` — focused English and Arabic login validation coverage.
- `tests/unit/components/dashboard-shell.test.tsx`, `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap` — skip-link target assertions and intentional snapshot updates.
- `docs/reviews/ux/P3_IMPLEMENTATION.md` — this implementation report.

# Tests executed

- `pnpm exec vitest run tests/unit/components/p3-unsaved-changes-guard.test.tsx tests/unit/components/p3-login-localization.test.tsx` — passed, 2 files / 3 tests.
- `pnpm exec vitest run tests/unit/actions/appointment-form-autofill.test.tsx` — passed, 1 file / 8 tests.
- `pnpm exec vitest run tests/unit/components/p3-unsaved-changes-guard.test.tsx tests/unit/components/p3-login-localization.test.tsx tests/unit/components/dashboard-shell.test.tsx` — passed, 3 files / 7 tests.
- `pnpm test` — passed, 124 files / 659 tests.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with 0 errors and 26 pre-existing warnings.
- `pnpm lint:rtl` — passed; 304 files scanned with 10 documented exceptions.
- `pnpm lint:i18n` — passed; 264 files scanned with 14 documented exceptions.
- `pnpm i18n:missing` — passed; 2,322 base leaf messages with valid locale parity.
- `pnpm build` — passed; production compilation, TypeScript, and generation of all 55 static pages completed.
- `git diff --check` — passed.

# Validation results

- The shared guard registers only while active, prevents `beforeunload`, and removes its exact listener when disabled or unmounted. Both forms gate it on RHF dirtiness and existing pending states; successful create flows therefore disarm or unmount it without changing server-action contracts.
- Appointment URL-prefill defaults now remain pristine while later user selections retain existing dirty tracking. Validation failures keep the mounted RHF form and entered values unchanged.
- Each form preserves its pristine Cancel link. Only a dirty form replaces that affordance with the localized discard confirmation; no global link, browser-back, router, or history interception exists.
- The localized skip link is first in shell tab order, hidden until focused, uses logical positioning, targets `#main-content`, and the target has `tabIndex={-1}`. Clinic and operator shells share the same implementation.
- Empty and invalid login submissions render catalog-backed English messages; empty Arabic submissions render Arabic messages through the same `FormMessage` validation architecture.
- All seven specified loading wrappers expose `role="status"` with the shared localized `Loading content` announcement. Their skeleton content is otherwise unchanged.
- The full suite and production build found no routing, hydration, form, or compilation regression.

# Manual verification

- Native refresh/tab-close prompts, successful authenticated submissions, live dirty/pristine Cancel behavior, keyboard focus transfer in both directions/surfaces, and VoiceOver/NVDA announcements require a browser session. The in-app browser backend was unavailable in this environment, so those live checks remain pending.
- Equivalent automated checks covered guard activation/cleanup, English and Arabic login validation, the skip-link target/focus contract, existing appointment form behavior, all locale/static gates, the full unit suite, and the production route build.
- Source inspection confirmed exactly the two approved form affordances are guarded and exactly the seven specified legacy loading boundaries were retrofitted.

# Known issues

- Accepted specification limitation: sidebar links and SPA browser-back navigation are not intercepted; no stable App Router cancellation API is used.
- Browser-only native prompt, visual focus, RTL interaction, successful authenticated submission, and assistive-technology checks remain pending because no browser backend was available.
- `pnpm lint` retains 26 pre-existing warnings outside the Phase 3 behavior, and `pnpm build` retains the pre-existing middleware-to-proxy deprecation warning.
- One concurrent validation attempt made ESLint race with `lint:rtl`'s temporary probe file; the required final gates were rerun sequentially and passed without code changes.

# Ready for review

Yes. Phase 3 is ready for architectural review with the browser-only verification limitation recorded above.
