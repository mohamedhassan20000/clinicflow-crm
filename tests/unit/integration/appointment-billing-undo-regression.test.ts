import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { computeBillingUndoEligibility } from "@/lib/appointments/billing-undo";

const runLinked = process.env.RUN_LINKED_UNDO_REGRESSION === "1";
const describeLinked = runLinked ? describe : describe.skip;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const suffix = `undo-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "UndoRegression12345!";
const ids = {
  clinic: randomUUID(),
  department: randomUUID(),
  patient: randomUUID(),
  admin: "",
  doctor: "",
};

type DbClient = SupabaseClient<Database>;
let service: DbClient;
let admin: DbClient;
let doctor: DbClient;
const appointmentIds: string[] = [];

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${randomUUID()}`,
    },
  });
}

async function must<T>(
  operation: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  label: string,
): Promise<T | null> {
  const { data, error } = await operation;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function createUser(email: string) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? "create user failed");
  return data.user.id;
}

async function signIn(target: DbClient, email: string) {
  const { error } = await target.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function createAppointment(index: number) {
  const id = randomUUID();
  appointmentIds.push(id);
  await must(
    service.from("appointments").insert({
      id,
      clinic_id: ids.clinic,
      patient_id: ids.patient,
      doctor_id: ids.doctor,
      department_id: ids.department,
      scheduled_at: new Date(
        Date.UTC(2099, 0, 1, 9, index * 30),
      ).toISOString(),
      duration_minutes: 30,
      status: "confirmed",
      created_by: ids.admin,
    }),
    "create appointment",
  );
  return id;
}

async function latestBillingEvent(appointmentId: string) {
  const { data, error } = await service
    .from("activity_events")
    .select("id, action, occurred_at, previous_state")
    .eq("clinic_id", ids.clinic)
    .eq("entity_type", "appointment")
    .eq("entity_id", appointmentId)
    .in("action", [
      "appointment.completed",
      "appointment.billing_completion_undone",
    ])
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  if (!runLinked) return;
  if (!url || !publishableKey || !serviceKey) {
    throw new Error("Linked Supabase environment is incomplete");
  }
  service = createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  admin = client();
  doctor = client();

  const adminEmail = `${suffix}-admin@example.com`;
  const doctorEmail = `${suffix}-doctor@example.com`;
  ids.admin = await createUser(adminEmail);
  ids.doctor = await createUser(doctorEmail);

  await must(
    service.from("clinics").insert({
      id: ids.clinic,
      name: `Undo Regression ${suffix}`,
      onboarding_completed_at: new Date().toISOString(),
    }),
    "create clinic",
  );
  const plan = (await must(
    service.from("plans").select("id").eq("slug", "basic").single(),
    "load plan",
  )) as { id: string } | null;
  if (!plan) throw new Error("basic plan missing");
  await must(
    service.from("subscriptions").insert({
      clinic_id: ids.clinic,
      plan_id: plan.id,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    "create subscription",
  );
  await must(
    service.from("departments").insert({
      id: ids.department,
      clinic_id: ids.clinic,
      name: `Undo Regression Dept ${suffix}`,
      color: "#0d9488",
    }),
    "create department",
  );
  await must(
    service.from("profiles").insert([
      {
        id: ids.admin,
        clinic_id: ids.clinic,
        full_name: "Undo Regression Admin",
        role: "admin",
        must_change_password: false,
      },
      {
        id: ids.doctor,
        clinic_id: ids.clinic,
        department_id: ids.department,
        full_name: "Undo Regression Doctor",
        role: "doctor",
        must_change_password: false,
      },
    ]),
    "create profiles",
  );
  await must(
    service.from("patients").insert({
      id: ids.patient,
      clinic_id: ids.clinic,
      full_name: "Undo Regression Patient",
      date_of_birth: "1990-01-01",
      phone: "05550000000",
      email: `${suffix}-patient@example.com`,
      national_id: `${suffix}-N`,
      file_number: `${suffix}-F`,
      department_id: ids.department,
      assigned_doctor_id: ids.doctor,
      created_by: ids.admin,
    }),
    "create patient",
  );
  await signIn(admin, adminEmail);
  await signIn(doctor, doctorEmail);
}, 30_000);

afterAll(async () => {
  if (!runLinked || !service) return;
  const cleanupOperations = [
    service
      .from("appointment_services")
      .delete()
      .in("appointment_id", appointmentIds),
    service.from("outstanding_settlements").delete().eq("clinic_id", ids.clinic),
    service.from("follow_ups").delete().eq("clinic_id", ids.clinic),
    service.from("appointments").delete().eq("clinic_id", ids.clinic),
    service.from("patient_deposits").delete().eq("clinic_id", ids.clinic),
    service.from("patients").delete().eq("clinic_id", ids.clinic),
    service.from("subscriptions").delete().eq("clinic_id", ids.clinic),
    service.from("profiles").delete().eq("clinic_id", ids.clinic),
    service.from("departments").delete().eq("clinic_id", ids.clinic),
    service.from("clinics").delete().eq("id", ids.clinic),
  ];
  for (const operation of cleanupOperations) {
    const { error } = await operation;
    if (error) throw new Error(`linked fixture cleanup failed: ${error.message}`);
  }
  for (const userId of [ids.admin, ids.doctor].filter(Boolean)) {
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) throw new Error(`linked auth cleanup failed: ${error.message}`);
  }
}, 30_000);

describeLinked("linked appointment billing Undo regression", () => {
  const cases = [
    {
      name: "without insurance",
      total: 100,
      paid: 100,
      secondary: 0,
      insurance: 0,
      mode: "amount" as const,
      percentage: null,
      responsibility: 100,
    },
    {
      name: "with fixed insurance",
      total: 100,
      paid: 70,
      secondary: 0,
      insurance: 30,
      mode: "amount" as const,
      percentage: null,
      responsibility: 70,
    },
    {
      name: "with percentage insurance and split payment",
      total: 1_000,
      paid: 500,
      secondary: 350,
      insurance: 150,
      mode: "percentage" as const,
      percentage: 15,
      responsibility: 850,
    },
  ];

  it.each(cases)(
    "completes and safely undoes $name",
    async (scenario) => {
      const appointmentId = await createAppointment(
        appointmentIds.length + 1,
      );
      const completion = await admin.rpc("complete_appointment_billing", {
        p_appointment_id: appointmentId,
        p_line_items: [
          {
            name: scenario.name,
            price: scenario.total,
            quantity: 1,
          },
        ],
        p_paid_amount: scenario.paid,
        p_payment_method: "cash",
        p_insurance_amount: scenario.insurance,
        p_secondary_payment_method:
          scenario.secondary > 0 ? "credit_card" : null,
        p_secondary_amount: scenario.secondary,
        p_deposit_amount: 0,
        p_payment_note: null,
        p_insurance_calculation_mode: scenario.mode,
        p_insurance_percentage: scenario.percentage,
        p_patient_responsibility: scenario.responsibility,
      });
      expect(completion.error).toBeNull();

      const completed = (await must(
        service
          .from("appointments")
          .select(
            "status, paid_at, total_amount, paid_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, secondary_amount, deposit_amount, outstanding_amount, payment_method, secondary_payment_method",
          )
          .eq("id", appointmentId)
          .single(),
        "load completed appointment",
      )) as {
        status: string;
        paid_at: string | null;
        total_amount: number | null;
        paid_amount: number | null;
        insurance_amount: number | null;
        insurance_calculation_mode: string;
        insurance_percentage: number | null;
        patient_responsibility: number | null;
        secondary_amount: number;
        deposit_amount: number;
        outstanding_amount: number | null;
        payment_method: string | null;
        secondary_payment_method: string | null;
      } | null;
      expect(completed).toMatchObject({
        status: "completed",
        total_amount: scenario.total,
        paid_amount: scenario.paid,
        insurance_amount: scenario.insurance,
        insurance_calculation_mode: scenario.mode,
        insurance_percentage: scenario.percentage,
        patient_responsibility: scenario.responsibility,
        secondary_amount: scenario.secondary,
      });

      const event = await latestBillingEvent(appointmentId);
      const eligibility = computeBillingUndoEligibility({
        currentStatus: completed?.status ?? null,
        role: "admin",
        latestBillingEvent: event,
      });
      expect(eligibility).toMatchObject({
        canUndo: true,
        reason: "eligible",
        targetStatus: "confirmed",
      });

      const unauthorized = await doctor.rpc("undo_appointment_billing", {
        p_appointment_id: appointmentId,
        p_target_status: "confirmed",
      });
      expect(unauthorized.error).toMatchObject({ code: "42501" });

      const undo = await admin.rpc("undo_appointment_billing", {
        p_appointment_id: appointmentId,
        p_target_status: eligibility.targetStatus!,
      });
      expect(undo.error).toBeNull();

      const [restored, services, events] = await Promise.all([
        must(
          service
            .from("appointments")
            .select(
              "status, paid_at, total_amount, paid_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, secondary_amount, deposit_amount, outstanding_amount, payment_method, secondary_payment_method",
            )
            .eq("id", appointmentId)
            .single(),
          "load restored appointment",
        ),
        must(
          service
            .from("appointment_services")
            .select("id")
            .eq("appointment_id", appointmentId),
          "load restored services",
        ),
        must(
          service
            .from("activity_events")
            .select("id, action, occurred_at, metadata")
            .eq("entity_id", appointmentId)
            .order("occurred_at", { ascending: true })
            .order("id", { ascending: true }),
          "load activity events",
        ),
      ]);

      expect(restored).toEqual({
        status: "confirmed",
        paid_at: null,
        total_amount: null,
        paid_amount: null,
        insurance_amount: null,
        insurance_calculation_mode: "amount",
        insurance_percentage: null,
        patient_responsibility: null,
        secondary_amount: 0,
        deposit_amount: 0,
        outstanding_amount: null,
        payment_method: null,
        secondary_payment_method: null,
      });
      expect(services).toEqual([]);
      const completionEvents =
        events?.filter((item) => item.action === "appointment.completed") ?? [];
      const undoEvents =
        events?.filter(
          (item) =>
            item.action === "appointment.billing_completion_undone",
        ) ?? [];
      expect(completionEvents).toHaveLength(1);
      expect(undoEvents).toHaveLength(1);
      expect(undoEvents[0]?.metadata).toMatchObject({
        operation: "undo",
        original_action: "appointment.completed",
        original_event_id: completionEvents[0]?.id,
        target_status: "confirmed",
      });
      expect(
        events?.filter((item) => item.action === "appointment.created"),
      ).toHaveLength(1);
      expect(
        events?.filter((item) => item.action === "appointment.deleted"),
      ).toHaveLength(0);

      console.info("linked_appointment_billing_undo_verified", {
        scenario: scenario.name,
        appointmentAfterCompletion: completed,
        latestBillingEvents: events,
        eligibilityBeforeUndo: eligibility,
        unauthorizedRpcError: unauthorized.error,
        undoRpcError: undo.error,
        appointmentAfterUndo: restored,
      });
    },
    30_000,
  );
});
