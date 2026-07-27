import { describe, expect, it } from "vitest";
import {
  ASSISTANT_LAUNCHER_REGISTRY,
  launcherDefaultEnabled,
} from "@/lib/ai/launchers";

function area(name: string) {
  const def = ASSISTANT_LAUNCHER_REGISTRY.find((d) => d.area === name);
  if (!def) throw new Error(`no launcher area ${name}`);
  return def;
}

describe("assistant placement — per-role product defaults", () => {
  it("keeps every originally-shipped combination enabled by default", () => {
    expect(launcherDefaultEnabled(area("patient"), "doctor")).toBe(true);
    for (const role of ["admin", "receptionist", "doctor"] as const) {
      expect(launcherDefaultEnabled(area("appointments"), role)).toBe(true);
    }
    for (const role of ["admin", "manager", "receptionist", "doctor"] as const) {
      expect(launcherDefaultEnabled(area("dashboard"), role)).toBe(true);
    }
    expect(launcherDefaultEnabled(area("revenue"), "admin")).toBe(true);
    expect(launcherDefaultEnabled(area("revenue"), "manager")).toBe(true);
    for (const role of ["admin", "manager", "receptionist"] as const) {
      expect(launcherDefaultEnabled(area("reports"), role)).toBe(true);
    }
  });

  it("defaults every newly-introduced combination OFF", () => {
    // Assistant everywhere it is newly supported.
    expect(launcherDefaultEnabled(area("patient"), "assistant")).toBe(false);
    expect(launcherDefaultEnabled(area("appointments"), "assistant")).toBe(false);
    expect(launcherDefaultEnabled(area("dashboard"), "assistant")).toBe(false);
    expect(launcherDefaultEnabled(area("reports"), "assistant")).toBe(false);
    // Manager on Appointments (manager gained the page in this work).
    expect(launcherDefaultEnabled(area("appointments"), "manager")).toBe(false);
    // Doctor on Reports (doctor gained a scoped Reports page).
    expect(launcherDefaultEnabled(area("reports"), "doctor")).toBe(false);
  });

  it("treats fundamentally-unsupported combinations as not enabled", () => {
    // Assistant is not supported on financial/admin-settings areas → default false
    // and not in the supported role set (renders as a disabled placeholder).
    for (const name of ["revenue", "invoices", "staff", "departments", "doctor-schedule"]) {
      expect(area(name).roles.includes("assistant")).toBe(false);
      expect(launcherDefaultEnabled(area(name), "assistant")).toBe(false);
    }
  });

  it("keeps roles and the per-role default map consistent", () => {
    for (const def of ASSISTANT_LAUNCHER_REGISTRY) {
      expect([...def.roles].sort()).toEqual(
        Object.keys(def.defaultEnabledByRole).sort(),
      );
    }
  });
});
