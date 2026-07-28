import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  refresh: vi.fn(),
  toastMessage: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => "formatted-date" }),
}));
vi.mock("sonner", () => ({
  toast: {
    message: mocks.toastMessage,
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));
vi.mock("@/actions/messaging-onboarding", () => ({
  completeMetaOnboarding: mocks.complete,
  refreshMetaConnectionState: mocks.refresh,
}));

import { WhatsAppOnboardingWizard } from "@/components/settings/whatsapp-onboarding-wizard";

const emptyState = {
  configured: false,
  connectionState: null,
  reason: null,
  status: null,
  displayPhoneNumber: null,
  qualityRating: null,
  messagingLimitTier: null,
  businessVerificationStatus: null,
  phoneStatus: null,
  lastSyncedAt: null,
  connectedAt: null,
};

afterEach(() => {
  vi.clearAllMocks();
  delete (window as unknown as { FB?: unknown }).FB;
});

describe("P6C WhatsApp onboarding wizard", () => {
  it("maps unexpected persisted state codes to safe static translation fallbacks", () => {
    const { rerender } = render(
      <WhatsAppOnboardingWizard
        key="unknown-state"
        initialState={{ ...emptyState, configured: true, connectionState: "unexpected_state" }}
        clinic={{ name: "Clinic", phone: "+15551234567", address: "Address" }}
        canManage
        entitled
        metaConfig={{ appId: "app-id", configId: "config-id" }}
      />,
    );

    expect(screen.getByText("connectionState.not_started")).toBeInTheDocument();

    rerender(
      <WhatsAppOnboardingWizard
        key="unknown-reason"
        initialState={{
          ...emptyState,
          configured: true,
          connectionState: "verification_failed",
          reason: "raw_provider_failure",
        }}
        clinic={{ name: "Clinic", phone: "+15551234567", address: "Address" }}
        canManage
        entitled
        metaConfig={{ appId: "app-id", configId: "config-id" }}
      />,
    );

    expect(screen.getByText("connectionReason.generic")).toBeInTheDocument();
  });

  it("treats popup abandonment as incomplete and does not call the server completion action", async () => {
    (window as unknown as {
      FB: { login: (callback: (response: unknown) => void) => void };
    }).FB = {
      login: (callback) => callback({ authResponse: {} }),
    };
    render(
      <WhatsAppOnboardingWizard
        initialState={emptyState}
        clinic={{ name: "Clinic", phone: "+15551234567", address: "Address" }}
        canManage
        entitled
        metaConfig={{ appId: "app-id", configId: "config-id" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "connectViaMeta" }));
    await waitFor(() => {
      expect(mocks.toastMessage).toHaveBeenCalledWith("metaSignupIncomplete");
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "connectViaMeta" })).toBeInTheDocument();
  });
});
