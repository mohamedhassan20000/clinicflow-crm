import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PatientDetailLoading from "@/app/(protected)/patients/[id]/loading";
import SettingsLoading from "@/app/(protected)/settings/loading";
import OperatorLoading from "@/app/(operator)/operator/loading";

describe("Phase 2 loading boundaries", () => {
  it("renders the settings loading status", () => {
    expect(() => render(<SettingsLoading />)).not.toThrow();
    expect(screen.getByRole("status", { name: "Loading settings" })).toBeInTheDocument();
  });

  it("renders the operator loading status", () => {
    expect(() => render(<OperatorLoading />)).not.toThrow();
    expect(screen.getByRole("status", { name: "Loading operator content" })).toBeInTheDocument();
  });

  it("renders the patient-detail loading status", () => {
    expect(() => render(<PatientDetailLoading />)).not.toThrow();
    expect(screen.getByRole("status", { name: "Loading patient details" })).toBeInTheDocument();
  });
});
