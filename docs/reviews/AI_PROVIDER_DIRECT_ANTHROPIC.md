# P12 — Direct Anthropic transport, per-clinic allowance, ordered provider resolution

## 1. Architecture

**Before**

```
Clinic → ClinicFlow AI control plane → Vercel AI Gateway → Anthropic → Claude   (managed)
Clinic → ClinicFlow AI control plane → clinic Anthropic key → Anthropic → Claude (byok_strict)
Clinic → ClinicFlow AI control plane → clinic key, falling back to Vercel Gateway (hybrid)
```

**After**

```
MANAGED
Clinic → ClinicFlow AI control plane → ClinicFlow managed Anthropic key → Anthropic → Claude

BYOK
Clinic → ClinicFlow AI control plane → clinic encrypted Anthropic key → Anthropic → Claude

HYBRID
Clinic → ClinicFlow AI control plane → clinic key → (audited failure) → ClinicFlow managed key → Anthropic
```

The Vercel AI Gateway adapter (`lib/ai/platform/managed-gateway.ts`) is **retained
and unchanged in behaviour**, as a registered non-default alternate transport
selected only by `AI_MANAGED_TRANSPORT=vercel_ai_gateway`. Nothing in the runtime
selects it on error: an automatic error-triggered switch would move a clinic's
traffic to a different processor and a different bill without anyone deciding to.

## 2. Privacy: what is enforced in code vs. what is contractual

This section exists because the previous model conflated the two, and the
conflation was load-bearing: the certified route carried a single
`zeroDataRetentionRequired: true` flag, and the only thing that flag ever did was
set Vercel AI Gateway's `zeroDataRetention` request option. On a direct Anthropic
call it was inert — a claim with no mechanism behind it.

### Enforced in code, on every transport

| Control | Where |
| --- | --- |
| The usage/cost ledger is content-free — no prompt, completion, tool payload, patient identifier or message body | `ai_usage_events` column set + `AI_BUDGET_ATTEMPT_CONTENT_FORBIDDEN` key allow-list in `reconcile_ai_budget` |
| Attempt records are append-only | `trg_ai_usage_events_immutable` |
| Conversation retention is bounded | `lib/ai/retention.ts`, `app/api/cron/ai-retention` |
| Identifier scrubbing before the model sees text | `lib/ai/redact.ts`, `lib/ai/untrusted-text.ts` |
| No credential is ever returned to a browser | `getAiProviderSettings` projects masked metadata only |
| No raw tenant identity is sent to a provider | pseudonymous HMAC tag, gateway transport only |

### Contractual / account-level, NOT expressible per request

| Control | Reality |
| --- | --- |
| Anthropic input/output retention for the ClinicFlow organization | Governed by the ClinicFlow↔Anthropic agreement and Anthropic account configuration. There is no per-request parameter, so ClinicFlow does not pretend to set one. |
| Anthropic no-training posture | Same: commercial-terms level, verified out of band. |
| A clinic's own Anthropic account under BYOK | Entirely the clinic's contract with Anthropic. ClinicFlow can neither set nor observe it. |

**Code changes made for this:**

* `CertifiedModelRoute.privacy.zeroDataRetentionRequired` → split into
  `gatewayZeroDataRetention` (a gateway request option, named for the transport
  that can honour it) and `directProviderRetention: "contractual_only"`.
* `AI_GATEWAY_ZDR` is documented as gateway-only and has no effect on the direct
  transport.
* The ledger's `privacy_policy_version` values were renamed from
  `*-zdr-no-training-v1` to `*-direct-anthropic-no-training-v2`, because the
  posture the label names genuinely changed.

Nothing about the existing content-free ledgers was weakened.

## 3. The allowance invariant (audit findings G2, G3)

Two different kinds of limit were being served by one number. They are now
separate, and `lib/ai/allowance.ts` is the canonical statement of the split.

| Limit | Kind | Applies to |
| --- | --- | --- |
| `ai_credits_month` (+ per-clinic `included_budget_override_micros`) | Commercial — money ClinicFlow spends | managed, and hybrid's fallback leg |
| `ai_messages_month` / `ai_requests_month` | Commercial — ClinicFlow-funded requests | managed, and hybrid |
| `ai_byok_requests_month` | Platform protection — abuse ceiling | direct BYOK |
| `ai_concurrent_requests` | Platform protection — concurrency | **every** mode |
| In-process provider concurrency + single bounded retry | Platform protection | every direct call |

BYOK is **unmonetized, not unmetered**. It keeps authorization, entitlement,
safety gates, credential security, audit, the usage ledger, concurrency, rate
limiting and a fair-use ceiling. What it no longer has is a monetary cap on money
ClinicFlow is not spending.

The database enforces this rather than the application:
`ai_budget_reservations.consumes_managed_budget` records which side a turn is on,
a CHECK constraint forbids a `managed` turn from being on the free side, and
`reconcile_ai_budget` refuses to book any managed spend against a reservation
that did not consume the managed budget.

## 4. Ordered provider resolution (audit finding G1)

```
managed allowance available            → ClinicFlow managed Anthropic (direct)
managed allowance exhausted + BYOK key → the clinic's Anthropic key (direct), automatically
managed allowance exhausted, no key    → clean denial + admin notification
```

Constraints on the handover, all enforced in `reserve_ai_budget`:

* **One direction only.** `byok_strict` may run under a `managed` or `hybrid`
  policy. The reverse — a BYOK clinic quietly served from ClinicFlow's key — has
  no code path.
* **Only for exhaustion.** A concurrency denial or a fair-use denial never
  triggers a handover; retrying those on another credential would defeat the
  limit that just fired.
* **Only with consent.** `auto_byok_fallback_enabled` defaults to on (the
  alternative default is AI stopping mid-conversation for a clinic that already
  connected a working key) and the clinic can turn it off in AI settings. The
  change is audited as `AI_PROVIDER_AUTO_FALLBACK_CHANGED`.
* **Only with a healthy key**, the `ai.byok` entitlement, and a credential that
  decrypts under this clinic's AAD.
* **No paid overage.** The handover moves spend away from ClinicFlow, never
  toward it, and nothing charges beyond the configured allowance.

Hybrid degrades to direct-only rather than being denied: its fallback leg is
precisely the part with no allowance left.

## 5. Platform protection for one shared Anthropic account

`lib/ai/platform/provider-resilience.ts`:

* Global and per-clinic in-process concurrency ceilings, so one tenant cannot
  occupy every provider slot on an instance. The durable per-clinic
  `ai_concurrent_requests` limit is unchanged and still runs.
* **At most one retry**, only for `rate_limit` / `provider_unavailable`, only
  before any token was produced, with the provider's `retry-after` clamped to
  5 s. Retries multiply cost, and an uncontrolled retry loop against a
  rate-limited account makes the rate limit worse.
* Provider errors normalized into ClinicFlow's transport-neutral vocabulary
  (`lib/ai/platform/failure.ts`), so nothing above the transport reads a status
  code and managed/BYOK remain indistinguishable to every gate.
* Saturation fails fast as `rate_limit` rather than queueing: the turn is denied
  cleanly, nothing is spent, and the existing reconciliation records an ordinary
  failed attempt.

## 6. Live acceptance

`tests/unit/ai/acceptance/patient-assistant-live-acceptance.test.ts` makes real
model calls and certifies the two credential paths separately, reusing the exact
production acceptance scenarios and graders. It is skipped unless
`AI_ACCEPTANCE_LIVE=1`, bounded by a hard call cap, and runs only against
synthetic fixtures (`lib/ai/acceptance/fixture-clinic.ts`) — no clinic or patient
data, and no stored clinic credential (the BYOK lane takes a synthetic key from
the environment and never reads `ai_provider_connections`).

Everything about the lane except the money is verified offline in
`tests/unit/ai/p12-live-acceptance-wiring.test.ts`.
