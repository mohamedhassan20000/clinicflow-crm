-- P7E — WhatsApp Linked Devices ("Connect with QR") transport, part 1 of 2.
--
-- This file does nothing but widen the messaging_provider enum. Postgres refuses
-- to *use* a value added by ALTER TYPE inside the same transaction that added it,
-- and the Supabase CLI runs each migration file in its own transaction, so the
-- check constraints, functions and tables that reference 'linked_device' live in
-- the sibling migration that runs immediately after this one.

alter type public.messaging_provider add value if not exists 'linked_device';
