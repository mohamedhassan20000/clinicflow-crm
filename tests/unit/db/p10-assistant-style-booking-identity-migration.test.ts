import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * P10 — the migration's own claims, asserted against its text.
 *
 * These are the properties that are cheap to lose in a later edit and expensive
 * to discover in production: that the migration only ever adds, that the weak
 * booking-identity column can never be mistaken for the verified one, and that
 * the new identification RPC is incapable of telling a stranger whether a
 * national id exists.
 *
 * The behavioural half — that the RPCs actually behave this way against a live
 * database — belongs to the integration suite. What is checked here is the
 * shape, which is what a reviewer reads.
 */
const migration = readFileSync(
  "supabase/migrations/20260824120000_p10_assistant_style_and_booking_identity.sql",
  "utf8",
);
const adminClient = readFileSync("lib/supabase/admin.ts", "utf8");
const authorization = readFileSync("lib/ai/patient-authorization.ts", "utf8");
const identityTool = readFileSync("lib/ai/tools/confirm-booking-identity.ts", "utf8");
const registerTool = readFileSync("lib/ai/tools/register-patient.ts", "utf8");
const databaseTypes = readFileSync("types/database.ts", "utf8");

describe("P10 migration · additive only", () => {
  it("adds columns and never drops or retypes one", () => {
    expect(migration).toContain("add column if not exists ai_language_mode");
    expect(migration).toContain("add column if not exists ai_arabic_style");
    expect(migration).toContain("add column if not exists ai_tone");
    expect(migration).toContain("add column if not exists ai_style_instruction");
    expect(migration).toContain("add column if not exists blood_type public.blood_type");
    expect(migration).toContain("add column if not exists full_name_original");
    expect(migration).toContain("add column if not exists booking_identity_confirmed_at");
    // Nothing is removed, renamed, or narrowed.
    expect(migration).not.toMatch(/drop column/i);
    expect(migration).not.toMatch(/drop table/i);
    expect(migration).not.toMatch(/alter column .* set not null/i);
  });

  it("defaults every new column to today's behaviour", () => {
    expect(migration).toContain("ai_language_mode text not null default 'auto'");
    expect(migration).toContain("ai_arabic_style text not null default 'auto'");
    expect(migration).toContain("ai_tone text not null default 'friendly'");
    // The two nullable ones carry no default at all, which is the same thing.
    expect(migration).toContain("check (ai_language_mode in ('auto', 'ar', 'en'))");
    expect(migration).toContain("check (ai_tone in ('friendly', 'neutral', 'formal'))");
  });

  it("keeps the old staging signature callable during a rolling deploy", () => {
    // Both new arguments default, so a build that lands before this migration
    // still calls a signature that exists.
    expect(migration).toContain("p_blood_type text default null");
    expect(migration).toContain("p_full_name_original text default null");
  });

  it("never lets a missing blood type erase one already collected", () => {
    expect(migration).toContain(
      "blood_type = coalesce(excluded.blood_type, ai_patient_intakes.blood_type)",
    );
  });

  it("carries the collected blood type onto the approved patient record", () => {
    const approve = migration.slice(
      migration.indexOf("function public.approve_ai_patient_intake"),
    );
    expect(approve).toContain("insert into public.patients");
    expect(approve).toContain("v_intake.blood_type");
  });
});

describe("P10 migration · booking identity is not verified identity", () => {
  it("writes only the weak column, never identity_verified_at", () => {
    const confirm = migration.slice(
      migration.indexOf("function public.confirm_patient_booking_identity"),
      migration.indexOf("function public.identify_patient_for_booking"),
    );
    expect(confirm).toContain("set booking_identity_confirmed_at = clock_timestamp()");
    // The single most important negative assertion in this file.
    expect(confirm).not.toContain("identity_verified_at");
  });

  it("does not verify identity when it matches a patient from another number", () => {
    const identify = migration.slice(
      migration.indexOf("function public.identify_patient_for_booking"),
      migration.indexOf("stage_patient_intake_from_conversation("),
    );
    expect(identify).toContain("booking_identity_confirmed_at = clock_timestamp()");
    expect(identify).not.toContain("set identity_verified_at");
    expect(identify).not.toContain("identity_verified_at = clock_timestamp()");
  });

  it("requires the thread's own number to confirm a linked file", () => {
    expect(migration).toContain(
      "v_patient.phone is distinct from v_conversation.participant_address",
    );
    expect(migration).toContain("status := 'phone_mismatch'");
  });

  it("matches an exact, normalized name AND national id, and nothing fuzzy", () => {
    const identify = migration.slice(
      migration.indexOf("function public.identify_patient_for_booking"),
    );
    expect(identify).toContain("public.fold_national_id(p.national_id) = public.fold_national_id(p_national_id)");
    expect(identify).toContain("public.fold_patient_name(p.full_name) = public.fold_patient_name(p_full_name)");
    // Exactly one live record, or nothing.
    expect(identify).toContain("if v_count <> 1 then");
  });

  it("cannot be used as an existence oracle for a national id", () => {
    const identify = migration.slice(
      migration.indexOf("function public.identify_patient_for_booking"),
      migration.indexOf("stage_patient_intake_from_conversation("),
    );
    // Every failure is the same word, and it is rate-limited on the same
    // counter the date-of-birth check uses.
    expect(identify).toContain("status := case when v_failures >= 5 then 'locked' else 'no_match' end");
    expect(identify).toContain("identity_verification_failures");
    expect(identify).not.toContain("'id_taken'");
    expect(identify).not.toContain("'name_mismatch'");
  });

  it("refuses every new RPC to anything but the service role", () => {
    for (const fn of [
      "confirm_patient_booking_identity",
      "identify_patient_for_booking",
      "set_clinic_ai_communication_style",
    ]) {
      expect(migration, fn).toContain(`revoke all on function public.${fn}`);
      expect(migration, fn).toContain("from public, anon, authenticated;");
      expect(migration, fn).toContain(`grant execute on function public.${fn}`);
    }
    expect(migration).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
  });

  it("keeps the disclosure gate reading the verified column alone", () => {
    // `requireVerified` is what every clinical/appointment path passes, and it
    // reads `identityVerifiedAt`. If a future edit made it consult the booking
    // column, this is the assertion that would fail.
    const verifiedBranch = authorization.slice(
      authorization.indexOf("if (options.requireVerified"),
      authorization.indexOf("return resolved;"),
    );
    expect(verifiedBranch).toContain("resolved.identityVerifiedAt");
    expect(verifiedBranch).not.toContain("bookingIdentityConfirmedAt");
  });

  it("tells the model, in the tool result, that booking is not disclosure", () => {
    expect(identityTool).toContain("clinical_disclosure_allowed: false");
    expect(identityTool).toContain("does NOT allow showing appointments");
    expect(identityTool).toContain("verify_patient_identity");
    // And never names which half of a failed identification was wrong. The
    // sentence is wrapped across two source lines, so the assertion is on the
    // distinctive half rather than on a formatting accident.
    expect(identityTool).toContain("whether the name or the id was the problem");
    expect(identityTool).toContain("never say whether that id belongs to");
  });
});

describe("P10 migration · the assistant's configured register", () => {
  it("returns the style and the booking facts from the resolver the tools use", () => {
    const resolver = migration.slice(
      migration.indexOf("function public.resolve_patient_ai_context"),
      migration.indexOf("function public.set_clinic_ai_communication_style"),
    );
    for (const column of [
      "ai_language_mode text",
      "ai_arabic_style text",
      "ai_tone text",
      "ai_style_instruction text",
      "booking_identity_confirmed_at timestamptz",
      "patient_display_name text",
    ]) {
      expect(resolver, column).toContain(column);
    }
    // The patient's name is returned only for a live, linked patient.
    expect(resolver).toContain("case when patient.id is null then null else patient.full_name end");
  });

  it("bounds the clinic-authored style line in the database as well as the prompt", () => {
    expect(migration).toContain("char_length(ai_style_instruction) <= 280");
    expect(migration).toContain("nullif(btrim(coalesce(p_style_instruction, '')), '')");
  });

  it("is wired through the reviewed admin helpers rather than a raw client", () => {
    expect(adminClient).toContain("setClinicAiCommunicationStyle");
    expect(adminClient).toContain("confirmPatientBookingIdentity");
    expect(adminClient).toContain("identifyPatientForBooking");
    expect(adminClient).toContain("getClinicCurrency");
  });

  it("passes the transliterated name and the original through to staging", () => {
    expect(registerTool).toContain("fullName: filedName");
    expect(registerTool).toContain("fullNameOriginal: originalName");
    expect(registerTool).toContain("name_spelling_confirmation_required");
  });

  it("is reflected in the generated database types", () => {
    for (const symbol of [
      "ai_language_mode",
      "ai_arabic_style",
      "ai_tone",
      "ai_style_instruction",
      "booking_identity_confirmed_at",
      "confirm_patient_booking_identity",
      "identify_patient_for_booking",
      "set_clinic_ai_communication_style",
      "p_blood_type",
      "p_full_name_original",
    ]) {
      expect(databaseTypes, symbol).toContain(symbol);
    }
  });
});
