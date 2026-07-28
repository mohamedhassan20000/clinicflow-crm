# P6 Comprehensive-Review Fixes

**Date:** 2026-07-29

**Review:** `docs/reviews/P6_COMPREHENSIVE_REVIEW.md`

**Scope:** Required P6 comprehensive-review blocker P6-C1 only. No P7 work,
final review, commit, push, or merge.

## 1. Required blocker fixed

### P6-C1 — required i18n CI gates

Resolved both false positives in
`components/settings/whatsapp-onboarding-wizard.tsx` without changing either
scanner, adding a global suppression, or weakening a CI gate.

1. The inline Facebook SDK callback signature was extracted to the named
   `FacebookLogin` type. This preserves the same runtime contract while keeping
   the regex-based JSX scanner from misreading TypeScript tokens as user-facing
   copy.
2. The three computed connection-state and failure-reason translation calls were
   replaced with static key maps. The maps use `satisfies Record<...>` against the
   closed `ConnectionState` and `ConnectionFailureReason` unions, so TypeScript
   requires every supported code to have a catalog key.
3. Values loaded through the safe metadata boundary remain runtime strings.
   Unknown persisted state codes now fall back to
   `connectionState.not_started`, and unknown failure reason codes fall back to
   the sanitized `connectionReason.generic` message rather than constructing an
   unverified catalog key.

No catalog entry was added or changed because every concrete EN/AR key already
existed.

## 2. Focused regression coverage

Extended the P6C onboarding-wizard test to verify that an unexpected persisted
connection state and a raw/unknown failure reason resolve to the safe static
translation fallbacks. The existing popup-abandonment behavior remains covered.

## 3. Low findings

No Low finding was changed in this narrowly scoped fix. P6-L1 through P6-L4
affect separate ops, telemetry, or CI-coverage policy surfaces and are
non-blocking follow-ups; changing them was not necessary to resolve P6-C1.

## 4. Files changed in this fix cycle

- `components/settings/whatsapp-onboarding-wizard.tsx`
- `tests/unit/components/p6c-whatsapp-onboarding-wizard.test.tsx`
- `docs/reports/P6_COMPREHENSIVE_FIXES.md`

No migration, database type, message catalog, scanner, or CI workflow was
changed.

## 5. Validation results

| Validation | Result |
|---|---|
| i18n source gate | `pnpm lint:i18n` — pass; 325 files scanned, 14 documented exceptions |
| Missing/parity gate | `pnpm i18n:missing` — pass; 3,149 matching base leaf messages |
| Unused-copy gate | `pnpm i18n:unused` — pass; no unreferenced keys |
| TypeScript | `pnpm typecheck` (`tsc --noEmit`) — pass |
| Focused wizard tests | 1 file / **2 tests passed** |
| Production build | `pnpm build` — pass; 71 routes generated |
| Diff whitespace | `git diff --check` — pass |

