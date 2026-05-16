-- Patient Trash & Archive system
-- Adds: deleted_at (timestamp for trash age), is_archived (boolean), archived_at (timestamp)
-- No RLS changes — server actions use service-role client for trash/archive queries.

ALTER TABLE "public"."patients"
  ADD COLUMN "deleted_at"  TIMESTAMPTZ,
  ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "archived_at" TIMESTAMPTZ;

-- Index for trash page queries (deleted, not archived)
CREATE INDEX "patients_clinic_trash_idx"
  ON "public"."patients" ("clinic_id", "deleted_at" DESC)
  WHERE "is_deleted" = TRUE AND "is_archived" = FALSE;

-- Index for archive page queries
CREATE INDEX "patients_clinic_archive_idx"
  ON "public"."patients" ("clinic_id", "archived_at" DESC)
  WHERE "is_archived" = TRUE;

-- ── Optional: Supabase pg_cron automation ──────────────────────────────────────
-- To automate 30-day archival, enable the pg_cron extension in the Supabase
-- dashboard (Database → Extensions → pg_cron), then run this in the SQL Editor:
--
-- SELECT cron.schedule(
--   'archive-30-day-trash',
--   '0 2 * * *',
--   $$
--     UPDATE public.patients
--     SET    is_archived = TRUE,
--            archived_at = NOW()
--     WHERE  is_deleted   = TRUE
--       AND  is_archived  = FALSE
--       AND  deleted_at   < NOW() - INTERVAL '30 days'
--   $$
-- );
