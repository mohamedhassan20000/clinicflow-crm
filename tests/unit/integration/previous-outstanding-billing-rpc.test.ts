import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const LOCAL_SUPABASE_URL =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function requireTestEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env.local before running integration tests.`);
  return v;
}

const LOCAL_SUPABASE_PUBLISHABLE_KEY = requireTestEnv("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const LOCAL_SUPABASE_SECRET_KEY = requireTestEnv("LOCAL_SUPABASE_SECRET_KEY");

type DbClient = SupabaseClient<Database>;

const suiteIds = {
  clinic: randomUUID(),
  dept: randomUUID(),
} as const;
const suiteMinuteOffset = Math.floor(Math.random() * 500_000);
let fixtureCounter = 0;

function futureSlot(minutesFromSuiteStart: number) {
  return new Date(
    Date.UTC(2099, 0, 1, 9, suiteMinuteOffset + minutesFromSuiteStart),
  ).toISOString();
}

function createFixtureIds() {
  const slotOffset = ++fixtureCounter * 10;
  return {
    clinic: suiteIds.clinic,
    dept: suiteIds.dept,
    patient: randomUUID(),
    oldAppointment1: randomUUID(),
    oldAppointment2: randomUUID(),
    replacementOriginal: randomUUID(),
    currentAppointment: randomUUID(),
    oldAppointment1At: futureSlot(slotOffset),
    oldAppointment2At: futureSlot(slotOffset + 1),
    replacementOriginalAt: futureSlot(slotOffset + 2),
    currentAppointmentAt: futureSlot(slotOffset + 3),
  } as const;
}

let ids = createFixtureIds();

const suffix = `phase11-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase11Test12345";
const emails = {
  admin: `${suffix}-admin@example.com`,
  doctor: `${suffix}-doctor@example.com`,
};
const userIds = {
  admin: "",
  doctor: "",
};

const service = createClient<Database>(
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

let adminClient: DbClient;

function assertNoError<T extends { error: { message: string } | null }>(
  result: T,
  context: string,
): T {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result;
}

function client() {
  return createClient<Database>(
    LOCAL_SUPABASE_URL,
    LOCAL_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        storageKey: `clinic-crm-phase11-${Math.random().toString(36).slice(2)}`,
      },
    },
  );
}

async function createAuthUsers() {
  for (const key of Object.keys(emails) as (keyof typeof emails)[]) {
    const { data, error } = await service.auth.admin.createUser({
      email: emails[key],
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(error?.message ?? `Failed to create ${key}`);
    }
    userIds[key] = data.user.id;
  }
}

async function signInAdmin() {
  adminClient = client();
  const { error } = await adminClient.auth.signInWithPassword({
    email: emails.admin,
    password,
  });
  if (error) throw new Error(error.message);
}

async function seedSuiteData() {
  assertNoError(
    await service.from("clinics").insert({
      id: suiteIds.clinic,
      name: `Phase 11 Clinic ${suffix}`,
    }),
    "seed suite clinic",
  );
  assertNoError(
    await service.from("departments").insert({
      id: suiteIds.dept,
      clinic_id: suiteIds.clinic,
      name: `Phase 11 Dept ${suffix}`,
    }),
    "seed suite department",
  );
  assertNoError(
    await service.from("profiles").insert([
      {
        id: userIds.admin,
        clinic_id: suiteIds.clinic,
        full_name: "Phase 11 Admin",
        role: "admin",
      },
      {
        id: userIds.doctor,
        clinic_id: suiteIds.clinic,
        department_id: suiteIds.dept,
        full_name: "Phase 11 Doctor",
        role: "doctor",
      },
    ]),
    "seed suite profiles",
  );
}

async function seedBaseData({
  firstOutstanding = 30,
  secondOutstanding = 50,
  currentOutstanding = null,
}: {
  firstOutstanding?: number;
  secondOutstanding?: number;
  currentOutstanding?: number | null;
} = {}) {
  const fixtureSuffix = ids.patient.slice(0, 8);
  assertNoError(
    await service.from("patients").insert({
      id: ids.patient,
      clinic_id: ids.clinic,
      full_name: "Phase 11 Patient",
      date_of_birth: "1990-01-01",
      phone: "05551231234",
      email: `${suffix}-${fixtureSuffix}-patient@example.com`,
      national_id: `${suffix}-${fixtureSuffix}P`,
      file_number: `${suffix}-${fixtureSuffix}-P`,
      department_id: ids.dept,
      assigned_doctor_id: userIds.doctor,
      created_by: userIds.admin,
    }),
    "seed patient",
  );
  assertNoError(
    await service.from("appointments").insert([
      {
        id: ids.oldAppointment1,
        clinic_id: ids.clinic,
        patient_id: ids.patient,
        doctor_id: userIds.doctor,
        department_id: ids.dept,
        scheduled_at: ids.oldAppointment1At,
        duration_minutes: 30,
        status: "completed",
        total_amount: 100,
        paid_amount: 70,
        outstanding_amount: firstOutstanding,
        payment_method: "cash",
        paid_at: "2099-01-01T10:00:00.000Z",
        created_by: userIds.admin,
      },
      {
        id: ids.oldAppointment2,
        clinic_id: ids.clinic,
        patient_id: ids.patient,
        doctor_id: userIds.doctor,
        department_id: ids.dept,
        scheduled_at: ids.oldAppointment2At,
        duration_minutes: 30,
        status: "completed",
        total_amount: 100,
        paid_amount: 50,
        outstanding_amount: secondOutstanding,
        payment_method: "cash",
        paid_at: "2099-01-02T10:00:00.000Z",
        created_by: userIds.admin,
      },
      {
        id: ids.replacementOriginal,
        clinic_id: ids.clinic,
        patient_id: ids.patient,
        doctor_id: userIds.doctor,
        department_id: ids.dept,
        scheduled_at: ids.replacementOriginalAt,
        duration_minutes: 30,
        status: "replaced",
        created_by: userIds.admin,
        replaced_by_appointment_id: ids.currentAppointment,
      },
      {
        id: ids.currentAppointment,
        clinic_id: ids.clinic,
        patient_id: ids.patient,
        doctor_id: userIds.doctor,
        department_id: ids.dept,
        scheduled_at: ids.currentAppointmentAt,
        duration_minutes: 30,
        status: "confirmed",
        outstanding_amount: currentOutstanding,
        created_by: userIds.admin,
        replaces_appointment_id: ids.replacementOriginal,
        original_appointment_id: ids.replacementOriginal,
      },
    ]),
    "seed appointments",
  );
}

async function completeWithPrevious(previousAmount: number) {
  return adminClient.rpc("complete_appointment_billing_with_previous_settlement", {
    p_appointment_id: ids.currentAppointment,
    p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
    p_paid_amount: 100,
    p_payment_method: "cash",
    p_insurance_amount: 0,
    p_insurance_calculation_mode: "amount",
    p_insurance_percentage: null,
    p_patient_responsibility: 100,
    p_secondary_payment_method: null,
    p_secondary_amount: 0,
    p_deposit_amount: 0,
    p_payment_note: null,
    p_previous_settlement_amount: previousAmount,
    p_previous_payment_method: previousAmount > 0 ? "cash" : null,
    p_previous_note: previousAmount > 0 ? "Paid with current invoice" : null,
  });
}

async function completeCurrent(
  overrides: Partial<{
    p_line_items: Array<{
      service_id?: string | null;
      name: string;
      price: number;
      quantity: number;
    }>;
    p_paid_amount: number;
    p_payment_method:
      | "cash"
      | "credit_card"
      | "paypal"
      | "bank_transfer"
      | "insurance";
    p_insurance_amount: number;
    p_insurance_calculation_mode: "amount" | "percentage";
    p_insurance_percentage: number | null;
    p_patient_responsibility: number;
    p_secondary_payment_method:
      | "cash"
      | "credit_card"
      | "paypal"
      | "bank_transfer"
      | "insurance";
    p_secondary_amount: number;
    p_deposit_amount: number;
    p_payment_note: string;
  }> = {},
) {
  return adminClient.rpc("complete_appointment_billing", {
    p_appointment_id: ids.currentAppointment,
    p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
    p_paid_amount: 100,
    p_payment_method: "cash",
    p_insurance_amount: 0,
    p_insurance_calculation_mode: "amount",
    p_insurance_percentage: null,
    p_patient_responsibility: 100,
    p_secondary_payment_method: null,
    p_secondary_amount: 0,
    p_deposit_amount: 0,
    p_payment_note: null,
    ...overrides,
  });
}

async function undoCurrent(targetStatus: "pending" | "confirmed" = "confirmed") {
  return adminClient.rpc("undo_appointment_billing", {
    p_appointment_id: ids.currentAppointment,
    p_target_status: targetStatus,
  });
}

async function undoWithPrevious(targetStatus: "pending" | "confirmed" = "confirmed") {
  return adminClient.rpc("undo_appointment_billing_with_previous_settlement", {
    p_appointment_id: ids.currentAppointment,
    p_target_status: targetStatus,
  });
}

beforeAll(async () => {
  const { error } = await service.from("clinics").select("id").limit(1);
  if (error) {
    throw new Error(
      `Local Supabase is unavailable or not migrated: ${error.message}`,
    );
  }
  await createAuthUsers();
  await seedSuiteData();
  await signInAdmin();
}, 30_000);

beforeEach(async () => {
  ids = createFixtureIds();
  await seedBaseData();
});

describe("complete_appointment_billing_with_previous_settlement", () => {
  it("preserves normal completion behavior when previous settlement is zero", async () => {
    const { data, error } = await completeWithPrevious(0);

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      current_total: 100,
      current_collected: 100,
      current_outstanding: 0,
      previous_outstanding_before: 80,
      previous_settled_now: 0,
      previous_outstanding_after: 80,
      affected_prior_appointment_ids: [],
    });

    const [{ data: current }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("status, total_amount, paid_amount, outstanding_amount")
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("outstanding_settlements")
        .select("id")
        .eq("source_appointment_id", ids.currentAppointment),
    ]);

    expect(current).toMatchObject({
      status: "completed",
      total_amount: 100,
      paid_amount: 100,
      outstanding_amount: 0,
    });
    expect(settlements).toEqual([]);
  });

  it("fully pays an active replacement appointment without breaking its chain", async () => {
    const { error } = await completeCurrent();
    expect(error).toBeNull();

    const [current, predecessor, events] = await Promise.all([
      service
        .from("appointments")
        .select(
          "status, total_amount, paid_amount, outstanding_amount, replaces_appointment_id, original_appointment_id",
        )
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("appointments")
        .select("status, replaced_by_appointment_id")
        .eq("id", ids.replacementOriginal)
        .single(),
      service
        .from("activity_events")
        .select("action")
        .eq("entity_id", ids.currentAppointment),
    ]);

    expect(current.data).toMatchObject({
      status: "completed",
      total_amount: 100,
      paid_amount: 100,
      outstanding_amount: 0,
      replaces_appointment_id: ids.replacementOriginal,
      original_appointment_id: ids.replacementOriginal,
    });
    expect(predecessor.data).toEqual({
      status: "replaced",
      replaced_by_appointment_id: ids.currentAppointment,
    });
    expect(events.data?.filter((event) => event.action === "appointment.completed"))
      .toHaveLength(1);
    expect(events.data?.filter((event) => event.action === "appointment.deleted"))
      .toHaveLength(0);
  });

  it("records a fully paid split payment on an active replacement appointment", async () => {
    const { error } = await completeCurrent({
      p_paid_amount: 60,
      p_secondary_payment_method: "credit_card",
      p_secondary_amount: 40,
      p_payment_note: "Split payment",
    });
    expect(error).toBeNull();

    const { data } = await service
      .from("appointments")
      .select(
        "status, paid_amount, payment_method, secondary_amount, secondary_payment_method, outstanding_amount",
      )
      .eq("id", ids.currentAppointment)
      .single();
    expect(data).toEqual({
      status: "completed",
      paid_amount: 60,
      payment_method: "cash",
      secondary_amount: 40,
      secondary_payment_method: "credit_card",
      outstanding_amount: 0,
    });
  });

  it("records fixed insurance with one patient payment method", async () => {
    const { error } = await completeCurrent({
      p_paid_amount: 85,
      p_insurance_amount: 15,
      p_patient_responsibility: 85,
    });
    expect(error).toBeNull();

    const { data } = await service
      .from("appointments")
      .select(
        "total_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, paid_amount, secondary_amount, deposit_amount, outstanding_amount",
      )
      .eq("id", ids.currentAppointment)
      .single();
    expect(data).toEqual({
      total_amount: 100,
      insurance_amount: 15,
      insurance_calculation_mode: "amount",
      insurance_percentage: null,
      patient_responsibility: 85,
      paid_amount: 85,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: 0,
    });
  });

  it("records percentage insurance with one patient payment method", async () => {
    const { error } = await completeCurrent({
      p_paid_amount: 85,
      p_insurance_amount: 15,
      p_insurance_calculation_mode: "percentage",
      p_insurance_percentage: 15,
      p_patient_responsibility: 85,
    });
    expect(error).toBeNull();

    const { data } = await service
      .from("appointments")
      .select(
        "insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, paid_amount, outstanding_amount",
      )
      .eq("id", ids.currentAppointment)
      .single();
    expect(data).toEqual({
      insurance_amount: 15,
      insurance_calculation_mode: "percentage",
      insurance_percentage: 15,
      patient_responsibility: 85,
      paid_amount: 85,
      outstanding_amount: 0,
    });
  });

  it("completes, saves, undoes, and completes the exact screenshot allocation again", async () => {
    const screenshotAllocation = {
      p_line_items: [{ name: "Treatment", price: 5800, quantity: 1 }],
      p_paid_amount: 2800,
      p_insurance_amount: 870,
      p_insurance_calculation_mode: "percentage" as const,
      p_insurance_percentage: 15,
      p_patient_responsibility: 4930,
      p_secondary_payment_method: "credit_card" as const,
      p_secondary_amount: 2130,
    };

    const firstCompletion = await completeCurrent(screenshotAllocation);
    expect(firstCompletion.error).toBeNull();

    const [{ data: saved }, { data: lines }, { data: completedEvents }] =
      await Promise.all([
        service
          .from("appointments")
          .select(
            "status, total_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, paid_amount, payment_method, secondary_amount, secondary_payment_method, deposit_amount, outstanding_amount",
          )
          .eq("id", ids.currentAppointment)
          .single(),
        service
          .from("appointment_services")
          .select("name, price, quantity")
          .eq("appointment_id", ids.currentAppointment),
        service
          .from("activity_events")
          .select("action, new_state")
          .eq("entity_id", ids.currentAppointment)
          .eq("action", "appointment.completed"),
      ]);

    expect(saved).toEqual({
      status: "completed",
      total_amount: 5800,
      insurance_amount: 870,
      insurance_calculation_mode: "percentage",
      insurance_percentage: 15,
      patient_responsibility: 4930,
      paid_amount: 2800,
      payment_method: "cash",
      secondary_amount: 2130,
      secondary_payment_method: "credit_card",
      deposit_amount: 0,
      outstanding_amount: 0,
    });
    expect(lines).toEqual([{ name: "Treatment", price: 5800, quantity: 1 }]);
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents?.[0]?.new_state).toMatchObject({
      total_amount: 5800,
      insurance_amount: 870,
      insurance_calculation_mode: "percentage",
      insurance_percentage: 15,
      patient_responsibility: 4930,
      paid_amount: 2800,
      secondary_amount: 2130,
      deposit_amount: 0,
      outstanding_amount: 0,
    });

    const undo = await undoCurrent();
    expect(undo.error).toBeNull();
    const { data: reopened } = await service
      .from("appointments")
      .select(
        "status, total_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, paid_amount, secondary_amount, deposit_amount, outstanding_amount",
      )
      .eq("id", ids.currentAppointment)
      .single();
    expect(reopened).toEqual({
      status: "confirmed",
      total_amount: null,
      insurance_amount: null,
      insurance_calculation_mode: "amount",
      insurance_percentage: null,
      patient_responsibility: null,
      paid_amount: null,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: null,
    });

    const secondCompletion = await completeCurrent(screenshotAllocation);
    expect(secondCompletion.error).toBeNull();
  });

  it("records a partial payment and outstanding balance on an active replacement appointment", async () => {
    const { error } = await completeCurrent({
      p_paid_amount: 35,
      p_secondary_payment_method: "credit_card",
      p_secondary_amount: 15,
    });
    expect(error).toBeNull();

    const { data } = await service
      .from("appointments")
      .select(
        "status, total_amount, paid_amount, secondary_amount, outstanding_amount",
      )
      .eq("id", ids.currentAppointment)
      .single();
    expect(data).toEqual({
      status: "completed",
      total_amount: 100,
      paid_amount: 35,
      secondary_amount: 15,
      outstanding_amount: 50,
    });
  });

  it("rolls back appointment and service changes if a later billing write fails", async () => {
    const { error } = await completeCurrent({
      p_line_items: [
        {
          service_id: randomUUID(),
          name: "Missing service",
          price: 100,
          quantity: 1,
        },
      ],
    });
    expect(error?.code).toBe("23503");

    const [current, predecessor, lines] = await Promise.all([
      service
        .from("appointments")
        .select(
          "status, total_amount, paid_amount, outstanding_amount, replaces_appointment_id",
        )
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("appointments")
        .select("status, replaced_by_appointment_id")
        .eq("id", ids.replacementOriginal)
        .single(),
      service
        .from("appointment_services")
        .select("id")
        .eq("appointment_id", ids.currentAppointment),
    ]);
    expect(current.data).toEqual({
      status: "confirmed",
      total_amount: null,
      paid_amount: null,
      outstanding_amount: null,
      replaces_appointment_id: ids.replacementOriginal,
    });
    expect(predecessor.data).toEqual({
      status: "replaced",
      replaced_by_appointment_id: ids.currentAppointment,
    });
    expect(lines.data).toEqual([]);
  });

  it("rejects negative previous settlement without partial changes", async () => {
    const { error } = await completeWithPrevious(-1);

    expect(error?.message).toContain(
      "Previous settlement amount cannot be negative",
    );

    const [{ data: current }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("status")
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("outstanding_settlements")
        .select("id")
        .eq("source_appointment_id", ids.currentAppointment),
    ]);
    expect(current?.status).toBe("confirmed");
    expect(settlements).toEqual([]);
  });

  it("rejects settlement above prior outstanding and excludes current appointment debt", async () => {
    ids = createFixtureIds();
    await seedBaseData({
      firstOutstanding: 30,
      secondOutstanding: 20,
      currentOutstanding: 100,
    });

    const { error } = await completeWithPrevious(75);

    expect(error?.message).toContain(
      "Previous settlement exceeds previous outstanding balance",
    );

    const { data: current } = await service
      .from("appointments")
      .select("status, outstanding_amount")
      .eq("id", ids.currentAppointment)
      .single();
    expect(current).toMatchObject({
      status: "confirmed",
      outstanding_amount: 100,
    });
  });

  it("allocates previous settlement oldest-first and records provenance", async () => {
    const { data, error } = await completeWithPrevious(60);

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      previous_outstanding_before: 80,
      previous_settled_now: 60,
      previous_outstanding_after: 20,
      affected_prior_appointment_ids: [
        ids.oldAppointment1,
        ids.oldAppointment2,
      ],
    });

    const [{ data: prior }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("id, outstanding_amount")
        .in("id", [ids.oldAppointment1, ids.oldAppointment2])
        .order("scheduled_at", { ascending: true }),
      service
        .from("outstanding_settlements")
        .select("appointment_id, source_appointment_id, amount, payment_method, note")
        .eq("source_appointment_id", ids.currentAppointment)
        .order("amount", { ascending: false }),
    ]);

    expect(prior).toEqual([
      { id: ids.oldAppointment1, outstanding_amount: 0 },
      { id: ids.oldAppointment2, outstanding_amount: 20 },
    ]);
    expect(settlements).toEqual([
      {
        appointment_id: ids.oldAppointment1,
        source_appointment_id: ids.currentAppointment,
        amount: 30,
        payment_method: "cash",
        note: "Paid with current invoice",
      },
      {
        appointment_id: ids.oldAppointment2,
        source_appointment_id: ids.currentAppointment,
        amount: 30,
        payment_method: "cash",
        note: "Paid with current invoice",
      },
    ]);
  });

  it("undo restores prior balances and removes provenance settlement rows", async () => {
    const complete = await completeWithPrevious(60);
    expect(complete.error).toBeNull();

    const { data, error } = await undoWithPrevious();

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      reversed_amount: 60,
    });
    expect(data?.[0]?.affected_prior_appointment_ids).toEqual(
      expect.arrayContaining([ids.oldAppointment1, ids.oldAppointment2]),
    );

    const [
      { data: prior },
      { data: current },
      { data: settlements },
      { data: events },
    ] =
      await Promise.all([
        service
          .from("appointments")
          .select("id, outstanding_amount")
          .in("id", [ids.oldAppointment1, ids.oldAppointment2])
          .order("scheduled_at", { ascending: true }),
        service
          .from("appointments")
          .select("status, total_amount, paid_amount, outstanding_amount")
          .eq("id", ids.currentAppointment)
          .single(),
        service
          .from("outstanding_settlements")
          .select("id")
          .eq("source_appointment_id", ids.currentAppointment),
        service
          .from("activity_events")
          .select("id, action, actor_id, metadata, previous_state, new_state")
          .eq("entity_id", ids.currentAppointment)
          .order("occurred_at", { ascending: true }),
      ]);

    expect(prior).toEqual([
      { id: ids.oldAppointment1, outstanding_amount: 30 },
      { id: ids.oldAppointment2, outstanding_amount: 50 },
    ]);
    expect(current).toMatchObject({
      status: "confirmed",
      total_amount: null,
      paid_amount: null,
      outstanding_amount: null,
    });
    expect(settlements).toEqual([]);

    const completed = events?.find(
      (event) => event.action === "appointment.completed",
    );
    const reversed = events?.find(
      (event) => event.action === "appointment.billing_completion_undone",
    );
    expect(reversed).toMatchObject({
      actor_id: userIds.admin,
      previous_state: expect.objectContaining({ status: "completed" }),
      new_state: expect.objectContaining({ status: "confirmed" }),
      metadata: expect.objectContaining({
        operation: "undo",
        original_action: "appointment.completed",
        original_event_id: completed?.id,
        target_status: "confirmed",
      }),
    });
    expect(
      events?.some((event) => event.action === "appointment.deleted"),
    ).toBe(false);
  });

  it("completion plus previous settlement plus undo leaves no understated prior balance", async () => {
    const complete = await completeWithPrevious(80);
    expect(complete.error).toBeNull();

    const undo = await undoWithPrevious("pending");
    expect(undo.error).toBeNull();

    const { data: prior } = await service
      .from("appointments")
      .select("id, outstanding_amount")
      .in("id", [ids.oldAppointment1, ids.oldAppointment2])
      .order("scheduled_at", { ascending: true });

    expect(prior).toEqual([
      { id: ids.oldAppointment1, outstanding_amount: 30 },
      { id: ids.oldAppointment2, outstanding_amount: 50 },
    ]);
  });

  it("second undo fails cleanly without changing restored balances", async () => {
    const complete = await completeWithPrevious(60);
    expect(complete.error).toBeNull();
    const firstUndo = await undoWithPrevious();
    expect(firstUndo.error).toBeNull();

    const secondUndo = await undoWithPrevious();

    expect(secondUndo.error?.message).toContain(
      "Only completed appointments can have billing undone",
    );

    const [{ data: prior }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("id, outstanding_amount")
        .in("id", [ids.oldAppointment1, ids.oldAppointment2])
        .order("scheduled_at", { ascending: true }),
      service
        .from("outstanding_settlements")
        .select("id")
        .eq("source_appointment_id", ids.currentAppointment),
    ]);

    expect(prior).toEqual([
      { id: ids.oldAppointment1, outstanding_amount: 30 },
      { id: ids.oldAppointment2, outstanding_amount: 50 },
    ]);
    expect(settlements).toEqual([]);
  });
});
