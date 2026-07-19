# P4.5B AI Credential Rotation Runbook

Date: 2026-07-19  
Applies to: Anthropic tenant credentials and ClinicFlow's dedicated AI credential-encryption key ring.

## Non-Negotiable Handling Rules

- Perform provider-key lifecycle operations only from the clinic's primary-admin AI provider settings page.
- Never paste a provider key into a ticket, chat, log, shell argument, SQL statement, browser URL, monitoring field, or screenshot.
- Store `AI_CREDENTIALS_KEY_V*` values only in the deployment secret manager. They must never enter source control or a clinic-facing system.
- Do not remove an old encryption key version while an active connection still references it.
- Do not use `MESSAGING_CREDENTIALS_KEY` for AI credentials.

## Normal Provider-Key Rotation

1. The clinic primary admin creates a new restricted production key in Anthropic. Confirm the account's required model access, quota, no-training terms, and zero-data-retention agreement before enabling it for clinical traffic.
2. Open **Settings → AI provider → Rotate Anthropic credential**.
3. Enter the new provider key and the primary admin's current password.
4. Submit **Validate & rotate**. ClinicFlow tests the new key before making any database change.
5. Confirm the connection health is **Valid**, the masked fingerprint changed, and the rotation timestamp is current.
6. Run **Test credential** once more from the settings page.
7. Revoke the old key in Anthropic only after ClinicFlow reports the new connection as valid.

The activation transaction retires the previous connection, destroys its ciphertext, activates the new connection, and records metadata-only audit entries. A failed validation leaves the previous connection active.

## Emergency Provider-Key Revocation

Use this procedure when a tenant provider key may be exposed.

1. Revoke the compromised key immediately in Anthropic.
2. From the primary-admin settings page, choose **Revoke credential**, reauthenticate, and confirm. ClinicFlow destroys the active ciphertext and explicitly changes routing to managed mode.
3. If managed processing is not contractually permitted for the clinic, disable staff AI access until a replacement credential has been connected and strict BYOK has been re-enabled.
4. Create a replacement restricted provider key and follow the normal rotation procedure.
5. Review clinic audit events for `AI_PROVIDER_CONNECTION_REVOKED`, subsequent `AI_PROVIDER_CONNECTION_CREATED`, and `AI_PROVIDER_MODE_CHANGED`. Audit data must contain only provider metadata, fingerprints, lifecycle state, and policy state.
6. Follow the security incident process if browser history, application logs, Sentry, support systems, or source control might have received the raw value. Rotate the affected provider key regardless of whether access is confirmed.

## ClinicFlow Encryption-Key Rotation

The envelope uses AES-256-GCM and records a key version. Associated data binds every ciphertext to its clinic, provider, and credential ID. Old key versions remain decrypt-only while a newer version is active.

1. Generate a new 32-byte random key in the approved secret-management workflow. Base64-encode it without printing or persisting it outside that workflow.
2. Add it as the next immutable secret name, for example `AI_CREDENTIALS_KEY_V2`. Keep every earlier key variable present.
3. Deploy with the old `AI_CREDENTIALS_ACTIVE_KEY_VERSION` unchanged. Verify all application instances can read the expanded key ring.
4. Change `AI_CREDENTIALS_ACTIVE_KEY_VERSION` to the new version and deploy. New connections and provider-key rotations now use the new envelope version; existing connections continue to decrypt with their recorded version.
5. Have each clinic with an older active envelope complete the normal provider-key rotation. This both rotates the upstream credential and writes a new envelope under the active encryption version.
6. Query safe metadata using an authorized database administration session:

   ```sql
   select encryption_key_version, count(*)
   from public.ai_provider_connections
   where lifecycle_status = 'active'
   group by encryption_key_version
   order by encryption_key_version;
   ```

7. Remove an old `AI_CREDENTIALS_KEY_V*` secret only when the query shows zero active connections for that version and the normal backup-retention requirement has elapsed.
8. Confirm strict, hybrid, test, rotation, and revocation paths after the final deployment. A missing old key must fail closed as `credential_unavailable`; it must never trigger managed fallback for strict BYOK.

## Encryption-Key Compromise

If an AI encryption key itself may be compromised, assume every active ciphertext using that version requires replacement.

1. Preserve the old key temporarily only inside the approved incident environment so active ciphertext can be identified and safely retired; do not distribute it to operators.
2. Add and activate a new encryption-key version.
3. Require affected clinics to rotate their upstream provider keys. Provider-key rotation destroys the old ciphertext and invalidates the upstream secret, eliminating reliance on confidentiality of the compromised envelope.
4. Clinics that cannot rotate immediately must have their connection revoked. Keep AI disabled when managed mode is not contractually permitted.
5. Verify no active connection references the compromised version, then remove that version from the application secret ring and complete the incident review.

## Verification Checklist

- The settings UI returns only provider, health, masked fingerprint, and lifecycle timestamps.
- Strict BYOK provider failure produces no managed attempt and no managed-credit spend.
- Hybrid fallback succeeds only with the persisted disclosure version and produces `AI_PROVIDER_HYBRID_FALLBACK` before managed execution.
- Retired and revoked rows have `credential_encrypted is null`.
- Authenticated clinic sessions cannot select either provider-connection table.
- Logs and Sentry contain neither `sk-ant-...` values nor bytea credential envelopes.

