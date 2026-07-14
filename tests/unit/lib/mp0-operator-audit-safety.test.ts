import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { safeAuditSummary } from "@/lib/supabase/admin";

describe("Post-Pre-P2 MP0 operator audit summaries", () => {
  it("skips an unknown action without inspecting or exposing its payload", () => {
    const summary = safeAuditSummary({
      id: "unknown-event",
      action: "patient.exported",
      target_type: "patient",
      target_id: "patient-private-id",
      payload: {
        patientName: "Private Patient",
        nationalId: "SECRET-NATIONAL-ID",
      },
      created_at: "2026-07-14T00:00:00.000Z",
    });

    expect(summary).toBeNull();
  });
});
