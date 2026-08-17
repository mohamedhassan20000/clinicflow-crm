import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => "formatted-date" }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/actions/messaging-onboarding", () => ({
  connectMetaApiCredentials: mocks.connect,
  disconnectWhatsAppChannel: mocks.disconnect,
}));

import { MetaApiConnectCard } from "@/components/settings/meta-api-connect-card";
import type { WhatsAppBusinessConnectionView } from "@/lib/messaging/connection-view";

const notConnected: WhatsAppBusinessConnectionView = {
  status: "not_connected",
  displayPhoneNumber: null,
  connectedAt: null,
  mode: null,
};

const webhookSetup = {
  callbackUrl: "https://clinicflow.fit/api/webhooks/whatsapp?clinic=clinic-a",
  verifyToken: "derived-token-for-clinic-a",
};

function renderCard(overrides: Partial<React.ComponentProps<typeof MetaApiConnectCard>> = {}) {
  return render(
    <MetaApiConnectCard
      initialConnection={notConnected}
      canManage
      entitled
      webhookSetup={webhookSetup}
      {...overrides}
    />,
  );
}

/** Fills every required credential field with a shape-valid value. */
function fillCredentials() {
  fireEvent.change(screen.getByLabelText("metaApiAppId"), {
    target: { value: "1234567890" },
  });
  fireEvent.change(screen.getByLabelText("metaApiAppSecret"), {
    target: { value: "a".repeat(32) },
  });
  fireEvent.change(screen.getByLabelText("metaApiWabaId"), {
    target: { value: "2233445566" },
  });
  fireEvent.change(screen.getByLabelText("phoneNumberId"), {
    target: { value: "9988776655" },
  });
  fireEvent.change(screen.getByLabelText("metaApiAccessToken"), {
    target: { value: "T".repeat(40) },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("P7D Meta API connect card", () => {
  it("shows the not-connected state and the clinic-specific webhook setup", () => {
    renderCard();

    expect(screen.getByText("waConnNotConnected")).toBeInTheDocument();
    expect(screen.getByText(webhookSetup.callbackUrl)).toBeInTheDocument();
    expect(screen.getByText(webhookSetup.verifyToken)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /metaApiConnect/ })).toBeInTheDocument();
  });

  it("submits the clinic's own credentials and reflects the returned connection", async () => {
    mocks.connect.mockResolvedValue({
      success: true,
      connection: {
        status: "connected",
        displayPhoneNumber: "+20 100 000 0000",
        connectedAt: "2026-08-16T10:00:00.000Z",
        mode: "manual_api",
      },
    });

    renderCard();
    fillCredentials();
    fireEvent.submit(screen.getByRole("button", { name: /metaApiConnect/ }).closest("form")!);

    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    expect(mocks.connect).toHaveBeenCalledWith({
      appId: "1234567890",
      appSecret: "a".repeat(32),
      accessToken: "T".repeat(40),
      phoneNumberId: "9988776655",
      wabaId: "2233445566",
    });
    await waitFor(() => expect(screen.getByText("waConnConnected")).toBeInTheDocument());
    expect(screen.getByText("+20 100 000 0000")).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("metaApiConnectedToast");
  });

  it("surfaces the server's error message and stays disconnected", async () => {
    mocks.connect.mockResolvedValue({ error: "messaging.couldNotVerifyMetaApiCredentials" });

    renderCard();
    fillCredentials();
    fireEvent.submit(screen.getByRole("button", { name: /metaApiConnect/ }).closest("form")!);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "messaging.couldNotVerifyMetaApiCredentials",
      ),
    );
    expect(screen.getByText("waConnNotConnected")).toBeInTheDocument();
  });

  it("reports the verifying and error states from a manual_api channel", () => {
    // Distinct keys force a remount, so each case starts from its own
    // `initialConnection` rather than the previous render's internal state.
    const { rerender } = render(
      <MetaApiConnectCard
        key="verifying"
        initialConnection={{
          status: "verifying",
          displayPhoneNumber: "+20 100 000 0000",
          connectedAt: null,
          mode: "manual_api",
        }}
        canManage
        entitled
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.getByText("waConnVerifying")).toBeInTheDocument();
    expect(screen.getByText("metaApiVerifyingNote")).toBeInTheDocument();

    rerender(
      <MetaApiConnectCard
        key="failed"
        initialConnection={{
          status: "failed",
          displayPhoneNumber: null,
          connectedAt: null,
          mode: "manual_api",
        }}
        canManage
        entitled
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.getByText("waConnError")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("metaApiFailedNote");
  });

  it("defers to the QR method when that method owns the channel", () => {
    renderCard({
      initialConnection: {
        status: "connected",
        displayPhoneNumber: "+20 100 000 0000",
        connectedAt: "2026-08-16T10:00:00.000Z",
        mode: "coexistence",
      },
    });

    expect(screen.getByText("metaApiOwnedByQr")).toBeInTheDocument();
    // No competing credential form, and this card does not claim the connection.
    expect(screen.queryByLabelText("metaApiAppId")).not.toBeInTheDocument();
    expect(screen.getByText("waConnNotConnected")).toBeInTheDocument();
  });

  it("offers a disconnect action only once this method owns a channel", () => {
    const { rerender } = render(
      <MetaApiConnectCard
        key="disconnected"
        initialConnection={notConnected}
        canManage
        entitled
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.queryByRole("button", { name: /metaApiDisconnect/ })).not.toBeInTheDocument();

    rerender(
      <MetaApiConnectCard
        key="connected"
        initialConnection={{
          status: "connected",
          displayPhoneNumber: "+20 100 000 0000",
          connectedAt: "2026-08-16T10:00:00.000Z",
          mode: "manual_api",
        }}
        canManage
        entitled
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.getByRole("button", { name: /metaApiDisconnect/ })).toBeInTheDocument();
  });

  it("renders read-only for a manager and hides the form without the entitlement", () => {
    const { rerender } = render(
      <MetaApiConnectCard
        key="manager"
        initialConnection={notConnected}
        canManage={false}
        entitled
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.getByText("managerConnectionReadOnly")).toBeInTheDocument();
    expect(screen.getByLabelText("metaApiAppId")).toBeDisabled();

    rerender(
      <MetaApiConnectCard
        key="unentitled"
        initialConnection={notConnected}
        canManage
        entitled={false}
        webhookSetup={webhookSetup}
      />,
    );
    expect(screen.getByText("whatsAppNotIncluded")).toBeInTheDocument();
    expect(screen.queryByLabelText("metaApiAppId")).not.toBeInTheDocument();
  });

  it("states plainly when the environment cannot produce webhook details", () => {
    renderCard({ webhookSetup: null });
    expect(screen.getByText("metaApiWebhookUnavailable")).toBeInTheDocument();
  });
});
