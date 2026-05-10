import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PatientProfilePrintDocument } from "@/components/patients/patient-profile-print-document";

const baseProps = {
  avatarUrl: "https://signed.local/patient-photo.webp",
  fullName: "Maya Hassan",
  initials: "MH",
  fileNumber: "CF-0042",
  nationalId: "12345678901",
  phone: "+90 555 123 45 67",
  email: "maya@example.com",
  dateOfBirth: "1990-04-12",
  age: 36,
  bloodType: "A+",
  departmentName: "Cardiology",
  treatingDoctorName: "Dr. Sara Emad",
  insuranceName: "Acme Insurance",
  registrationDate: "2026-01-15T08:00:00.000Z",
  billingTotals: {
    billed: 1200,
    collected: 900,
    outstanding: 300,
    accountBalance: 50,
  },
  canViewBilling: true,
  appointments: [
    {
      id: "appt-1",
      scheduledAt: "2026-05-10T09:00:00.000Z",
      status: "completed",
      departmentName: "Cardiology",
      doctorName: "Dr. Sara Emad",
      totalAmount: 1200,
      outstandingAmount: 300,
    },
  ],
  generatedAt: new Date("2026-05-11T09:00:00.000Z"),
};

describe("PatientProfilePrintDocument", () => {
  it("renders the required patient profile fields for print", () => {
    render(<PatientProfilePrintDocument {...baseProps} />);

    expect(screen.getByText("Patient Profile")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Maya Hassan" })).toBeInTheDocument();
    expect(screen.getAllByText("CF-0042").length).toBeGreaterThan(0);
    expect(screen.getByText("12345678901")).toBeInTheDocument();
    expect(screen.getByText("+90 555 123 45 67")).toBeInTheDocument();
    expect(screen.getByText("maya@example.com")).toBeInTheDocument();
    expect(screen.getByText("12 Apr 1990")).toBeInTheDocument();
    expect(screen.getByText("36 years")).toBeInTheDocument();
    expect(screen.getByText("A+")).toBeInTheDocument();
    expect(screen.getAllByText("Cardiology").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Dr. Sara Emad").length).toBeGreaterThan(0);
    expect(screen.getByText("Acme Insurance")).toBeInTheDocument();
    expect(screen.getByText("Billing Summary")).toBeInTheDocument();
    expect(screen.getByText("Appointments Summary")).toBeInTheDocument();
  });

  it("includes the patient photo when an avatar URL exists", () => {
    render(<PatientProfilePrintDocument {...baseProps} />);

    const photo = screen.getByAltText("Maya Hassan patient photo");
    expect(photo).toHaveAttribute("src", baseProps.avatarUrl);
    expect(photo).toHaveAttribute("data-patient-profile-print-photo");
  });
});
