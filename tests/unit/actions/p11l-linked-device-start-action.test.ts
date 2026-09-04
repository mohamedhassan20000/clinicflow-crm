import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11L — what the settings panel is handed when a pairing cannot be started.
 *
 * The defect: every failure returned the session row as it stood, which for a
 * clinic that had never paired is `not_started`. That status is not one the
 * panel polls out of and not one `QrPanel` has a message for, so the dialog sat
 * on its spinner indefinitely behind a toast the admin had already dismissed.
 * A start that failed has to come back saying so, in the shape the panel
 * already knows how to render — an `error` view with a Regenerate button.
 */

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  requireRole: vi.fn(),
  revalidatePath: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  startLinkedDeviceSession: vi.fn(),
  readLinkedDeviceSession: vi.fn(),
  disconnectLinkedDeviceSession: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/messaging/linked-device", () => ({
  startLinkedDeviceSession: mocks.startLinkedDeviceSession,
  readLinkedDeviceSession: mocks.readLinkedDeviceSession,
  disconnectLinkedDeviceSession: mocks.disconnectLinkedDeviceSession,
}));

import { startWhatsAppQrSession } from "@/actions/messaging-linked-device";
import { isLinkedDeviceTransient } from "@/lib/messaging/linked-device-view";

const NEVER_PAIRED = {
  status: "not_started" as const,
  qrImage: null,
  qrExpiresAt: null,
  phoneNumber: null,
  connectedAt: null,
  errorCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMutationRole.mockResolvedValue({ clinicId: "clinic-a", role: "admin" });
  mocks.getEntitlements.mockResolvedValue({});
  mocks.hasFeature.mockReturnValue(true);
  mocks.readLinkedDeviceSession.mockResolvedValue(NEVER_PAIRED);
});

describe("starting a pairing from the settings panel", () => {
  it("returns the worker's fresh view when the pairing starts", async () => {
    const view = { ...NEVER_PAIRED, status: "starting" as const };
    mocks.startLinkedDeviceSession.mockResolvedValue({ ok: true, view });

    await expect(startWhatsAppQrSession()).resolves.toEqual({ success: true, view });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/messaging");
  });

  it("tells the admin the pairing service itself is out of date, and says nothing else", async () => {
    mocks.startLinkedDeviceSession.mockResolvedValue({ ok: false, code: "WORKER_UPDATE_REQUIRED" });

    const result = await startWhatsAppQrSession();

    // A distinct sentence, because it points at a distinct action: this one is
    // an operator's to take, and "try again in a moment" would send an admin
    // round a loop that cannot terminate.
    expect(result.error).toBe("messaging.whatsAppServiceUpdateRequiredBeforePairing");
    expect(result.view).toMatchObject({ status: "error", errorCode: "worker_outdated" });
    expect(isLinkedDeviceTransient(result.view.status)).toBe(false);
    // Nothing was paired, so nothing is revalidated and no session is re-read
    // to be presented as if a pairing had begun.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.readLinkedDeviceSession).not.toHaveBeenCalled();
  });

  it.each([
    ["UNAVAILABLE", "messaging.theWhatsAppConnectionServiceIsUnavailable"],
    ["OWNED_ELSEWHERE", "messaging.thisClinicsWhatsAppSessionIsHeldByAnotherService"],
    ["REJECTED", "messaging.theWhatsAppConnectionServiceIsUnavailable"],
  ])("leaves the panel showing an error, not a spinner, after %s", async (code, key) => {
    mocks.startLinkedDeviceSession.mockResolvedValue({ ok: false, code });

    const result = await startWhatsAppQrSession();

    expect(result.error).toBe(key);
    expect(result.view.status).toBe("error");
    expect(result.view.errorCode).toBe("unavailable");
    // `error` is terminal: the panel renders the sentence and the Regenerate
    // button instead of polling a row that is never going to change.
    expect(isLinkedDeviceTransient(result.view.status)).toBe(false);
    // Nothing about the worker, the holder or the token crosses the boundary.
    expect(JSON.stringify(result)).not.toContain("worker");
  });

  it("keeps the stored view when the Meta API method owns the channel", async () => {
    // That card explains the conflict itself; there is nothing here to retry,
    // so the QR card must not start claiming a failure of its own.
    mocks.startLinkedDeviceSession.mockResolvedValue({ ok: false, code: "OWNED_BY_META" });

    const result = await startWhatsAppQrSession();

    expect(result.error).toBe("messaging.disconnectTheMetaApiConnectionFirst");
    expect(result.view).toEqual(NEVER_PAIRED);
  });

  it("never reaches the worker for a clinic whose plan excludes WhatsApp", async () => {
    mocks.hasFeature.mockReturnValue(false);

    const result = await startWhatsAppQrSession();

    expect(result.error).toBe("messaging.whatsAppIsNotIncludedInYourPlan");
    expect(mocks.startLinkedDeviceSession).not.toHaveBeenCalled();
  });
});
