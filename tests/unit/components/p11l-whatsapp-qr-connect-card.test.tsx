import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11L — what the admin actually sees between pressing "Connect with QR" and a
 * connected number.
 *
 * Three states have to be distinguishable on screen, because each one asks
 * something different of the person looking at it: a live code to scan, a
 * failure with a way to try again, and a connected number. The state that was
 * broken is the middle one — a failed start left the dialog on its spinner
 * forever — so it is asserted here as a rendered surface rather than only as an
 * action result.
 */

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  read: vi.fn(),
  disconnect: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => "formatted-date" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src)} alt={String(props.alt)} />,
}));
vi.mock("@/actions/messaging-linked-device", () => ({
  startWhatsAppQrSession: mocks.start,
  readWhatsAppQrSession: mocks.read,
  disconnectWhatsAppQrSession: mocks.disconnect,
}));

import { WhatsAppQrConnectCard } from "@/components/settings/whatsapp-qr-connect-card";
import type { LinkedDeviceView } from "@/lib/messaging/linked-device-view";

const NOT_STARTED: LinkedDeviceView = {
  status: "not_started",
  qrImage: null,
  qrExpiresAt: null,
  phoneNumber: null,
  connectedAt: null,
  errorCode: null,
};

const AWAITING_SCAN: LinkedDeviceView = {
  ...NOT_STARTED,
  status: "awaiting_scan",
  qrImage: "data:image/png;base64,QRCODE",
  qrExpiresAt: new Date(Date.now() + 30_000).toISOString(),
};

const CONNECTED: LinkedDeviceView = {
  ...NOT_STARTED,
  status: "connected",
  phoneNumber: "+96599999999",
  connectedAt: "2026-08-29T18:00:00.000Z",
};

function renderCard(overrides: Partial<React.ComponentProps<typeof WhatsAppQrConnectCard>> = {}) {
  return render(
    <WhatsAppQrConnectCard
      initialView={NOT_STARTED}
      ownedBy={null}
      canManage
      entitled
      available
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Connect with QR card", () => {
  it("offers the button only where a pairing service is configured", () => {
    const { unmount } = renderCard({ available: false });
    expect(screen.queryByText("waQrGenerate")).toBeNull();
    expect(screen.getByText("waQrUnavailable")).toBeInTheDocument();
    unmount();

    renderCard();
    expect(screen.getByText("waQrGenerate")).toBeInTheDocument();
  });

  it("shows the code the server rendered, and never the payload behind it", async () => {
    mocks.start.mockResolvedValue({ success: true, view: AWAITING_SCAN });
    renderCard();

    fireEvent.click(screen.getByText("waQrGenerate"));

    const image = await screen.findByAltText("waQrImageAlt");
    expect(image).toHaveAttribute("src", AWAITING_SCAN.qrImage);
    expect(document.body.textContent).not.toContain("2@");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("moves to the connected number when the poll reports the scan landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.start.mockResolvedValue({ success: true, view: AWAITING_SCAN });
    mocks.read.mockResolvedValue(CONNECTED);
    renderCard();

    fireEvent.click(screen.getByText("waQrGenerate"));
    await screen.findByAltText("waQrImageAlt");

    // The panel polls the durable row while a code is on screen.
    await vi.advanceTimersByTimeAsync(2_100);

    await waitFor(() => expect(screen.getAllByText("+96599999999").length).toBeGreaterThan(0));
    expect(screen.queryByAltText("waQrImageAlt")).toBeNull();
  });

  it("shows a reason and a way to try again when the worker cannot be reached", async () => {
    // Exactly what the action now returns for an unreachable or refusing
    // worker. Before P11L this arrived as `not_started` and the dialog sat on
    // its spinner with nothing to act on.
    mocks.start.mockResolvedValue({
      error: "the connection service is unavailable",
      view: { ...NOT_STARTED, status: "error", errorCode: "unavailable" },
    });
    renderCard();

    fireEvent.click(screen.getByText("waQrGenerate"));

    expect(await screen.findByRole("alert")).toHaveTextContent("waQrErrorUnavailable");
    expect(screen.getByText("waQrRegenerate")).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith("the connection service is unavailable");
  });

  it("stops polling once the pairing has settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.start.mockResolvedValue({
      error: "unavailable",
      view: { ...NOT_STARTED, status: "error", errorCode: "unavailable" },
    });
    renderCard();

    fireEvent.click(screen.getByText("waQrGenerate"));
    await screen.findByRole("alert");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
