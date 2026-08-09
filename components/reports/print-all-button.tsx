/**
 * Section discriminator for report bodies. Printing from report pages was
 * removed in P7 Phase 3 — printing now happens only through document Preview —
 * so this module keeps just the type used to tag each report section
 * (`data-report-section`), with no in-page print affordance.
 */
export type ReportPrintSection =
  | "cancellation"
  | "no-show"
  | "revenue"
  | "my-performance"
  | "my-assistant-performance"
  | "followups"
  | "doctor-performance"
  | "receptionist-performance";
