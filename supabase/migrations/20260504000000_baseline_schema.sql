SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
CREATE SCHEMA IF NOT EXISTS "public";
ALTER SCHEMA "public" OWNER TO "pg_database_owner";
COMMENT ON SCHEMA "public" IS 'standard public schema';
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";
CREATE TYPE "public"."appointment_status" AS ENUM (
    'pending',
    'confirmed',
    'completed',
    'cancelled',
    'no_show'
);
ALTER TYPE "public"."appointment_status" OWNER TO "postgres";
CREATE TYPE "public"."blood_type" AS ENUM (
    'A+',
    'A-',
    'B+',
    'B-',
    'AB+',
    'AB-',
    'O+',
    'O-'
);
ALTER TYPE "public"."blood_type" OWNER TO "postgres";
CREATE TYPE "public"."follow_up_outcome" AS ENUM (
    'all_fine',
    'has_problem',
    'no_response'
);
ALTER TYPE "public"."follow_up_outcome" OWNER TO "postgres";
CREATE TYPE "public"."payment_method" AS ENUM (
    'cash',
    'credit_card',
    'paypal',
    'bank_transfer',
    'insurance'
);
ALTER TYPE "public"."payment_method" OWNER TO "postgres";
CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'receptionist',
    'manager',
    'doctor'
);
ALTER TYPE "public"."user_role" OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."auth_clinic_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE
    AS $$ select clinic_id from auth_profile() $$;
ALTER FUNCTION "public"."auth_clinic_id"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."auth_profile"() RETURNS TABLE("profile_id" "uuid", "clinic_id" "uuid", "role" "public"."user_role")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id, clinic_id, role
  from profiles
  where id = auth.uid() and is_active = true
  limit 1;
$$;
ALTER FUNCTION "public"."auth_profile"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."auth_role"() RETURNS "public"."user_role"
    LANGUAGE "sql" STABLE
    AS $$ select role from auth_profile() $$;
ALTER FUNCTION "public"."auth_role"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."enforce_appointment_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status = 'pending'   and new.status in ('confirmed', 'cancelled') then
    return new;
  end if;

  if old.status = 'confirmed' and new.status in ('completed', 'cancelled', 'no_show') then
    return new;
  end if;

  raise exception 'Invalid appointment status transition: % → %', old.status, new.status
    using errcode = 'check_violation';
end;
$$;
ALTER FUNCTION "public"."enforce_appointment_transition"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;
ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";
CREATE OR REPLACE FUNCTION "public"."write_audit_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_actor_id  uuid := auth.uid();
  v_clinic_id uuid;
  v_record_id uuid;
  v_old       jsonb;
  v_new       jsonb;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
    v_record_id := old.id;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := new.id;
  else  -- INSERT
    v_old := null;
    v_new := to_jsonb(new);
    v_record_id := new.id;
  end if;

  -- Best-effort clinic resolution per table
  if tg_table_name in ('patients', 'appointments') then
    v_clinic_id := coalesce((v_new->>'clinic_id')::uuid, (v_old->>'clinic_id')::uuid);
  elsif tg_table_name = 'medical_notes' then
    select p.clinic_id into v_clinic_id
    from patients p
    where p.id = coalesce((v_new->>'patient_id')::uuid, (v_old->>'patient_id')::uuid);
  end if;

  insert into audit_logs (actor_id, clinic_id, action, table_name, record_id, old_data, new_data)
  values (v_actor_id, v_clinic_id, tg_op, tg_table_name, v_record_id, v_old, v_new);

  return coalesce(new, old);
end;
$$;
ALTER FUNCTION "public"."write_audit_log"() OWNER TO "postgres";
SET default_tablespace = '';
SET default_table_access_method = "heap";
CREATE TABLE IF NOT EXISTS "public"."appointment_services" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "appointment_id" "uuid" NOT NULL,
    "service_id" "uuid",
    "name" "text" NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "appointment_services_price_check" CHECK (("price" >= (0)::numeric)),
    CONSTRAINT "appointment_services_quantity_check" CHECK (("quantity" > 0))
);
ALTER TABLE "public"."appointment_services" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."appointments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "doctor_id" "uuid" NOT NULL,
    "department_id" "uuid",
    "scheduled_at" timestamp with time zone NOT NULL,
    "duration_minutes" integer DEFAULT 30 NOT NULL,
    "status" "public"."appointment_status" DEFAULT 'pending'::"public"."appointment_status" NOT NULL,
    "notes" "text",
    "reminder_sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "insurance_provider_id" "uuid",
    "payment_method" "public"."payment_method",
    "paid_at" timestamp with time zone,
    "total_amount" numeric(10,2),
    "paid_amount" numeric(10,2),
    "insurance_amount" numeric(10,2),
    "outstanding_amount" numeric(10,2),
    "secondary_payment_method" "public"."payment_method",
    "payment_note" "text",
    "secondary_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "service_id" "uuid",
    "deposit_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "cancellation_reason" "text",
    "cancelled_at" timestamp with time zone,
    "cancelled_by" "uuid",
    "no_show_reason" "text",
    "no_showed_at" timestamp with time zone,
    "no_showed_by" "uuid",
    "deleted_at" timestamp with time zone,
    CONSTRAINT "appointments_deposit_amount_check" CHECK (("deposit_amount" >= (0)::numeric)),
    CONSTRAINT "appointments_duration_minutes_check" CHECK (("duration_minutes" = ANY (ARRAY[15, 30, 45, 60, 90, 120])))
);
ALTER TABLE "public"."appointments" OWNER TO "postgres";
COMMENT ON COLUMN "public"."appointments"."secondary_amount" IS 'Amount paid at completion via secondary_payment_method when a split payment is used.';
CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "clinic_id" "uuid",
    "action" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "record_id" "uuid",
    "old_data" "jsonb",
    "new_data" "jsonb",
    "ip_address" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."audit_logs" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."clinics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "logo_url" "text",
    "reminder_lead_hours" integer DEFAULT 24 NOT NULL,
    "working_hours_start" time without time zone DEFAULT '08:00:00'::time without time zone,
    "working_hours_end" time without time zone DEFAULT '20:00:00'::time without time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "address" "text",
    CONSTRAINT "clinics_reminder_lead_hours_check" CHECK ((("reminder_lead_hours" >= 1) AND ("reminder_lead_hours" <= 168)))
);
ALTER TABLE "public"."clinics" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#22d3ee'::"text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "departments_color_check" CHECK (("color" ~ '^#[0-9a-fA-F]{6}$'::"text"))
);
ALTER TABLE "public"."departments" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "appointment_id" "uuid" NOT NULL,
    "rating" integer,
    "comment" "text",
    "submitted_at" timestamp with time zone,
    "token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token_expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "feedback_comment_check" CHECK (("length"("comment") <= 2000)),
    CONSTRAINT "feedback_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);
ALTER TABLE "public"."feedback" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."follow_ups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "outcome" "public"."follow_up_outcome" NOT NULL,
    "notes" "text",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
ALTER TABLE "public"."follow_ups" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."insurance_providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone
);
ALTER TABLE "public"."insurance_providers" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."medical_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "doctor_id" "uuid" NOT NULL,
    "note" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "medical_notes_note_check" CHECK ((("length"("note") >= 1) AND ("length"("note") <= 10000)))
);
ALTER TABLE "public"."medical_notes" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."outstanding_settlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "payment_method" "text" NOT NULL,
    "note" "text",
    "settled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "outstanding_settlements_amount_check" CHECK (("amount" > (0)::numeric))
);
ALTER TABLE "public"."outstanding_settlements" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."patient_deposits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "payment_method" "text" NOT NULL,
    "note" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_deposits_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "patient_deposits_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'credit_card'::"text", 'paypal'::"text", 'bank_transfer'::"text", 'insurance'::"text"])))
);
ALTER TABLE "public"."patient_deposits" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."patients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "date_of_birth" "date" NOT NULL,
    "phone" "text" NOT NULL,
    "email" "text" NOT NULL,
    "blood_type" "public"."blood_type",
    "is_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid",
    "department_id" "uuid",
    "national_id" "text" NOT NULL,
    "file_number" "text" NOT NULL,
    "assigned_doctor_id" "uuid",
    CONSTRAINT "dob_not_future" CHECK (("date_of_birth" <= CURRENT_DATE)),
    CONSTRAINT "email_format" CHECK (("email" ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text"))
);
ALTER TABLE "public"."patients" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "department_id" "uuid",
    "full_name" "text" NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "phone" "text",
    "avatar_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "last_login_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "deleted_at" timestamp with time zone
);
ALTER TABLE "public"."profiles" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."services" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "department_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "price" numeric(12,2) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "services_price_check" CHECK (("price" >= (0)::numeric))
);
ALTER TABLE "public"."services" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."staff_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "department_id" "uuid",
    "email" "text" NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '48:00:00'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "invited_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_lower" CHECK (("email" = "lower"("email")))
);
ALTER TABLE "public"."staff_invitations" OWNER TO "postgres";
CREATE TABLE IF NOT EXISTS "public"."user_customizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "clinic_id" "uuid" NOT NULL,
    "page" "text" NOT NULL,
    "feature" "text" NOT NULL,
    "access" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_customizations_access_check" CHECK (("access" = ANY (ARRAY['hidden'::"text", 'read_only'::"text", 'read_edit'::"text"])))
);
ALTER TABLE "public"."user_customizations" OWNER TO "postgres";
ALTER TABLE ONLY "public"."appointment_services"
    ADD CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_doctor_id_scheduled_at_key" UNIQUE ("doctor_id", "scheduled_at");
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."clinics"
    ADD CONSTRAINT "clinics_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_clinic_id_name_key" UNIQUE ("clinic_id", "name");
ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_appointment_id_key" UNIQUE ("appointment_id");
ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_token_key" UNIQUE ("token");
ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."insurance_providers"
    ADD CONSTRAINT "insurance_providers_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."medical_notes"
    ADD CONSTRAINT "medical_notes_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."outstanding_settlements"
    ADD CONSTRAINT "outstanding_settlements_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."patient_deposits"
    ADD CONSTRAINT "patient_deposits_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_token_key" UNIQUE ("token");
ALTER TABLE ONLY "public"."user_customizations"
    ADD CONSTRAINT "user_customizations_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."user_customizations"
    ADD CONSTRAINT "user_customizations_profile_id_page_feature_key" UNIQUE ("profile_id", "page", "feature");
CREATE INDEX "appointments_cancelled_at_idx" ON "public"."appointments" USING "btree" ("cancelled_at") WHERE ("cancelled_at" IS NOT NULL);
CREATE INDEX "appointments_no_showed_at_idx" ON "public"."appointments" USING "btree" ("no_showed_at") WHERE ("no_showed_at" IS NOT NULL);
CREATE UNIQUE INDEX "appointments_patient_active_slot_key" ON "public"."appointments" USING "btree" ("patient_id", "scheduled_at") WHERE ("status" <> ALL (ARRAY['cancelled'::"public"."appointment_status", 'no_show'::"public"."appointment_status"]));
CREATE UNIQUE INDEX "follow_ups_appointment_unique" ON "public"."follow_ups" USING "btree" ("appointment_id") WHERE ("appointment_id" IS NOT NULL);
CREATE INDEX "follow_ups_clinic_recorded_idx" ON "public"."follow_ups" USING "btree" ("clinic_id", "recorded_at" DESC);
CREATE INDEX "follow_ups_patient_idx" ON "public"."follow_ups" USING "btree" ("patient_id", "recorded_at" DESC);
CREATE INDEX "idx_appointments_clinic_date" ON "public"."appointments" USING "btree" ("clinic_id", "scheduled_at");
CREATE INDEX "idx_appointments_doctor_date" ON "public"."appointments" USING "btree" ("doctor_id", "scheduled_at");
CREATE INDEX "idx_appointments_patient" ON "public"."appointments" USING "btree" ("patient_id");
CREATE INDEX "idx_appointments_reminder" ON "public"."appointments" USING "btree" ("scheduled_at") WHERE (("status" = 'confirmed'::"public"."appointment_status") AND ("reminder_sent_at" IS NULL));
CREATE INDEX "idx_appointments_status" ON "public"."appointments" USING "btree" ("clinic_id", "status");
CREATE INDEX "idx_appt_services_appt" ON "public"."appointment_services" USING "btree" ("appointment_id");
CREATE INDEX "idx_appt_services_clinic" ON "public"."appointment_services" USING "btree" ("clinic_id");
CREATE INDEX "idx_audit_logs_actor" ON "public"."audit_logs" USING "btree" ("actor_id", "created_at" DESC);
CREATE INDEX "idx_audit_logs_clinic_date" ON "public"."audit_logs" USING "btree" ("clinic_id", "created_at" DESC);
CREATE INDEX "idx_audit_logs_record" ON "public"."audit_logs" USING "btree" ("table_name", "record_id");
CREATE INDEX "idx_departments_clinic" ON "public"."departments" USING "btree" ("clinic_id") WHERE "is_active";
CREATE INDEX "idx_feedback_submitted" ON "public"."feedback" USING "btree" ("submitted_at") WHERE ("submitted_at" IS NOT NULL);
CREATE INDEX "idx_feedback_token" ON "public"."feedback" USING "btree" ("token") WHERE ("submitted_at" IS NULL);
CREATE INDEX "idx_invitations_clinic" ON "public"."staff_invitations" USING "btree" ("clinic_id");
CREATE INDEX "idx_invitations_token" ON "public"."staff_invitations" USING "btree" ("token") WHERE ("accepted_at" IS NULL);
CREATE INDEX "idx_medical_notes_patient" ON "public"."medical_notes" USING "btree" ("patient_id", "created_at" DESC);
CREATE INDEX "idx_patient_deposits_clinic_created" ON "public"."patient_deposits" USING "btree" ("clinic_id", "created_at" DESC);
CREATE INDEX "idx_patient_deposits_patient" ON "public"."patient_deposits" USING "btree" ("patient_id");
CREATE INDEX "idx_patients_clinic" ON "public"."patients" USING "btree" ("clinic_id") WHERE (NOT "is_deleted");
CREATE INDEX "idx_patients_email" ON "public"."patients" USING "btree" ("email") WHERE (NOT "is_deleted");
CREATE INDEX "idx_patients_name_trgm" ON "public"."patients" USING "gin" ("full_name" "public"."gin_trgm_ops") WHERE (NOT "is_deleted");
CREATE INDEX "idx_patients_phone" ON "public"."patients" USING "btree" ("phone") WHERE (NOT "is_deleted");
CREATE INDEX "idx_profiles_clinic" ON "public"."profiles" USING "btree" ("clinic_id") WHERE "is_active";
CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("clinic_id", "role") WHERE "is_active";
CREATE INDEX "outstanding_settlements_patient_idx" ON "public"."outstanding_settlements" USING "btree" ("clinic_id", "patient_id", "settled_at" DESC);
CREATE INDEX "patients_assigned_doctor_idx" ON "public"."patients" USING "btree" ("clinic_id", "assigned_doctor_id") WHERE ("is_deleted" = false);
CREATE UNIQUE INDEX "patients_clinic_file_number_unique" ON "public"."patients" USING "btree" ("clinic_id", "file_number") WHERE ("is_deleted" = false);
CREATE INDEX "patients_department_id_idx" ON "public"."patients" USING "btree" ("department_id");
CREATE INDEX "patients_national_id_idx" ON "public"."patients" USING "btree" ("clinic_id", "national_id") WHERE ("is_deleted" = false);
CREATE INDEX "profiles_is_deleted_idx" ON "public"."profiles" USING "btree" ("clinic_id", "is_deleted");
CREATE INDEX "services_clinic_dept_idx" ON "public"."services" USING "btree" ("clinic_id", "department_id") WHERE ("is_active" = true);
CREATE UNIQUE INDEX "services_clinic_dept_name_unique" ON "public"."services" USING "btree" ("clinic_id", "department_id", "lower"("name"));
CREATE OR REPLACE TRIGGER "trg_appointments_transition" BEFORE UPDATE OF "status" ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_appointment_transition"();
CREATE OR REPLACE TRIGGER "trg_appointments_updated_at" BEFORE UPDATE ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
CREATE OR REPLACE TRIGGER "trg_audit_appointments" AFTER INSERT OR DELETE OR UPDATE ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."write_audit_log"();
CREATE OR REPLACE TRIGGER "trg_audit_insurance_providers" AFTER INSERT OR DELETE OR UPDATE ON "public"."insurance_providers" FOR EACH ROW EXECUTE FUNCTION "public"."write_audit_log"();
CREATE OR REPLACE TRIGGER "trg_audit_medical_notes" AFTER INSERT OR DELETE ON "public"."medical_notes" FOR EACH ROW EXECUTE FUNCTION "public"."write_audit_log"();
CREATE OR REPLACE TRIGGER "trg_audit_patients" AFTER INSERT OR DELETE OR UPDATE ON "public"."patients" FOR EACH ROW EXECUTE FUNCTION "public"."write_audit_log"();
CREATE OR REPLACE TRIGGER "trg_clinics_updated_at" BEFORE UPDATE ON "public"."clinics" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
CREATE OR REPLACE TRIGGER "trg_insurance_updated_at" BEFORE UPDATE ON "public"."insurance_providers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
CREATE OR REPLACE TRIGGER "trg_patients_updated_at" BEFORE UPDATE ON "public"."patients" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
ALTER TABLE ONLY "public"."appointment_services"
    ADD CONSTRAINT "appointment_services_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."appointment_services"
    ADD CONSTRAINT "appointment_services_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."appointment_services"
    ADD CONSTRAINT "appointment_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_insurance_provider_id_fkey" FOREIGN KEY ("insurance_provider_id") REFERENCES "public"."insurance_providers"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_no_showed_by_fkey" FOREIGN KEY ("no_showed_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."insurance_providers"
    ADD CONSTRAINT "insurance_providers_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."medical_notes"
    ADD CONSTRAINT "medical_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."medical_notes"
    ADD CONSTRAINT "medical_notes_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."medical_notes"
    ADD CONSTRAINT "medical_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."outstanding_settlements"
    ADD CONSTRAINT "outstanding_settlements_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."outstanding_settlements"
    ADD CONSTRAINT "outstanding_settlements_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."outstanding_settlements"
    ADD CONSTRAINT "outstanding_settlements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."outstanding_settlements"
    ADD CONSTRAINT "outstanding_settlements_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."patient_deposits"
    ADD CONSTRAINT "patient_deposits_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."patient_deposits"
    ADD CONSTRAINT "patient_deposits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");
ALTER TABLE ONLY "public"."patient_deposits"
    ADD CONSTRAINT "patient_deposits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_assigned_doctor_id_fkey" FOREIGN KEY ("assigned_doctor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;
ALTER TABLE ONLY "public"."user_customizations"
    ADD CONSTRAINT "user_customizations_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."user_customizations"
    ADD CONSTRAINT "user_customizations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
CREATE POLICY "admin_manage_customizations" ON "public"."user_customizations" TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role"))) WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
ALTER TABLE "public"."appointment_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."appointments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "appointments_delete_admin" ON "public"."appointments" FOR DELETE TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
CREATE POLICY "appointments_select_clinic" ON "public"."appointments" FOR SELECT TO "authenticated" USING (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "appointments_update_staff" ON "public"."appointments" FOR UPDATE TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"])))) WITH CHECK (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "appointments_write_staff" ON "public"."appointments" FOR INSERT TO "authenticated" WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
CREATE POLICY "appt_services_select" ON "public"."appointment_services" FOR SELECT USING (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "appt_services_staff_write" ON "public"."appointment_services" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"])))) WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_select_admin_manager" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'manager'::"public"."user_role"]))));
ALTER TABLE "public"."clinics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clinics_insert_admin" ON "public"."clinics" FOR INSERT WITH CHECK (("public"."auth_role"() = 'admin'::"public"."user_role"));
CREATE POLICY "clinics_select_admin_all" ON "public"."clinics" FOR SELECT USING (("public"."auth_role"() = 'admin'::"public"."user_role"));
CREATE POLICY "clinics_select_own" ON "public"."clinics" FOR SELECT TO "authenticated" USING (("id" = "public"."auth_clinic_id"()));
CREATE POLICY "clinics_update_admin" ON "public"."clinics" FOR UPDATE TO "authenticated" USING ((("id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role"))) WITH CHECK ((("id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "departments_select_own" ON "public"."departments" FOR SELECT TO "authenticated" USING (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "departments_write_admin" ON "public"."departments" TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role"))) WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
ALTER TABLE "public"."feedback" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feedback_select_manager" ON "public"."feedback" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'manager'::"public"."user_role"])) AND (EXISTS ( SELECT 1
   FROM "public"."appointments" "a"
  WHERE (("a"."id" = "feedback"."appointment_id") AND ("a"."clinic_id" = "public"."auth_clinic_id"()))))));
ALTER TABLE "public"."follow_ups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "follow_ups_select" ON "public"."follow_ups" FOR SELECT USING (("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "follow_ups_staff_update" ON "public"."follow_ups" FOR UPDATE USING ((("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"])))) WITH CHECK (("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "follow_ups_staff_write" ON "public"."follow_ups" FOR INSERT WITH CHECK ((("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
ALTER TABLE "public"."insurance_providers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insurance_select_clinic" ON "public"."insurance_providers" FOR SELECT USING (("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "insurance_write_admin" ON "public"."insurance_providers" USING ((( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = 'admin'::"public"."user_role"));
CREATE POLICY "invitations_admin_all" ON "public"."staff_invitations" TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role"))) WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
ALTER TABLE "public"."medical_notes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "medical_notes_insert_admin" ON "public"."medical_notes" FOR INSERT TO "authenticated" WITH CHECK ((("public"."auth_role"() = 'admin'::"public"."user_role") AND ("doctor_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."patients" "p"
  WHERE (("p"."id" = "medical_notes"."patient_id") AND ("p"."clinic_id" = "public"."auth_clinic_id"()))))));
CREATE POLICY "medical_notes_select_admin" ON "public"."medical_notes" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = 'admin'::"public"."user_role") AND (EXISTS ( SELECT 1
   FROM "public"."patients" "p"
  WHERE (("p"."id" = "medical_notes"."patient_id") AND ("p"."clinic_id" = "public"."auth_clinic_id"()))))));
ALTER TABLE "public"."outstanding_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."patient_deposits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "patient_deposits_admin_delete" ON "public"."patient_deposits" FOR DELETE USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
CREATE POLICY "patient_deposits_select" ON "public"."patient_deposits" FOR SELECT USING (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "patient_deposits_staff_insert" ON "public"."patient_deposits" FOR INSERT WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
ALTER TABLE "public"."patients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "patients_insert_staff" ON "public"."patients" FOR INSERT TO "authenticated" WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
CREATE POLICY "patients_select_clinic" ON "public"."patients" FOR SELECT TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND (NOT "is_deleted")));
CREATE POLICY "patients_update_staff" ON "public"."patients" FOR UPDATE TO "authenticated" USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"])))) WITH CHECK (("clinic_id" = "public"."auth_clinic_id"()));
ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_insert_admin" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
CREATE POLICY "profiles_select_same_clinic" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("clinic_id" = "public"."auth_clinic_id"()));
CREATE POLICY "profiles_update_admin" ON "public"."profiles" FOR UPDATE USING ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role"))) WITH CHECK ((("clinic_id" = "public"."auth_clinic_id"()) AND ("public"."auth_role"() = 'admin'::"public"."user_role")));
CREATE POLICY "profiles_update_self" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));
ALTER TABLE "public"."services" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "services_admin_write" ON "public"."services" USING ((("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = 'admin'::"public"."user_role"))) WITH CHECK ((("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = 'admin'::"public"."user_role")));
CREATE POLICY "services_select" ON "public"."services" FOR SELECT USING (("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "settlements_select" ON "public"."outstanding_settlements" FOR SELECT USING (("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "settlements_staff_write" ON "public"."outstanding_settlements" FOR INSERT WITH CHECK ((("clinic_id" = ( SELECT "profiles"."clinic_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"public"."user_role", 'receptionist'::"public"."user_role"]))));
ALTER TABLE "public"."staff_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_customizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_read_own_customizations" ON "public"."user_customizations" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT ALL ON FUNCTION "public"."auth_clinic_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_clinic_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_clinic_id"() TO "service_role";
GRANT ALL ON FUNCTION "public"."auth_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_profile"() TO "service_role";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "service_role";
GRANT ALL ON FUNCTION "public"."enforce_appointment_transition"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_appointment_transition"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_appointment_transition"() TO "service_role";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";
GRANT ALL ON FUNCTION "public"."write_audit_log"() TO "anon";
GRANT ALL ON FUNCTION "public"."write_audit_log"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."write_audit_log"() TO "service_role";
GRANT ALL ON TABLE "public"."appointment_services" TO "anon";
GRANT ALL ON TABLE "public"."appointment_services" TO "authenticated";
GRANT ALL ON TABLE "public"."appointment_services" TO "service_role";
GRANT ALL ON TABLE "public"."appointments" TO "anon";
GRANT ALL ON TABLE "public"."appointments" TO "authenticated";
GRANT ALL ON TABLE "public"."appointments" TO "service_role";
GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";
GRANT ALL ON TABLE "public"."clinics" TO "anon";
GRANT ALL ON TABLE "public"."clinics" TO "authenticated";
GRANT ALL ON TABLE "public"."clinics" TO "service_role";
GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";
GRANT ALL ON TABLE "public"."feedback" TO "anon";
GRANT ALL ON TABLE "public"."feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."feedback" TO "service_role";
GRANT ALL ON TABLE "public"."follow_ups" TO "anon";
GRANT ALL ON TABLE "public"."follow_ups" TO "authenticated";
GRANT ALL ON TABLE "public"."follow_ups" TO "service_role";
GRANT ALL ON TABLE "public"."insurance_providers" TO "anon";
GRANT ALL ON TABLE "public"."insurance_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_providers" TO "service_role";
GRANT ALL ON TABLE "public"."medical_notes" TO "anon";
GRANT ALL ON TABLE "public"."medical_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."medical_notes" TO "service_role";
GRANT ALL ON TABLE "public"."outstanding_settlements" TO "anon";
GRANT ALL ON TABLE "public"."outstanding_settlements" TO "authenticated";
GRANT ALL ON TABLE "public"."outstanding_settlements" TO "service_role";
GRANT ALL ON TABLE "public"."patient_deposits" TO "anon";
GRANT ALL ON TABLE "public"."patient_deposits" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_deposits" TO "service_role";
GRANT ALL ON TABLE "public"."patients" TO "anon";
GRANT ALL ON TABLE "public"."patients" TO "authenticated";
GRANT ALL ON TABLE "public"."patients" TO "service_role";
GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT ALL ON TABLE "public"."services" TO "anon";
GRANT ALL ON TABLE "public"."services" TO "authenticated";
GRANT ALL ON TABLE "public"."services" TO "service_role";
GRANT ALL ON TABLE "public"."staff_invitations" TO "anon";
GRANT ALL ON TABLE "public"."staff_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_invitations" TO "service_role";
GRANT ALL ON TABLE "public"."user_customizations" TO "anon";
GRANT ALL ON TABLE "public"."user_customizations" TO "authenticated";
GRANT ALL ON TABLE "public"."user_customizations" TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
