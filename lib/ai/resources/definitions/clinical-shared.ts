import "server-only";

import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import type { RelationSpec, ResourceDefinition } from "@/lib/ai/resources/types";

const patientFields = {
  id: field("id", "string", "identifier", "Patient id."),
  full_name: field("full_name", "string", "operational", "Patient full name."),
  file_number: field("file_number", "string", "identifier", "Patient file number."),
  blood_type: field("blood_type", "string", "clinical", "Patient blood type."),
};

const profileFields = {
  id: field("id", "string", "identifier", "Staff profile id."),
  full_name: field("full_name", "string", "operational", "Staff full name."),
  role: field("role", "string", "operational", "Staff role."),
};

const appointmentFields = {
  id: field("id", "string", "identifier", "Appointment id."),
  scheduled_at: field("scheduled_at", "timestamp", "operational", "Appointment time."),
  status: field("status", "string", "operational", "Appointment status."),
};

const namedFields = {
  id: field("id", "string", "identifier", "Related record id."),
  name: field("name", "string", "operational", "Related record name."),
};

function relation(
  alias: string,
  select: string,
  fields: ResourceDefinition["fields"],
  defaultFields: readonly string[],
  description: string,
): RelationSpec {
  return {
    alias,
    select,
    fields,
    fieldPolicy: declaredFieldPolicy(fields),
    defaultFields,
    description,
  };
}

export function patientRelation(select: string): RelationSpec {
  return relation(
    "patient",
    select,
    patientFields,
    ["id", "full_name", "file_number", "blood_type"],
    "Clinical record patient.",
  );
}

export function profileRelation(alias: string, select: string): RelationSpec {
  return relation(
    alias,
    select,
    profileFields,
    ["id", "full_name", "role"],
    "Related staff profile.",
  );
}

export function appointmentRelation(select: string): RelationSpec {
  return relation(
    "appointment",
    select,
    appointmentFields,
    ["id", "scheduled_at", "status"],
    "Related appointment.",
  );
}

export function namedRelation(alias: string, select: string): RelationSpec {
  return relation(alias, select, namedFields, ["id", "name"], "Related named record.");
}

export const clinicalResourceFeature = ["ai.read_clinical"] as const;

