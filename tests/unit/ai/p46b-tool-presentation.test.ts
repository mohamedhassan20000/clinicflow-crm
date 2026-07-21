import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TOOL_PRESENTATION,
  presentationFor,
  summarizeToolResult,
} from "@/lib/ai/tool-presentation";
import { AI_TOOL_REGISTRY } from "@/lib/ai/tools/registry";
import { FINANCIAL_TOOL_NAMES } from "@/lib/ai/capabilities";

// P4.6B — how a tool result is presented.
//
// The notices here are the reason this module exists. Each P4.6A tool already
// carries an honesty signal — `clamped`, `truncated`, `suppressed_bucket_count`,
// `patients_total_exact` — for the model to relay, and the prompt tells it to.
// Rendering the same signals from the structured result means a model that
// summarized loosely cannot quietly turn a partial answer into a confident one.

describe("P4.6B tool presentation metadata", () => {
  it("covers every registered tool, so none falls back to the generic label", () => {
    for (const definition of AI_TOOL_REGISTRY) {
      expect(
        ASSISTANT_TOOL_PRESENTATION[definition.name],
        `${definition.name} has no presentation entry`,
      ).toBeDefined();
    }
  });

  it("marks exactly the gated financial tools as financial", () => {
    const financial = Object.entries(ASSISTANT_TOOL_PRESENTATION)
      .filter(([, presentation]) => presentation.group === "financial")
      .map(([name]) => name)
      .sort();

    expect(financial).toEqual([...FINANCIAL_TOOL_NAMES].sort());
  });

  it("falls back to a generic label for an unknown tool instead of throwing", () => {
    expect(presentationFor("some_future_tool")).toEqual({
      labelKey: "toolRecordReview",
      group: "clinical",
    });
  });
});

describe("P4.6B result notices", () => {
  it("surfaces a narrowed date range with the range actually used", () => {
    const { notices } = summarizeToolResult({
      range: { preset: "this_month", from: "2026-07-01", to: "2026-07-31", clamped: true },
    });

    expect(notices).toContainEqual({
      kind: "range_clamped",
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("says nothing about the range when it was not clamped", () => {
    const { notices } = summarizeToolResult({
      range: { preset: "this_month", from: "2026-07-01", to: "2026-07-31", clamped: false },
    });
    expect(notices).toEqual([]);
  });

  it("warns that a capped list may not be everything", () => {
    const { notices } = summarizeToolResult({
      truncated: true,
      row_cap: 50,
      appointments: [],
    });

    expect(notices).toContainEqual({ kind: "truncated", rowCap: 50 });
  });

  it("does not warn when a list came back under the cap", () => {
    const { notices } = summarizeToolResult({ truncated: false, row_cap: 50 });
    expect(notices).toEqual([]);
  });

  /**
   * H1 (review #3). Suppressed categories are generalized into one aggregate
   * bucket, so the notice states how many groups were combined and how many
   * patients that covers — both exact, both safe. There is no per-group caveat
   * left to render, because no suppressed group is named or counted.
   */
  it("reports how many groups were combined and how many patients that covers", () => {
    const { notices } = summarizeToolResult({
      stats: {
        group_by: "blood_type",
        patients_total: 107,
        patients_total_exact: true,
        suppression_floor: 5,
        suppressed_bucket_count: 2,
        suppressed_patient_count: 7,
        distribution_withheld: false,
        buckets_all_time: [
          {
            bucket: "O+",
            count: 100,
            display: "100",
            suppressed: false,
            suppression_reason: null,
          },
          {
            bucket: "Other",
            count: 7,
            display: "7",
            suppressed: true,
            suppression_reason: "aggregated",
            grouped_bucket_count: 2,
          },
        ],
      },
    });

    expect(notices).toContainEqual({
      kind: "suppressed",
      groupedBuckets: 2,
      groupedPatients: 7,
      floor: 5,
    });
  });

  /**
   * The exact total is publishable *because* the aggregate is published, so no
   * "this total is approximate" caveat should ever appear. Its presence would
   * mean the RPC had gone back to withholding the total — the design that
   * review #3's H1 showed was reversible via `get_clinic_summary`.
   */
  it("never claims the total is approximate", () => {
    const { notices } = summarizeToolResult({
      stats: {
        group_by: "blood_type",
        patients_total: 107,
        patients_total_exact: true,
        suppression_floor: 5,
        suppressed_bucket_count: 2,
        suppressed_patient_count: 7,
        buckets_all_time: [],
      },
    });
    expect(
      notices.some((notice) => (notice.kind as string) === "approximate_total"),
    ).toBe(false);
  });

  it("reports a fully suppressed distribution as withheld, not as a set of tiny groups", () => {
    const { notices } = summarizeToolResult({
      stats: {
        group_by: "blood_type",
        patients_total: 205,
        patients_total_exact: true,
        suppression_floor: 5,
        suppressed_bucket_count: 2,
        suppressed_patient_count: 205,
        distribution_withheld: true,
        distribution_withheld_reason: "all_buckets_suppressed",
        buckets_all_time: [],
      },
    });

    expect(notices).toContainEqual({ kind: "distribution_withheld" });
    // The "N groups were too small" sentence must not also appear — it would
    // describe groups the payload deliberately does not name.
    expect(notices.some((notice) => notice.kind === "suppressed")).toBe(false);
  });

  it("stays quiet when a distribution had nothing to suppress", () => {
    const { notices } = summarizeToolResult({
      stats: {
        patients_total: 40,
        patients_total_exact: true,
        suppression_floor: 5,
        suppressed_bucket_count: 0,
        suppressed_patient_count: 0,
      },
    });
    expect(notices).toEqual([]);
  });

  it("flags an all-time scope so a figure is not read as belonging to a period", () => {
    const { notices } = summarizeToolResult({ scope: "all_time", invoices: [] });
    expect(notices).toContainEqual({ kind: "all_time_scope" });
  });

  it("flags the P4.6C clarification contract from a low-confidence patient search", () => {
    const { notices } = summarizeToolResult({
      confidence: "low",
      guidance: "Ask the user which patient they mean.",
      patients: [{ id: "a" }, { id: "b" }],
    });

    expect(notices).toContainEqual({ kind: "needs_clarification" });
  });

  it("does not ask for clarification on a confident unique match", () => {
    const { notices } = summarizeToolResult({
      confidence: "high",
      guidance: "Proceed.",
      patients: [{ id: "a" }],
    });
    expect(notices).toEqual([]);
  });

  it("flags the entity-filter clarification shape used by list/report tools", () => {
    const { notices } = summarizeToolResult({
      needs_clarification: true,
      field: "doctor",
      guidance: "More than one doctor matches.",
      candidates: [],
    });

    expect(notices).toContainEqual({ kind: "needs_clarification" });
  });

  it("exposes a report deep link", () => {
    const { link, linkKind } = summarizeToolResult(
      {
        report: "cancellations",
        link: "/reports/cancellations?preset=this_month&from=2026-07-01&to=2026-07-31",
      },
      "run_clinic_report",
    );

    expect(link).toBe(
      "/reports/cancellations?preset=this_month&from=2026-07-01&to=2026-07-31",
    );
    expect(linkKind).toBe("report");
  });

  it("extracts safe nested help citations and preserves unavailable citations without links", () => {
    const summary = summarizeToolResult(
      {
        results: [
          {
            article_id: "record-payment-and-invoice",
            title: "إصدار فاتورة الجلسة وتسجيل الدفع",
            section: "المواعيد",
            link: "/appointments",
          },
          {
            article_id: "hidden-article",
            title: "مقالة مخفية",
            section: "الإعدادات ← التخصيص",
            unavailable_reason: "hidden_by_admin",
          },
          {
            article_id: "unsafe",
            title: "Unsafe",
            section: "Elsewhere",
            link: "https://evil.example/steal",
          },
        ],
      },
      "search_help",
    );

    expect(summary.citations).toEqual([
      {
        articleId: "record-payment-and-invoice",
        title: "إصدار فاتورة الجلسة وتسجيل الدفع",
        section: "المواعيد",
        link: "/appointments",
      },
      {
        articleId: "hidden-article",
        title: "مقالة مخفية",
        section: "الإعدادات ← التخصيص",
        link: null,
      },
      {
        articleId: "unsafe",
        title: "Unsafe",
        section: "Elsewhere",
        link: null,
      },
    ]);
  });

  it("classifies navigation links separately and carries their localized section label", () => {
    const summary = summarizeToolResult(
      { link: "/settings/messaging", section: "Settings → Messaging" },
      "get_navigation_target",
    );
    expect(summary.linkKind).toBe("navigation");
    expect(summary.linkLabel).toBe("Settings → Messaging");
  });

  it("refuses an off-site link, so a tool result can never become an open redirect", () => {
    expect(summarizeToolResult({ link: "https://evil.example/steal" }).link).toBeNull();
    expect(summarizeToolResult({ link: "//evil.example" }).link).toBeNull();
    expect(summarizeToolResult({ link: "/\\evil.example" }).link).toBeNull();
    expect(summarizeToolResult({ link: "javascript:alert(1)" }).link).toBeNull();
    expect(summarizeToolResult({ link: 42 }).link).toBeNull();
  });

  it("returns no notices for malformed or non-object output instead of throwing", () => {
    for (const value of [null, undefined, "text", 42, [], { range: "nonsense" }]) {
      expect(() => summarizeToolResult(value)).not.toThrow();
      expect(summarizeToolResult(value).notices).toEqual([]);
    }
  });
});
