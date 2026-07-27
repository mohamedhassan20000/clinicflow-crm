import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(
    resolve(process.cwd(), "supabase/migrations", name),
    "utf8",
  );
}

const enumSql = migration(
  "20260727130000_appointment_replaced_status_enum.sql",
);
const workflowSql = migration(
  "20260727131000_appointment_replace_workflow.sql",
);
const reportSql = migration(
  "20260727132000_replaced_status_report_kpis.sql",
);
const aiSql = migration("20260727133000_replaced_status_ai_stats.sql");
const hardeningSql = migration(
  "20260727134000_replacement_workflow_hardening.sql",
);
const remainingAnalyticsSql = migration(
  "20260727135000_replaced_status_remaining_analytics.sql",
);

describe("Phase 6 replacement migrations", () => {
  it("adds replaced in its own enum migration", () => {
    expect(enumSql).toContain(
      "alter type public.appointment_status add value if not exists 'replaced'",
    );
    expect(enumSql).not.toContain("replace_appointment(");
  });

  it("creates the three chain links and atomic workflow", () => {
    for (const column of [
      "replaces_appointment_id",
      "replaced_by_appointment_id",
      "original_appointment_id",
    ]) {
      expect(workflowSql).toContain(column);
    }
    expect(workflowSql).toContain(
      "function public.replace_appointment(",
    );
    expect(workflowSql).toContain(
      "'confirmed'::public.appointment_status",
    );
    expect(workflowSql).toContain(
      "set status = 'replaced'::public.appointment_status",
    );
  });

  it("serializes replacements and enforces a symmetric, same-scope chain", () => {
    expect(hardeningSql).toContain("for update;");
    expect(hardeningSql).toContain("appointments_replaces_once_idx");
    expect(hardeningSql).toContain(
      "create constraint trigger trg_appointments_replacement_chain",
    );
    expect(hardeningSql).toContain("deferrable initially deferred");
    expect(hardeningSql).toContain(
      "v_previous.clinic_id <> new.clinic_id",
    );
    expect(hardeningSql).toContain(
      "v_previous.patient_id <> new.patient_id",
    );
  });

  it("keeps doctors generally read-only and authorizes only their own replacement RPC", () => {
    expect(hardeningSql).toContain("security definer");
    expect(hardeningSql).toContain(
      "v_orig.doctor_id <> v_actor_id or v_doctor <> v_actor_id",
    );
    expect(hardeningSql).toContain(
      "v_doctor <> all (public.auth_supervised_doctor_ids())",
    );
    expect(hardeningSql).not.toContain(
      'create policy "appointments_update_doctor"',
    );
  });

  it("re-checks both future timestamps and the canonical buffer in Postgres", () => {
    expect(hardeningSql).toContain(
      "v_orig.scheduled_at <= now() or p_scheduled_at <= now()",
    );
    expect(hardeningSql).toContain(
      "make_interval(mins => a.duration_minutes + 15)",
    );
    expect(hardeningSql).toContain(
      "make_interval(mins => v_duration + 15)",
    );
  });

  it("reconstructs A -> B -> C by links, not by scheduled date", () => {
    expect(hardeningSql).toContain("with recursive target as");
    expect(hardeningSql).toContain(
      "successor.replaces_appointment_id = chain.id",
    );
    expect(hardeningSql).toContain("order by chain.position");
  });

  it("exposes dedicated report and AI replacement KPIs", () => {
    expect(reportSql).toContain("'replacedCount'");
    expect(reportSql).toContain("'replacementRate'");
    expect(aiSql).toContain("'replacement_rate'");
    expect(remainingAnalyticsSql).toContain("'replaced', g.replaced");
  });

  it("excludes replaced originals from remaining performance denominators", () => {
    const exclusions =
      remainingAnalyticsSql.match(
        /status <> 'replaced'::public\.appointment_status/g,
      ) ?? [];
    expect(exclusions.length).toBeGreaterThanOrEqual(4);
    expect(remainingAnalyticsSql).toContain(
      "count(*) filter (\n        where a.status <> 'replaced'::public.appointment_status",
    );
  });
});
