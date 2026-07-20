# Runbook — Local development AI via the normal BYOK flow

**Purpose.** Run the assistant in local development through the *exact* Phase 4.5
provider path a real customer uses: your Anthropic key is registered as a
clinic-scoped BYOK credential (validated once, encrypted at rest), never read
from the process environment. No development-only code paths, no shortcuts.

**Scope guardrails.**
- No architectural change. Routing, the provider abstraction
  (`resolveAiProviderCredential` → `prepare*Provider`), entitlement gates, and
  the commercial catalog are untouched.
- The `pro_ai` catalog is **not** modified. Hybrid is unlocked for the dev clinic
  only, via a `clinic_feature_overrides` row (the intended mechanism).
- Your raw Anthropic key is **not** stored in `.env.local` and **not** read by the
  assistant from any env var.

---

## Why `ANTHROPIC_API_KEY` is no longer in `.env.local`

Nothing in the codebase reads `process.env.ANTHROPIC_API_KEY`. Both direct-provider
call sites (`lib/ai/platform/tenant-provider.ts` and the credential test in
`lib/ai/platform/provider-connections.ts`) pass the tenant's resolved secret to
`createAnthropic({ apiKey })` explicitly; the managed path uses the Vercel AI
Gateway (`AI_GATEWAY_API_KEY` / OIDC). A raw key in the environment was therefore
dead config whose only effect would be a silent `@ai-sdk/anthropic` fallback if a
secret were ever empty.

Two guards make that impossible:
- `prepareTenantProvider` fails closed on an empty secret, so a BYOK/hybrid turn
  can never be served from an ambient key.
- The key belongs in the BYOK store (`ai_provider_connections.credential_encrypted`,
  AES-256-GCM), reached only through the AI Provider UI.

### What to do with your existing key
1. Keep the value in your password manager as a temporary backstop.
2. Register it through the AI Provider UI (below) — it is encrypted at rest.
3. Confirm the assistant works via BYOK, then discard the local plaintext copy.
   Do **not** re-add it to `.env.local`.

## Prerequisite — credential key ring in `.env.local`

BYOK encryption needs a dedicated key ring (never reuse `MESSAGING_CREDENTIALS_KEY`):

```bash
# generate once
openssl rand -base64 32
```

```dotenv
AI_CREDENTIALS_ACTIVE_KEY_VERSION=1
AI_CREDENTIALS_KEY_V1=<the base64 value above>
```

Without it, connecting a key fails at encryption (`AiCredentialCryptoError`).

## Enable all provider modes for the dev clinic only

`ai.managed` and `ai.byok` come from the `pro_ai` plan; `ai.hybrid_fallback` is
`false` in the catalog (Hybrid is a higher-tier capability). Unlock Hybrid for the
dev clinic **only** — this changes no other clinic and no plan definition:

```sql
insert into public.clinic_feature_overrides (clinic_id, feature_key, enabled)
values ('<DEV-CLINIC-UUID>', 'ai.hybrid_fallback', true)
on conflict (clinic_id, feature_key) do update set enabled = true, updated_at = now();
```

`getEntitlements` caches for ~5 min (`revalidate: 300`); restart `next dev` to pick
the override up immediately.

## Register your Anthropic key (normal BYOK flow)

1. Restart the dev server so the key ring loads and the removed env key is gone.
2. Sign in as the clinic's **primary admin**; open **Settings → AI**.
3. **Connect AI credential** → paste your `sk-ant-…` key → submit. The server runs a
   live validation call, encrypts the key, and stores it; status becomes **valid**.
   The connection starts empty — no key exists until you do this step.
4. **BYOK (strict)** and **Hybrid** radios enable. Select a mode → re-enter your
   account password → **Save provider mode** (Hybrid also requires the disclosure
   checkbox). The assistant now runs on your key through the customer path.

Selecting a credential-requiring mode before a healthy connection exists is
correctly blocked by the UI, the server action, and the DB trigger.

## Transition to production (no further refactor)

The same code path serves managed, byok_strict, and hybrid; only data (policy row,
encrypted credential) and infra config (env) differ. To go live you only:

1. **Enable Vercel AI Gateway Pro** and configure the managed provider — the
   `managed` mode already routes through `gateway()`; production uses OIDC instead
   of `AI_GATEWAY_API_KEY`.
2. **Enable ZDR.** Certified routes set `zeroDataRetentionRequired: true`, and
   `managed-gateway.ts` always passes `zeroDataRetention: true` in production. The
   dev-only `AI_GATEWAY_ZDR=false` opt-out is ignored when `NODE_ENV=production`,
   so it can never weaken deployed behavior.

No provider IDs or keys are hardcoded; mode selection stays data-driven and gated
in three independent layers (UI, server action, DB trigger).

---

_Related: `docs/runbooks/P4_5_TEST_CLINIC_ENABLEMENT.md` (operator clinic reset),
`docs/runbooks/P4_5B_AI_CREDENTIAL_ROTATION.md` (credential rotation)._
