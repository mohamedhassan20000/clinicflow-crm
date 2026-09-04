import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import { filter, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Follow-up id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  appointment_id: field("appointment_id", "string", "identifier", "Appointment id."),
  outcome: field("outcome", "string", "operational", "Recorded follow-up outcome."),
  recorded_at: field("recorded_at", "timestamp", "operational", "Follow-up recording time."),
  recorded_by: field("recorded_by", "string", "operational", "Recorder profile id."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
} satisfies ResourceDefinition["fields"];
const patient = {
  id: field("id", "string", "identifier", "Patient id."),
  full_name: field("full_name", "string", "operational", "Patient full name."),
  file_number: field("file_number", "string", "identifier", "Patient file number."),
};
const recorder = {
  id: field("id", "string", "identifier", "Staff id."),
  full_name: field("full_name", "string", "operational", "Staff full name."),
};

export const followUpsResource: ResourceDefinition = {
  id: "follow_ups",
  table: "follow_ups",
  // App role source of truth; follow_ups_select_role_scoped applies the live
  // patient/appointment scope for doctors and supervised assistants.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Follow-up id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in"], "Patient id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in", "is"], "Appointment id."),
    outcome: filter("outcome", z.enum(["all_fine", "has_problem", "no_response"]), ["eq", "in"], "Follow-up outcome."),
    recorded_by: filter("recorded_by", uuidSchema, ["eq", "in", "is"], "Recorder id."),
    recorded_at: filter("recorded_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Recording time."),
  },
  sorts: ["recorded_at", "outcome", "created_at"],
  relations: {
    patient: {
      alias: "patient",
      select: "patients!follow_ups_patient_id_fkey",
      fields: patient,
      fieldPolicy: declaredFieldPolicy(patient),
      defaultFields: ["id", "full_name", "file_number"],
      description: "Follow-up patient.",
    },
    recorded_by_profile: {
      alias: "recorded_by_profile",
      select: "profiles!follow_ups_recorded_by_fkey",
      fields: recorder,
      fieldPolicy: declaredFieldPolicy(recorder),
      defaultFields: ["id", "full_name"],
      description: "Staff member who recorded the follow-up.",
    },
  },
  defaultFields: ["id", "patient_id", "appointment_id", "outcome", "recorded_at", "recorded_by"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Follow-ups", ar: "المتابعات" },
  description: { en: "Authorized patient follow-up records.", ar: "سجلات متابعة المرضى المصرح بها." },
};
