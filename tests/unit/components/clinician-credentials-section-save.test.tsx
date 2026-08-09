import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicianCredentialsForm } from "@/components/clinical/clinician-credentials-form";

const mocks = vi.hoisted(() => ({
  getClinicianSignatureUrl: vi.fn(),
  saveClinicianCredentials: vi.fn(),
}));

vi.mock("@/actions/clinical/credentials", () => ({
  getClinicianSignatureUrl: mocks.getClinicianSignatureUrl,
  saveClinicianCredentials: mocks.saveClinicianCredentials,
}));

describe("ClinicianCredentialsForm section save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClinicianSignatureUrl.mockResolvedValue({ url: null, error: null });
    mocks.saveClinicianCredentials.mockResolvedValue({
      success: true,
      data: { id: "staff-2", signatureUrl: null },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:signature"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("resets when the opened staff member changes and saves credentials only for that member", async () => {
    const { rerender } = render(
      <ClinicianCredentialsForm
        staffId="staff-1"
        initial={{
          professionalLicenseNo: "LICENSE-1",
          specialty: "Cardiology",
          professionalTitle: "Consultant",
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Professional license number"), {
      target: { value: "UNSAVED-STAFF-1" },
    });

    rerender(
      <ClinicianCredentialsForm
        staffId="staff-2"
        initial={{
          professionalLicenseNo: "LICENSE-2",
          specialty: "Dermatology",
          professionalTitle: "Specialist",
        }}
      />,
    );
    expect(screen.getByLabelText("Professional license number")).toHaveValue("LICENSE-2");
    fireEvent.change(screen.getByLabelText("Professional title"), {
      target: { value: "Senior Specialist" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));

    await waitFor(() => expect(mocks.saveClinicianCredentials).toHaveBeenCalledOnce());
    const [staffId, payload] = mocks.saveClinicianCredentials.mock.calls[0] as [string, FormData];
    expect(staffId).toBe("staff-2");
    expect(Object.fromEntries(payload.entries())).toMatchObject({
      professional_license_no: "LICENSE-2",
      specialty: "Dermatology",
      professional_title: "Senior Specialist",
      signature_action: "keep",
    });
    expect(payload.get("avatar_url")).toBeNull();
    expect(payload.get("schedule")).toBeNull();
  });

  it("stages the signature until Save credentials", async () => {
    const { container } = render(
      <ClinicianCredentialsForm
        staffId="staff-2"
        initial={{
          professionalLicenseNo: "LICENSE-2",
          specialty: "Dermatology",
          professionalTitle: "Specialist",
        }}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: { files: [new File(["signature"], "stamp.webp", { type: "image/webp" })] },
    });
    expect(mocks.saveClinicianCredentials).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
    await waitFor(() => expect(mocks.saveClinicianCredentials).toHaveBeenCalledOnce());
    const payload = mocks.saveClinicianCredentials.mock.calls[0]?.[1] as FormData;
    expect(payload.get("signature_action")).toBe("replace");
    expect(payload.get("signature")).toBeInstanceOf(File);
  });
});
