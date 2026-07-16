# Summary

- Shipped both independent Phase 4 items.
- Added one client-only, render-null network status component using browser `online`/`offline` events and the existing Sonner toaster.
- Added focused axe coverage for `/login`, `/dashboard`, and `/patients` with a unique, self-cleaning authenticated fixture.
- Added `@axe-core/playwright` as a dev-only dependency.

# Files changed

- `components/shared/network-status-toast.tsx` — online/offline listeners, duplicate suppression, persistent offline notice, four-second recovery toast, and cleanup.
- `app/layout.tsx` — mounts the network status component once beside the existing toaster.
- `messages/en.json` — English offline/recovery messages.
- `messages/ar.json` — Arabic offline/recovery messages.
- `tests/unit/components/p4-network-status-toast.test.tsx` — English/Arabic event, deduplication, and cleanup coverage.
- `tests/e2e/a11y.spec.ts` — focused public/authenticated axe checks and isolated fixture lifecycle.
- `package.json` — dev-only `@axe-core/playwright` dependency.
- `pnpm-lock.yaml` — dependency lock update.
- `docs/reviews/ux/P4_IMPLEMENTATION.md` — this implementation report.

# Tests executed

- `pnpm vitest run tests/unit/components/p4-network-status-toast.test.tsx` — 1 file, 3 tests passed.
- `pnpm test` — 125 files, 662 tests passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with 26 pre-existing warnings and zero errors.
- `pnpm lint:rtl` — passed.
- `pnpm lint:i18n` — passed.
- `pnpm i18n:missing` — passed; 2,324 base leaf messages in parity.
- `PORT=3100 pnpm test:e2e -- a11y` with `.env.local` loaded — final run passed 3/3 against the local Supabase stack; its configured production build also passed.
- `git diff --check` — passed.
- Production dependency and build-output audits — axe is absent from production dependencies and no `axe-core` code is present under `.next/static` or `.next/server`.
- Service-worker/interception audit — no service-worker file, registration, Workbox usage, Playwright route interception, fetch replacement, offline queue, or write queue was introduced.

# Validation results

- Repeated `offline` events produce one persistent localized warning; repeated `online` events after recovery produce one localized success toast using the same Sonner ID, with an explicit 4,000 ms duration so the recovery toast auto-dismisses.
- English and Arabic catalog paths are covered by the component unit test.
- Both event listeners are removed on unmount.
- The component performs no polling, fetch probing, state persistence, network interception, queuing, or control disabling.
- `@axe-core/playwright` is dev-only and did not enter the production dependency tree or build output.
- Axe scans are fixed to three representative routes, WCAG A/AA tags, reduced-motion mode, one Chromium worker, and exact known-violation targets.
- The axe fixture uses unique IDs, serial execution within its own file, and explicit database/auth cleanup; Playwright configuration and existing specs are unchanged.
- No runtime build failure, bundle dependency regression, i18n regression, RTL regression, unit-test regression, or focused Playwright regression was observed.

# Manual verification

- The live DevTools Network toggle check was not performed because no controllable browser was available in this session.
- The same event sequence was verified automatically for English and Arabic, including duplicate suppression, toast options, recovery replacement, and listener cleanup.
- A reviewer should still perform the specification's visual DevTools check once: Offline should show one persistent warning; returning Online should replace it with one success toast in each locale and auto-dismiss after four seconds.

# Skipped items and reasons

- None. Both optional items remained lightweight and were implemented independently.
- Application-code fixes for axe findings were not attempted because Phase 4 explicitly makes those follow-up work.

# Known issues

- Axe found pre-existing light-theme contrast violations on the dashboard header avatar (`3.16:1`) and primary new-appointment/new-patient links (`3.39:1`). Exact targets are intentionally excluded from this phase's scans.
- Axe found pre-existing unlabeled dashboard `input[type="month"]` controls. Only month inputs inside `#main-content` are intentionally excluded.
- Local authenticated E2E login emits the existing `last_login_update_failed` RLS warning; navigation and all axe assertions still complete successfully.
- The browser-only visual/manual toast check remains pending as noted above.

# Ready for review

- Yes. Phase 4 implementation and automated validation are complete and ready for architectural review, with the explicitly noted manual visual check pending reviewer execution.
