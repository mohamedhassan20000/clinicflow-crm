-- P4.5C catalog convergence fix.
--
-- Root cause of the observed "all provider modes not included" + "managed
-- allowance 100% / exhausted after 4 requests" state: in an environment whose
-- `pro_ai` plan row still carried the pre-P4.5C P1a seed catalog, the row has
-- `features.ai_assistant = true` (so the AI settings page renders) but lacks the
-- namespaced `ai.managed` / `ai.byok` / `ai.hybrid_fallback` features and the
-- `ai_credits_month` cost limit. With no `ai_credits_month`, the clinic-facing
-- managed budget denominator resolves to 0 and the projection historically fell
-- back to 100% used.
--
-- This migration idempotently RE-ASSERTS the P4.5C AI vocabulary onto the stable
-- `pro_ai` catalog row so every environment converges, whether or not P4.5C's
-- one-time update took effect. It is a non-destructive JSONB merge: existing
-- feature/limit keys are overwritten with their canonical P4.5C values and any
-- unrelated keys are preserved. It touches only the plan catalog — no clinic,
-- subscription, budget period, usage counter, or provider credential is read or
-- written here, and no specific clinic is referenced.

update public.plans
set features = features || jsonb_build_object(
      'ai_assistant', true,
      'ai.staff_assistant', true,
      'ai.patient_suggest', false,
      'ai.patient_auto', false,
      'ai.managed', true,
      'ai.byok', true,
      'ai.hybrid_fallback', false,
      'ai.staff_analytics', true,
      'ai.financial_insights', true,
      'ai.followup_generation', false,
      'ai.scheduling', false
    ),
    limits = limits || jsonb_build_object(
      -- Same enforcement seed as the P4.5C catalog: ~1,000 established staff
      -- turns at the certified worst-case reservation. Not a GA price.
      'ai_credits_month', 1620000000,
      'ai_requests_month', 1000,
      'ai_messages_month', 1000,
      'ai_concurrent_requests', 4,
      'ai_turn_steps_max', 8,
      'ai_output_tokens_max', 1500
    ),
    updated_at = clock_timestamp()
where slug = 'pro_ai'
  and (
    coalesce((features ->> 'ai.managed')::boolean, false) is distinct from true
    or coalesce((features ->> 'ai.byok')::boolean, false) is distinct from true
    or coalesce((limits ->> 'ai_credits_month')::bigint, 0) < 1620000000
  );
