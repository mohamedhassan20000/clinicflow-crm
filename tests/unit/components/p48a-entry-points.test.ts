import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("P4.8 page entry points", () => {
  it.each([
    ["app/(protected)/patients/[id]/page.tsx", 'type: "patient"'],
    ["app/(protected)/appointments/page.tsx", 'type: "appointments"'],
    ["app/(protected)/dashboard/page.tsx", 'type: "dashboard"'],
  ])("resolves and renders the shared launcher on %s", (path, contextMarker) => {
    const page = source(path);
    expect(page).toContain("resolveAssistantLauncher");
    expect(page).toContain("<AssistantLauncherEntry");
    expect(page).toContain(contextMarker);
  });

  it.each([
    ["app/(protected)/revenue/page.tsx", 'type: "revenue"', "AssistantLauncherEntry"],
    ["app/(protected)/settings/staff/page.tsx", 'type: "staff"', "AssistantLauncherEntry"],
    ["app/(protected)/settings/departments/page.tsx", 'type: "departments"', "AssistantLauncherEntry"],
    ["components/appointments/billing-dialog.tsx", "ScopedAssistantLauncher", "ScopedAssistantLauncher"],
    ["components/settings/staff-profile-sheet.tsx", "ScopedAssistantLauncher", "ScopedAssistantLauncher"],
  ])("wires the P4.8B host %s", (path, contextMarker, launcherMarker) => {
    const page = source(path);
    expect(page).toContain(contextMarker);
    expect(page).toContain(launcherMarker);
  });

  it.each([
    ["cancellations", 'report: "cancellations"'],
    ["doctors", 'report: "doctor_performance"'],
    ["follow-ups", 'report: "followups"'],
    ["no-shows", 'report: "no_shows"'],
    ["receptionists", 'report: "receptionist_performance"'],
    ["revenue", 'report: "revenue"'],
  ])("wires the contextual launcher on the %s report", (route, marker) => {
    const page = source(`app/(protected)/reports/${route}/page.tsx`);
    expect(page).toContain("resolveAssistantLauncher");
    expect(page).toContain("<AssistantLauncherEntry");
    expect(page).toContain(marker);
  });
});
