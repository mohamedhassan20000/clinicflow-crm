import "server-only";

import { getAccessibleDocumentTypeCodes } from "@/lib/documents/module";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import { filter, shortTextSchema, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Document id."),
  doc_type: field("doc_type", "string", "operational", "Registered document type."),
  document_number: field("document_number", "string", "identifier", "Issued document number."),
  status: field("status", "string", "operational", "Document status."),
  locale: field("locale", "string", "operational", "Document locale."),
  patient_id: field("patient_id", "string", "identifier", "Patient subject id."),
  staff_id: field("staff_id", "string", "identifier", "Staff subject id."),
  doctor_id: field("doctor_id", "string", "identifier", "Doctor subject id."),
  appointment_id: field("appointment_id", "string", "identifier", "Appointment subject id."),
  issued_at: field("issued_at", "timestamp", "operational", "Issue time."),
  issued_by: field("issued_by", "string", "operational", "Issuer profile id."),
  print_count: field("print_count", "number", "operational", "Print count."),
  page_count: field("page_count", "number", "operational", "Rendered page count."),
  voided_at: field("voided_at", "timestamp", "operational", "Void time."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
} satisfies ResourceDefinition["fields"];
const person = {
  id: field("id", "string", "identifier", "Related id."),
  full_name: field("full_name", "string", "operational", "Full name."),
};
const patient = {
  ...person,
  file_number: field("file_number", "string", "identifier", "Patient file number."),
};

export const documentsResource: ResourceDefinition = {
  id: "documents",
  table: "documents",
  // The document page is available to the app role universe. Per-type catalog
  // filters and documents_select_scoped then enforce independent authorization.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Document id."),
    doc_type: filter("doc_type", shortTextSchema, ["eq", "in"], "Registered document type."),
    document_number: filter("document_number", shortTextSchema, ["eq", "ilike"], "Document number."),
    status: filter("status", shortTextSchema, ["eq", "in"], "Document status."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in", "is"], "Patient id."),
    staff_id: filter("staff_id", uuidSchema, ["eq", "in", "is"], "Staff id."),
    doctor_id: filter("doctor_id", uuidSchema, ["eq", "in", "is"], "Doctor id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in", "is"], "Appointment id."),
    issued_by: filter("issued_by", uuidSchema, ["eq", "in"], "Issuer id."),
    issued_at: filter("issued_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Issue time."),
  },
  sorts: ["issued_at", "document_number", "doc_type", "status", "created_at"],
  relations: {
    patient: {
      alias: "patient",
      select: "patients!documents_patient_id_fkey",
      fields: patient,
      fieldPolicy: declaredFieldPolicy(patient),
      defaultFields: ["id", "full_name", "file_number"],
      description: "Document patient subject.",
    },
    doctor: {
      alias: "doctor",
      select: "profiles!documents_doctor_id_fkey",
      fields: person,
      fieldPolicy: declaredFieldPolicy(person),
      defaultFields: ["id", "full_name"],
      description: "Document doctor subject.",
    },
    issuer: {
      alias: "issuer",
      select: "profiles!documents_issued_by_fkey",
      fields: person,
      fieldPolicy: declaredFieldPolicy(person),
      defaultFields: ["id", "full_name"],
      description: "Document issuer.",
    },
  },
  defaultFields: ["id", "doc_type", "document_number", "status", "patient_id", "staff_id", "doctor_id", "issued_at", "issued_by"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Documents", ar: "المستندات" },
  description: {
    en: "Issued documents visible under both the document catalog and RLS.",
    ar: "المستندات الصادرة المتاحة وفق كتالوج المستندات وسياسات الوصول.",
  },
  // Catalog visibility is application authorization; RLS independently scopes
  // the surviving rows by clinic, patient, and doctor/assistant scope.
  baseFilters: (user) => [
    { column: "doc_type", operator: "in", value: getAccessibleDocumentTypeCodes(user.role) },
    { column: "status", operator: "in", value: ["issued", "void", "cancelled"] },
  ],
};
