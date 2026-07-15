import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "../types/database";

const LOCAL_URL = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.LOCAL_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

export const MARKETING_DEMO = {
  clinicId: "92000000-0000-4000-8000-000000000001",
  departmentIds: [
    "92000000-0000-4000-8000-000000000101",
    "92000000-0000-4000-8000-000000000102",
  ],
  serviceIds: [
    "92000000-0000-4000-8000-000000000201",
    "92000000-0000-4000-8000-000000000202",
  ],
  patientIds: Array.from({ length: 8 }, (_, index) =>
    `92000000-0000-4000-8000-${String(index + 301).padStart(12, "0")}`,
  ),
  appointmentIds: Array.from({ length: 18 }, (_, index) =>
    `92000000-0000-4000-8000-${String(index + 401).padStart(12, "0")}`,
  ),
  adminEmail: "ws9-demo-admin@clinicflow.example.invalid",
  doctorEmails: [
    "ws9-demo-doctor-one@clinicflow.example.invalid",
    "ws9-demo-doctor-two@clinicflow.example.invalid",
  ],
  receptionistEmail: "ws9-demo-reception@clinicflow.example.invalid",
  password: "ClinicFlowDemo123!",
} as const;

type MarketingDemoMarket = "kw" | "sa";

const MARKET_SETTINGS = {
  kw: {
    country: "KW",
    currency: "KWD",
    timezone: "Asia/Kuwait",
    clinicPhone: "+96550000000",
    patientPhonePrefix: "+9655",
    patientPhoneDigits: 7,
  },
  sa: {
    country: "SA",
    currency: "SAR",
    timezone: "Asia/Riyadh",
    clinicPhone: "+966500000000",
    patientPhonePrefix: "+9665",
    patientPhoneDigits: 8,
  },
} as const;

function requireLocalService() {
  if (!SERVICE_KEY) {
    throw new Error("LOCAL_SUPABASE_SECRET_KEY is required to seed the marketing demo.");
  }
  const url = new URL(LOCAL_URL);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`Refusing to seed a non-local Supabase project (${url.hostname}).`);
  }
  return createClient<Database>(LOCAL_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function clinicDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuwait",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function atClinicTime(offsetDays: number, time: string) {
  return `${clinicDate(offsetDays)}T${time}:00+03:00`;
}

function atPriorClinicMonth(offsetMonths: number, time = "12:00") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((item) => item.type === "year")?.value);
  const month = Number(parts.find((item) => item.type === "month")?.value);
  const target = new Date(Date.UTC(year, month - 1 + offsetMonths, 15));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-15T${time}:00+03:00`;
}

async function assertResult(label: string, result: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await result;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function resetDemoData(service: ReturnType<typeof requireLocalService>) {
  const patientIds = [...MARKETING_DEMO.patientIds];
  const clinicId = MARKETING_DEMO.clinicId;

  await assertResult("Delete medical notes", service.from("medical_notes").delete().in("patient_id", patientIds));
  await assertResult("Delete follow-ups", service.from("follow_ups").delete().eq("clinic_id", clinicId));
  await assertResult("Delete appointment services", service.from("appointment_services").delete().eq("clinic_id", clinicId));
  await assertResult("Delete settlements", service.from("outstanding_settlements").delete().eq("clinic_id", clinicId));
  await assertResult("Delete deposits", service.from("patient_deposits").delete().eq("clinic_id", clinicId));
  await assertResult("Delete packages", service.from("patient_packages").delete().eq("clinic_id", clinicId));
  await assertResult("Delete doctor schedules", service.from("doctor_schedules").delete().eq("clinic_id", clinicId));
  await assertResult("Delete clinic hours", service.from("clinic_working_hours").delete().eq("clinic_id", clinicId));
  await assertResult("Delete page permissions", service.from("user_page_permissions").delete().eq("clinic_id", clinicId));
  await assertResult("Delete usage", service.from("usage_counters").delete().eq("clinic_id", clinicId));
  await assertResult("Delete audit rows", service.from("audit_logs").delete().eq("clinic_id", clinicId));
}

async function createDemoUser(
  service: ReturnType<typeof requireLocalService>,
  email: string,
) {
  const existing = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (existing.error) throw new Error(`List demo users: ${existing.error.message}`);
  const existingUser = existing.data.users.find((user) => user.email === email);
  if (existingUser) {
    const refreshed = await service.auth.admin.updateUserById(existingUser.id, {
      password: MARKETING_DEMO.password,
      email_confirm: true,
    });
    if (refreshed.error) throw new Error(`Refresh ${email}: ${refreshed.error.message}`);
    return existingUser.id;
  }

  const { data, error } = await service.auth.admin.createUser({
    email,
    password: MARKETING_DEMO.password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? `Create ${email}`);
  return data.user.id;
}

async function uploadDemoAvatars(
  service: ReturnType<typeof requireLocalService>,
  adminId: string,
) {
  const adminObjectKey = `${adminId}/marketing-demo-avatar.webp`;
  const adminAvatar = await readFile("public/marketing/demo-avatars/user-admin.webp");
  const adminUpload = await service.storage.from("avatars").upload(adminObjectKey, adminAvatar, {
    contentType: "image/webp",
    upsert: true,
  });
  if (adminUpload.error) throw new Error(`Upload demo admin avatar: ${adminUpload.error.message}`);

  const patientAvatarPaths = await Promise.all(
    MARKETING_DEMO.patientIds.map(async (patientId, index) => {
      const objectKey = `avatars/${MARKETING_DEMO.clinicId}/${patientId}/avatar.webp`;
      const bytes = await readFile(
        `public/marketing/demo-avatars/patient-${String(index + 1).padStart(2, "0")}.webp`,
      );
      const upload = await service.storage.from("patient-assets").upload(objectKey, bytes, {
        contentType: "image/webp",
        upsert: true,
      });
      if (upload.error) throw new Error(`Upload demo patient avatar ${index + 1}: ${upload.error.message}`);
      return objectKey;
    }),
  );

  const { data: adminPublicAvatar } = service.storage.from("avatars").getPublicUrl(adminObjectKey);
  return { adminAvatarUrl: adminPublicAvatar.publicUrl, patientAvatarPaths };
}

export async function seedMarketingDemo(market: MarketingDemoMarket = "kw") {
  const service = requireLocalService();
  const marketSettings = MARKET_SETTINGS[market];
  const probe = await service.from("clinics").select("id").limit(1);
  if (probe.error) throw new Error(`Local Supabase unavailable: ${probe.error.message}`);

  await resetDemoData(service);

  const [adminId, doctorOneId, doctorTwoId, receptionistId] = await Promise.all([
    createDemoUser(service, MARKETING_DEMO.adminEmail),
    createDemoUser(service, MARKETING_DEMO.doctorEmails[0]),
    createDemoUser(service, MARKETING_DEMO.doctorEmails[1]),
    createDemoUser(service, MARKETING_DEMO.receptionistEmail),
  ]);
  const { adminAvatarUrl, patientAvatarPaths } = await uploadDemoAvatars(service, adminId);

  await assertResult(
    "Insert clinic",
    service.from("clinics").upsert({
      id: MARKETING_DEMO.clinicId,
      name: "Harbor Family Clinic — Demo",
      address: "Fictional clinic for product screenshots",
      country: marketSettings.country,
      currency: marketSettings.currency,
      locale: "en",
      timezone: marketSettings.timezone,
      week_start: 6,
      phone: marketSettings.clinicPhone,
      phone_e164_valid: true,
      onboarding_completed_at: new Date().toISOString(),
      working_hours_start: "08:00",
      working_hours_end: "18:00",
    }),
  );

  const plan = await service.from("plans").select("id").eq("slug", "basic").single();
  if (plan.error) throw new Error(`Load plan: ${plan.error.message}`);
  await assertResult(
    "Insert subscription",
    service.from("subscriptions").upsert({
      clinic_id: MARKETING_DEMO.clinicId,
      plan_id: plan.data.id,
      status: "active",
      provider: "manual",
      current_period_start: atClinicTime(-10, "08:00"),
      current_period_end: atClinicTime(20, "18:00"),
    }, { onConflict: "clinic_id" }),
  );

  await assertResult(
    "Insert departments",
    service.from("departments").upsert([
      { id: MARKETING_DEMO.departmentIds[0], clinic_id: MARKETING_DEMO.clinicId, name: "Family medicine", color: "#0d9488" },
      { id: MARKETING_DEMO.departmentIds[1], clinic_id: MARKETING_DEMO.clinicId, name: "Dermatology", color: "#7c3aed" },
    ]),
  );

  await assertResult(
    "Insert profiles",
    service.from("profiles").upsert([
      { id: adminId, clinic_id: MARKETING_DEMO.clinicId, full_name: "Nadia Faris", role: "admin", must_change_password: false, display_currency: marketSettings.currency, avatar_url: adminAvatarUrl },
      { id: doctorOneId, clinic_id: MARKETING_DEMO.clinicId, department_id: MARKETING_DEMO.departmentIds[0], full_name: "Dr. Sami Nasser", role: "doctor", must_change_password: false },
      { id: doctorTwoId, clinic_id: MARKETING_DEMO.clinicId, department_id: MARKETING_DEMO.departmentIds[1], full_name: "Dr. Leila Haddad", role: "doctor", must_change_password: false },
      { id: receptionistId, clinic_id: MARKETING_DEMO.clinicId, full_name: "Rana Saleh", role: "receptionist", must_change_password: false },
    ]),
  );

  await assertResult(
    "Insert working hours",
    service.from("clinic_working_hours").insert(
      [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
        { clinic_id: MARKETING_DEMO.clinicId, day_of_week: dayOfWeek, shift_start: "08:00", shift_end: "12:30" },
        { clinic_id: MARKETING_DEMO.clinicId, day_of_week: dayOfWeek, shift_start: "13:30", shift_end: "18:00" },
      ]),
    ),
  );
  await assertResult(
    "Insert doctor schedules",
    service.from("doctor_schedules").insert(
      [doctorOneId, doctorTwoId].flatMap((doctorId) =>
        [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          clinic_id: MARKETING_DEMO.clinicId,
          doctor_id: doctorId,
          day_of_week: dayOfWeek,
          start_time: "08:00",
          end_time: "18:00",
        })),
      ),
    ),
  );

  await assertResult(
    "Insert services",
    service.from("services").upsert([
      { id: MARKETING_DEMO.serviceIds[0], clinic_id: MARKETING_DEMO.clinicId, department_id: MARKETING_DEMO.departmentIds[0], name: "General consultation", price: 24 },
      { id: MARKETING_DEMO.serviceIds[1], clinic_id: MARKETING_DEMO.clinicId, department_id: MARKETING_DEMO.departmentIds[1], name: "Dermatology review", price: 32 },
    ]),
  );

  const patientNames = [
    "Maya Al-Nour",
    "Omar Rahal",
    "Salma Kareem",
    "Yousef Darwish",
    "Noor Mansour",
    "Tariq Hadi",
    "Hana Qasem",
    "Adam Shafiq",
  ];
  const patients: TablesInsert<"patients">[] = patientNames.map((fullName, index) => ({
    id: MARKETING_DEMO.patientIds[index],
    clinic_id: MARKETING_DEMO.clinicId,
    created_by: receptionistId,
    full_name: fullName,
    date_of_birth: `${1985 + index}-0${(index % 8) + 1}-12`,
    phone: `${marketSettings.patientPhonePrefix}${String(index + 1).padStart(marketSettings.patientPhoneDigits, "0")}`,
    phone_e164_valid: true,
    email: `fictional-patient-${index + 1}@clinicflow.example.invalid`,
    file_number: `DEMO-${String(index + 1).padStart(4, "0")}`,
    national_id: `FICTIONAL-${String(index + 1).padStart(4, "0")}`,
    blood_type: (["A+", "O+", "B+", "AB+"] as const)[index % 4],
    department_id: MARKETING_DEMO.departmentIds[index % 2],
    assigned_doctor_id: index % 2 === 0 ? doctorOneId : doctorTwoId,
    avatar_path: patientAvatarPaths[index],
  }));
  await assertResult("Insert patients", service.from("patients").upsert(patients));

  const now = new Date().toISOString();
  const currentAppointments = [
    [0, 0, "08:30", "confirmed", doctorOneId, 24],
    [1, 0, "09:15", "arrived", doctorTwoId, 32],
    [2, 0, "10:00", "in_session", doctorOneId, 24],
    [3, 0, "11:00", "pending", doctorTwoId, 32],
    [4, 0, "13:30", "completed", doctorOneId, 2865.75],
    [5, 0, "14:30", "no_show", doctorTwoId, 32],
    [6, 0, "15:30", "cancelled", doctorOneId, 24],
    [7, 0, "16:30", "confirmed", doctorTwoId, 32],
    [0, -1, "10:00", "completed", doctorOneId, 3240.5],
    [1, -2, "11:30", "completed", doctorTwoId, 2785.25],
    [2, -4, "09:30", "completed", doctorOneId, 3615],
    [3, -7, "15:00", "completed", doctorTwoId, 2940.75],
  ] as const;
  const historicalRevenue = [18_250, 21_900, 19_750, 25_600, 28_900, 31_400];
  const historicalAppointments = market === "sa"
    ? historicalRevenue.map((amount, index) => ({
        patientIndex: index % MARKETING_DEMO.patientIds.length,
        scheduledAt: atPriorClinicMonth(index - 6),
        paidAt: atPriorClinicMonth(index - 6),
        doctorId: index % 2 === 0 ? doctorOneId : doctorTwoId,
        amount,
      }))
    : [];

  const currentAppointmentRows: TablesInsert<"appointments">[] = currentAppointments.map(([patientIndex, offset, time, status, doctorId, amount], index): TablesInsert<"appointments"> => {
    const completed = status === "completed";
    const numericPatientIndex = Number(patientIndex);
    const numericAmount = Number(amount);
    const doctorIsOne = doctorId === doctorOneId;
    return {
      id: MARKETING_DEMO.appointmentIds[index],
      clinic_id: MARKETING_DEMO.clinicId,
      patient_id: MARKETING_DEMO.patientIds[numericPatientIndex],
      doctor_id: String(doctorId),
      department_id: doctorIsOne ? MARKETING_DEMO.departmentIds[0] : MARKETING_DEMO.departmentIds[1],
      service_id: doctorIsOne ? MARKETING_DEMO.serviceIds[0] : MARKETING_DEMO.serviceIds[1],
      scheduled_at: atClinicTime(Number(offset), String(time)),
      duration_minutes: 30,
      status: status as TablesInsert<"appointments">["status"],
      created_by: receptionistId,
      notes: "Fictional product-demo appointment",
      total_amount: completed ? numericAmount : null,
      paid_amount: completed ? numericAmount : null,
      outstanding_amount: completed ? 0 : null,
      payment_method: completed ? (index % 2 === 0 ? "credit_card" : "cash") : null,
      paid_at: completed ? now : null,
      cancelled_at: status === "cancelled" ? now : null,
      cancelled_by: status === "cancelled" ? receptionistId : null,
      cancellation_reason: status === "cancelled" ? "Patient rescheduled" : null,
      no_showed_at: status === "no_show" ? now : null,
      no_showed_by: status === "no_show" ? receptionistId : null,
      no_show_reason: status === "no_show" ? "Unable to reach patient" : null,
    };
  });
  const historicalAppointmentRows: TablesInsert<"appointments">[] = historicalAppointments.map((appointment, historicalIndex): TablesInsert<"appointments"> => {
    const doctorIsOne = appointment.doctorId === doctorOneId;
    return {
      id: MARKETING_DEMO.appointmentIds[currentAppointments.length + historicalIndex],
      clinic_id: MARKETING_DEMO.clinicId,
      patient_id: MARKETING_DEMO.patientIds[appointment.patientIndex],
      doctor_id: appointment.doctorId,
      department_id: doctorIsOne ? MARKETING_DEMO.departmentIds[0] : MARKETING_DEMO.departmentIds[1],
      service_id: doctorIsOne ? MARKETING_DEMO.serviceIds[0] : MARKETING_DEMO.serviceIds[1],
      scheduled_at: appointment.scheduledAt,
      duration_minutes: 30,
      status: "completed",
      created_by: receptionistId,
      notes: "Fictional historical product-demo appointment",
      total_amount: appointment.amount,
      paid_amount: appointment.amount,
      outstanding_amount: 0,
      payment_method: historicalIndex % 2 === 0 ? "credit_card" : "cash",
      paid_at: appointment.paidAt,
    };
  });
  const appointments = [...currentAppointmentRows, ...historicalAppointmentRows];
  await assertResult("Insert appointments", service.from("appointments").upsert(appointments));

  const completedAppointments = appointments.filter((appointment) => appointment.status === "completed");
  await assertResult(
    "Insert appointment services",
    service.from("appointment_services").insert(
      completedAppointments.map((appointment) => ({
        clinic_id: MARKETING_DEMO.clinicId,
        appointment_id: appointment.id!,
        service_id: appointment.service_id,
        name: appointment.department_id === MARKETING_DEMO.departmentIds[0] ? "General consultation" : "Dermatology review",
        price: appointment.total_amount ?? 0,
        quantity: 1,
      })),
    ),
  );

  await assertResult(
    "Insert patient package",
    service.from("patient_packages").insert({
      clinic_id: MARKETING_DEMO.clinicId,
      patient_id: MARKETING_DEMO.patientIds[0],
      department_id: MARKETING_DEMO.departmentIds[0],
      service_id: MARKETING_DEMO.serviceIds[0],
      created_by: adminId,
      name: "Wellness follow-up plan",
      total_sessions: 6,
      used_sessions: 2,
      price_per_session: 21,
      notes: "Fictional demo package",
    }),
  );
  await assertResult(
    "Insert deposit",
    service.from("patient_deposits").insert({
      clinic_id: MARKETING_DEMO.clinicId,
      patient_id: MARKETING_DEMO.patientIds[0],
      amount: 30,
      payment_method: "credit_card",
      created_by: receptionistId,
      note: "Fictional demo deposit",
    }),
  );
  await assertResult(
    "Insert follow-ups",
    service.from("follow_ups").insert([
      {
        clinic_id: MARKETING_DEMO.clinicId,
        patient_id: MARKETING_DEMO.patientIds[0],
        appointment_id: MARKETING_DEMO.appointmentIds[8],
        outcome: "all_fine",
        notes: "Patient is doing well; routine follow-up scheduled.",
        recorded_by: receptionistId,
      },
      {
        clinic_id: MARKETING_DEMO.clinicId,
        patient_id: MARKETING_DEMO.patientIds[1],
        appointment_id: MARKETING_DEMO.appointmentIds[9],
        outcome: "no_response",
        notes: "Follow-up call queued for tomorrow.",
        recorded_by: receptionistId,
      },
    ]),
  );
  await assertResult(
    "Insert medical notes",
    service.from("medical_notes").insert([
      {
        patient_id: MARKETING_DEMO.patientIds[0],
        doctor_id: doctorOneId,
        created_by: doctorOneId,
        note: "Fictional demo note: routine review completed; continue the agreed follow-up plan.",
      },
      {
        patient_id: MARKETING_DEMO.patientIds[1],
        doctor_id: doctorTwoId,
        created_by: doctorTwoId,
        note: "Fictional demo note: progress reviewed and next check scheduled.",
      },
    ]),
  );

  return {
    adminId,
    patientId: MARKETING_DEMO.patientIds[0],
    clinicId: MARKETING_DEMO.clinicId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedMarketingDemo(process.env.MARKETING_DEMO_MARKET === "sa" ? "sa" : "kw")
    .then(({ clinicId }) => {
      process.stdout.write(`Seeded local fictional marketing demo clinic ${clinicId}.\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
