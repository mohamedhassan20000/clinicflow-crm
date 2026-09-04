/**
 * Where the AI review queues sit on each clinic-staff dashboard.
 *
 * The two queues — pending patient intakes and pending AI bookings — are staff
 * work, not reporting, so on every role that may see them they belong with the
 * daily operational cards rather than at the end of the page. Admin and
 * reception put them directly under the schedule / needs-confirmation row;
 * the manager dashboard has no such row, so they go above the analytics.
 *
 * These are source-level assertions on purpose. The thing that regresses is
 * ordering inside JSX that is otherwise expensive to render (three async server
 * components and a Supabase client per role), and ordering is exactly what the
 * source position expresses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const page = source("app/(protected)/dashboard/page.tsx");

/** Slice the dashboard page down to one role's `return`. */
function branch(startMarker: string, endMarker: string) {
  const start = page.indexOf(startMarker);
  const end = endMarker === "" ? page.length : page.indexOf(endMarker);
  expect(start, `missing branch marker: ${startMarker}`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

const branches = {
  admin: () => branch('if (user.role === "admin")', 'if (user.role === "receptionist"'),
  reception: () =>
    branch('if (user.role === "receptionist"', 'if (user.role === "doctor")'),
  // The manager dashboard is the page's fallthrough, after the doctor branch.
  manager: () => branch("// Manager", ""),
};

describe("AI review queue placement", () => {
  it("renders the section once per role branch and nowhere else", () => {
    // Three roles, three renders: no duplicate anywhere on the page.
    expect(page.match(/<AiPendingAppointmentsSection\b/g)).toHaveLength(3);

    for (const [role, slice] of Object.entries(branches)) {
      expect(
        slice().match(/<AiPendingAppointmentsSection\b/g),
        `${role} should render the section exactly once`,
      ).toHaveLength(1);
    }
  });

  it.each([
    ["admin", branches.admin],
    ["reception", branches.reception],
    ["manager", branches.manager],
  ])("hands %s the section through the aiReviewQueues slot", (_role, slice) => {
    const jsx = slice();
    expect(jsx).toContain("aiReviewQueues=");
    expect(jsx).toContain("<AiPendingAppointmentsSection clinicId={clinicId} />");
  });

  it("keeps the section scoped to the session clinic on every role", () => {
    for (const [role, slice] of Object.entries(branches)) {
      const renders = slice().match(/<AiPendingAppointmentsSection[^/]*\/>/g) ?? [];
      expect(renders, role).toHaveLength(1);
      // No role may widen the scope: the clinic id always comes from the session.
      expect(renders[0], role).toBe(
        "<AiPendingAppointmentsSection clinicId={clinicId} />",
      );
    }
  });

  it("still hides both queues from assistants", () => {
    // Reception is the shared receptionist/assistant branch; the gate that keeps
    // assistants out of the review queues must survive the move into the slot.
    const jsx = branches.reception();
    const slot = jsx.indexOf("aiReviewQueues=");
    const gate = jsx.indexOf('user.role === "receptionist" ?', slot);
    const render = jsx.indexOf("<AiPendingAppointmentsSection", slot);

    expect(gate).toBeGreaterThan(slot);
    expect(render).toBeGreaterThan(gate);
  });

  it("puts the admin queues between the schedule row and the analytics", () => {
    const dashboard = source("components/dashboard/admin-dashboard.tsx");

    const schedule = dashboard.indexOf('{t("todaySSchedule")}');
    const confirmation = dashboard.indexOf('{t("needsConfirmationNext7Days")}');
    const queues = dashboard.indexOf("{aiReviewQueues}");
    const analytics = dashboard.indexOf("<AnalyticsSection");

    expect(schedule).toBeGreaterThan(-1);
    expect(confirmation).toBeGreaterThan(schedule);
    expect(queues).toBeGreaterThan(confirmation);
    expect(analytics).toBeGreaterThan(queues);
    expect(dashboard.match(/\{aiReviewQueues\}/g)).toHaveLength(1);
  });

  it("puts the reception queues directly under the schedule row", () => {
    const dashboard = source("components/dashboard/receptionist-dashboard.tsx");

    const schedule = dashboard.indexOf('{t("todaySSchedule")}');
    const confirmation = dashboard.indexOf('{t("needsConfirmation")}');
    const queues = dashboard.indexOf("{aiReviewQueues}");

    expect(schedule).toBeGreaterThan(-1);
    expect(confirmation).toBeGreaterThan(schedule);
    expect(queues).toBeGreaterThan(confirmation);
    expect(dashboard.match(/\{aiReviewQueues\}/g)).toHaveLength(1);
  });

  it("puts the manager queues above the analytics", () => {
    const dashboard = source("components/dashboard/manager-dashboard.tsx");

    const queues = dashboard.indexOf("{aiReviewQueues}");
    const analytics = dashboard.indexOf("<AnalyticsSection");

    expect(queues).toBeGreaterThan(-1);
    expect(analytics).toBeGreaterThan(queues);
    expect(dashboard.match(/\{aiReviewQueues\}/g)).toHaveLength(1);
  });

  it("keeps the queues out of every dashboard a role must not see them on", () => {
    // The doctor dashboard and the owner/operator console never render them.
    expect(source("components/dashboard/doctor-dashboard.tsx")).not.toContain(
      "AiPendingAppointmentsSection",
    );
    expect(branch('if (user.role === "doctor")', "// Manager")).not.toContain(
      "<AiPendingAppointmentsSection",
    );
  });

  it("keeps the two-column responsive layout on the section itself", () => {
    const section = source("components/dashboard/ai-pending-appointments-section.tsx");
    expect(section).toContain("md:grid-cols-2");
  });
});
