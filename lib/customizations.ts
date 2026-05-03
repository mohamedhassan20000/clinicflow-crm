// Pure helpers and constants for the customizations feature.
// This file has NO "use server" directive — it can be imported by both
// client and server code.

// ── Feature registry ──────────────────────────────────────────────────────────

export type AccessLevel = "hidden" | "read_only" | "read_edit";

export interface FeatureDef {
  key: string;
  label: string;
  defaults: Record<string, AccessLevel>;
}

export interface PageDef {
  key: string;
  label: string;
  features: FeatureDef[];
}

export const FEATURE_REGISTRY: PageDef[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    features: [
      {
        key: "revenue_widget",
        label: "Revenue widget",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "read_only", doctor: "hidden" },
      },
      {
        key: "analytics_section",
        label: "Analytics section",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "read_only", doctor: "hidden" },
      },
      {
        key: "today_schedule",
        label: "Today's schedule",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "read_only" },
      },
      {
        key: "upcoming_confirmations",
        label: "Needs confirmation (next 7 days)",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "receptionist_invoice_chart",
        label: "Receptionist invoice chart",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "hidden", doctor: "hidden" },
      },
    ],
  },
  {
    key: "appointments",
    label: "Appointments",
    features: [
      {
        key: "book_appointment",
        label: "Book new appointment",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "confirm_action",
        label: "Confirm appointment",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "complete_action",
        label: "Complete & bill appointment",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "cancel_action",
        label: "Cancel appointment",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "noshow_action",
        label: "Mark as no-show",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "filter_bar",
        label: "Filter bar",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "read_only", doctor: "read_only" },
      },
    ],
  },
  {
    key: "patients",
    label: "Patients",
    features: [
      {
        key: "create_patient",
        label: "Create new patient",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "edit_patient",
        label: "Edit patient details",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "delete_patient",
        label: "Delete patient",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "hidden", doctor: "hidden" },
      },
      {
        key: "medical_notes",
        label: "Medical notes",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "hidden", doctor: "read_edit" },
      },
      {
        key: "billing_section",
        label: "Patient billing & deposits",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "read_only", doctor: "hidden" },
      },
    ],
  },
  {
    key: "revenue",
    label: "Revenue",
    features: [
      {
        key: "view_transactions",
        label: "View transaction report",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "read_only", doctor: "hidden" },
      },
      {
        key: "export_csv",
        label: "Export CSV",
        defaults: { admin: "read_edit", receptionist: "hidden", manager: "read_only", doctor: "hidden" },
      },
    ],
  },
  {
    key: "followups",
    label: "Follow-ups",
    features: [
      {
        key: "record_outcome",
        label: "Record follow-up outcome",
        defaults: { admin: "read_edit", receptionist: "read_edit", manager: "hidden", doctor: "read_only" },
      },
    ],
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserCustomization {
  page: string;
  feature: string;
  access: AccessLevel;
}

export interface CustomizationMap {
  [page: string]: {
    [feature: string]: AccessLevel;
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function buildCustomizationMap(
  rows: UserCustomization[],
): CustomizationMap {
  const map: CustomizationMap = {};
  for (const row of rows) {
    if (!map[row.page]) map[row.page] = {};
    map[row.page][row.feature] = row.access;
  }
  return map;
}

export function getEffectiveAccess(
  map: CustomizationMap,
  page: string,
  feature: string,
  role: string,
): AccessLevel {
  const override = map[page]?.[feature];
  if (override) return override;
  const pageDef = FEATURE_REGISTRY.find((p) => p.key === page);
  const featDef = pageDef?.features.find((f) => f.key === feature);
  return featDef?.defaults[role] ?? "hidden";
}
