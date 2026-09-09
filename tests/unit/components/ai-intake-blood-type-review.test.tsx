/**
 * Blood type on the pending-patient review surface.
 *
 * The assistant has asked for it since P10 — optional, skippable, and stored on
 * `ai_patient_intakes.blood_type` — and `approve_ai_patient_intake` has copied
 * it onto the new `patients` row since the identity-discovery migration. The
 * one place it was missing was the screen a staff member actually reviews: the
 * modal listed date of birth, phone, email, national ID, department, doctor and
 * created-by, so the field the patient had answered was invisible to the person
 * approving it.
 *
 * Nothing about the write path changed. These tests pin the read: the value
 * reaches the modal when the intake carries one, and an absent value renders as
 * the em dash this screen uses for "nothing recorded" rather than as a blank
 * beside a label or an invented group.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "@/messages/en.json";
import {
  AiIntakeReviewSection,
  type AiPatientIntakeListItem,
} from "@/components/patients/ai-intake-review-section";

const mocks = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/actions/patients", () => ({
  approveAiPatientIntake: vi.fn(),
  rejectAiPatientIntake: vi.fn(),
}));

function intake(overrides: Partial<AiPatientIntakeListItem> = {}): AiPatientIntakeListItem {
  return {
    id: "intake-1",
    conversationId: "conversation-1",
    fullName: "Ali Ibrahim Mohamed",
    dateOfBirth: "2001-03-24",
    phone: "+201111111111",
    email: "ali@example.com",
    nationalId: "29009120123456",
    fullNameAr: null,
    fullNameEn: null,
    bloodType: null,
    departmentName: "Dermatology",
    doctorName: "Sara Ali",
    createdAt: "2026-08-17T09:00:00.000Z",
    hasAppointmentRequest: true,
    ...overrides,
  };
}

async function openReview(item: AiPatientIntakeListItem) {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <AiIntakeReviewSection intakes={[item]} />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /review/i }));
}

beforeEach(() => {
  mocks.searchParams = new URLSearchParams();
  vi.clearAllMocks();
});

describe("pending patient review — blood type", () => {
  it("shows the group the patient gave", async () => {
    await openReview(intake({ bloodType: "O+" }));
    expect(screen.getByText("Blood type")).toBeInTheDocument();
    expect(screen.getByText("O+")).toBeInTheDocument();
  });

  it("shows the empty-state dash when the patient skipped the question", async () => {
    // «مش عارف» and «تخطي» are recorded as null on the intake, and a labelled
    // blank is worse than no value: the reviewer must be able to tell "we asked
    // and they don't know" from a rendering failure, and must never be shown a
    // group nobody typed.
    await openReview(intake({ bloodType: null }));
    expect(screen.getByText("Blood type")).toBeInTheDocument();
    // Three optional fields now share this empty state — the blood group and
    // the two display names — so the dash is asserted on the one this test is
    // about rather than on the only one that used to exist.
    const bloodTypeValue = screen.getByText("Blood type").nextElementSibling;
    expect(bloodTypeValue?.textContent).toBe("—");
    expect(screen.queryByText(/[ABO][+-]/)).not.toBeInTheDocument();
  });
});
