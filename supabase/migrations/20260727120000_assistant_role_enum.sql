-- Phase 1: introduce the `assistant` staff role.
--
-- The enum value is added in its own migration on purpose: PostgreSQL cannot use
-- a newly added enum value in the same transaction that introduced it, so every
-- policy/function/table that references 'assistant' lives in later migrations
-- which run after this one has committed.
alter type public.user_role add value if not exists 'assistant';
