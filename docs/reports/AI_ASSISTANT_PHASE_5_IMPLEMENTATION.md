# AI Assistant Phase 5 Review Remediation

Date: 2026-08-14  
Scope: Phase 5 review findings P5-01 through P5-11 only. Phase 5f and later capabilities remain excluded.

## Outcome

All eleven findings in `AI_ASSISTANT_PHASE_5_REVIEW.md` are resolved. The production build, targeted Phase 5 tests, full unit regression, full local Supabase integration/RLS suite, adversarial suite, typecheck, lint, i18n/RTL gates, and `git diff --check` pass. No remote deployment, push, migration application, or other remote mutation was performed.

## Finding-by-finding resolution

### P5-01 — non-async exports in a `use server` module

- Converted every department, insurance, service, clinic-hours, and staff-schedule lifecycle export in `actions/settings.ts` to an `async` server action while retaining all action names and behavior.
- Added a repository-wide server-action contract test that examines every TypeScript module under `actions/` containing `"use server"` and rejects non-async exported function declarations.
- Negative control: the invariant fails if any `export async function` is changed to `export function`.

### P5-02 — medical-note restore was nonfunctional and lost authorization

- Restored tenant-scoped admin access for loading and updating already-soft-deleted notes, which ordinary RLS intentionally hides.
- Restored the original authorization rule: an admin may restore any same-clinic note; a doctor may restore only a note they created. The patient must still be active and belong to the actor's clinic.
- Preview and execute now perform the same tenant and ownership checks. Execute verifies that exactly one note was restored and preserves before/after audit data.
- Same-tenant integration coverage proves admin and author-doctor restoration succeeds and a different doctor is refused without changing the row.

### P5-03 — appointment dependent cleanup silently accepted no-op deletes

- `deleteDependents` now snapshots all four dependent tables (`appointment_services`, `feedback`, `follow_ups`, and `outstanding_settlements`) with a tenant-bound admin client.
- Every delete returns selected ids and must remove exactly the number of rows that was snapshotted. An error or zero/partial-row no-op is a failure.
- If dependent cleanup partially fails, or the later appointment update/delete fails, the snapshots are upserted back so rollback has meaningful data.
- Permanent appointment deletion now uses the tenant-bound admin client only after the session client and domain role checks prove the exact trashed appointment belongs to the actor's clinic; its affected-row count must be exactly one.
- Negative control proves a zero-row dependent delete is detected, rollback runs, and the appointment is not deleted. Same-tenant RLS tests prove both admin and manager soft/permanent deletion remove all four dependent kinds.

### P5-04 — validation failures could appear successful

- `domainFailureToActionResult` now always supplies a top-level localized `error`, choosing the first localized field error when present and otherwise the domain error.
- Settings invoice-sequence and follow-up problem-note failures now emit explicit coded field errors and an appropriate top-level error.
- UI coverage proves an invalid invoice-follow-up mutation displays an error toast and never a success toast.

### P5-05 — raw domain/message keys reached the UI

- Removed custom Zod messages containing action-error keys from settings and follow-up schemas.
- Domain-specific messages now travel through `fieldErrorCodes` and are localized by the action adapter; generic schema rules use validation message keys.
- English and Arabic adapter tests assert that field errors and top-level errors contain rendered text, never dotted message keys.

### P5-06 — numeric weekday appeared in error text

- Extended the domain-failure adapter's weekday localization to `appointments.clinicClosedOnDay`, matching the existing schedule error handling.
- English and Arabic tests assert localized weekday names and reject numeric-day output.

### P5-07 — staff creation exposed a plaintext model-supplied password and Phase 5f roles

- Added a strict assistant-only staff-create schema with no password field and only `receptionist`, `doctor`, and `assistant` target roles. `manager` and `admin` are rejected before execution; existing UI staff creation keeps its current password-bearing product flow.
- For assistant-originated creation, the domain core generates a strong random temporary password server-side after confirmation. The password is excluded from action input, preview, receipts, and audit data.
- The generated credential is returned once in the local confirmation result and rendered in a one-time UI card; it is not appended to or persisted in the assistant transcript.
- Added defense-in-depth recursive redaction for password-shaped fields before conversation parts are stored.
- Tests assert the action schema has no password field, rejects supplied password/manager/admin inputs, generates the credential server-side, omits it from audit storage, and redacts credential-shaped assistant parts.
- No role changes, permission changes, password resets, privileged risk action, or `ai.write_privileged` feature was added; those remain Phase 5f.

### P5-08 — duplicated live legacy mutation implementations

- Removed the unused `patient-packages-legacy.ts` and `package-templates-legacy.ts` modules.
- Reduced patient and clinical legacy modules to the read/bulk compatibility helpers still used by callers.
- Removed superseded appointment and settings mutation bodies from their compatibility modules, leaving only non-extracted UI/read helpers.
- Added an invariant that orphan modules stay absent and compatibility modules cannot export superseded mutation symbols.

### P5-09 — source-text/tautological tests and missing same-tenant coverage

- Replaced the old source-text "same core" assertion with runtime coverage that dispatches the shared domain core behind every one of the 74 Phase 5 actions and verifies its actual validation refusal.
- Replaced self-referential role-constant comparison with a discriminating runtime matrix: for every action and every clinic role, the registry's declared result must match the `DomainMutationAuthorizationError` behavior enforced by the real core. Widening or narrowing either side fails the suite.
- Retained a negative authorization control that calls a core directly with a forbidden role.
- Replaced schema-only business-rule confidence with real core/action tests for appointment conflicts/deletion, medical-note ownership/restore, settings validation, staff rollback/fallback, and UI success/error behavior.
- Added same-tenant positive integration/RLS tests for the mutation paths implicated by the review, while retaining the cross-tenant denial matrix across all 5a–5e domains.
- Added the Next.js server-action async-export invariant described in P5-01.

### P5-10 — staff-create fallback, rollback, and validation drift

- Page-permission seeding now uses the existing `user_customizations` fallback when `user_page_permissions` is unavailable.
- Any profile, assistant-assignment, or permission-seeding failure explicitly removes the newly inserted same-clinic profile before deleting the auth user.
- Department and supervising-doctor validation remains fail-closed and runs before auth-user creation.
- Tests prove missing-table fallback succeeds, permission failure rolls back both profile and auth user, and missing department/invalid supervisor inputs never create an auth user.

### P5-11 — destructive/bulk previews did not identify records

- Reclassified `appointments.confirm_and_displace` as `bulk`.
- Appointment destructive previews now name the patient, doctor, scheduled time, and record id rather than serializing opaque objects.
- Conflict displacement previews render one target entry and one human-readable entry per conflicting appointment, up to the existing cap of 25.
- Tests assert bulk classification and reject JSON-like identifiers while requiring patient, doctor, and time details.

## Preserved Phase 3/4 guarantees

- The shared confirmation executor, HMAC-bound inputs, single-use claim/replay behavior, confirmation expiry, execute-time reauthorization, receipt ledger, and audit digests were not bypassed or weakened.
- Destructive-action tests still prove invalid tokens are refused before domain execution and a denied receipt is finalized.
- The full adversarial suite and confirmation regression tests pass.
- Cross-tenant RLS coverage remains in place and passes; tenant-bound admin clients are used only after explicit role, record, and clinic checks.

## Verification

| Gate | Result |
|---|---|
| `pnpm build` | Pass — production build and TypeScript build stage completed |
| Targeted Phase 5 tests | Pass — 7 files, 76 tests covering parity, failure adaptation, staff boundaries, deletion safety, medical-note access, credential persistence, and UI validation |
| `pnpm test` | Pass — 343 files, 2,502 tests |
| Full integration/RLS suite | Pass — 53 files passed, 1 skipped; 455 tests passed, 3 skipped |
| `pnpm test:ai-adversarial` | Pass — 2 files, 109 tests |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 26 non-blocking warnings outside the files changed for this review |
| `pnpm lint:rtl` | Pass — 666 files scanned, 17 documented exceptions |
| `pnpm lint:i18n` | Pass — 438 files scanned, 43 documented exceptions |
| `pnpm i18n:missing` | Pass — 3,968 base leaf messages |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `git diff --check` | Pass |

## Remaining issues

No remaining Phase 5 review finding is known. The build still reports the repository's existing Next.js middleware deprecation notice and an NFT tracing warning originating from the document PDF font import trace. Lint reports 26 non-blocking warnings outside this remediation's edited files. These were not changed because they are unrelated to the Phase 5 review scope.
