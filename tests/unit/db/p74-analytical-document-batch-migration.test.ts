import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260801140000_p74_analytical_document_batch.sql"),
  "utf8",
);

describe("P7-4 analytical document migration", () => {
  it("builds Sales from explicit collection-period sources under caller RLS", () => {
    const sales = sql.slice(
      sql.indexOf("create or replace function public.get_document_sales_report"),
      sql.indexOf("create or replace function public.get_document_follow_up_analytics_report"),
    );
    expect(sales).toContain("security invoker");
    expect(sales).toContain("from public.appointments a");
    expect(sales).toContain("from public.outstanding_settlements s");
    expect(sales).toContain("a.paid_at >= p_start");
    expect(sales).toContain("s.settled_at >= p_start");
    expect(sales).toContain("'outstandingTotal'");
    expect(sales).toContain("revoke all");
    expect(sales).not.toContain("security definer");
  });

  it("builds Follow-up Analytics from completed outcomes and appointment-period semantics", () => {
    const analytics = sql.slice(
      sql.indexOf("create or replace function public.get_document_follow_up_analytics_report"),
      sql.indexOf("create or replace function public.record_analytical_document_reprint"),
    );
    expect(analytics).toContain("security invoker");
    expect(analytics).toContain("from public.follow_ups f");
    expect(analytics).toContain("join public.appointments a");
    expect(analytics).toContain("a.scheduled_at >= p_start");
    expect(analytics).toContain("'all_fine'::public.follow_up_outcome");
    expect(analytics).toContain("when t.completed_count = 0 then 0");
    expect(analytics).not.toContain("security definer");
  });

  it("limits canonical reprint to the seven P7-4 types and appends history", () => {
    const reprint = sql.slice(
      sql.indexOf("create or replace function public.record_analytical_document_reprint"),
    );
    for (const type of [
      "FOLLOW_UP_PAGE_REPORT",
      "CANCELLATION_REPORT",
      "NO_SHOW_REPORT",
      "SALES_REPORT",
      "FOLLOW_UP_ANALYTICS_REPORT",
      "DOCTOR_PERFORMANCE_REPORT",
      "RECEPTIONIST_PERFORMANCE_REPORT",
    ]) expect(reprint).toContain(`'${type}'`);
    expect(reprint).not.toContain("'PATIENT_LIST_REPORT'");
    expect(reprint).not.toContain("'PRESCRIPTION'");
    expect(reprint).toContain("d.clinic_id = v_clinic_id");
    expect(reprint).toContain("set print_count = d.print_count + 1");
    expect(reprint).toContain("'reprinted'");
    expect(reprint).not.toContain("delete from");
  });
});
