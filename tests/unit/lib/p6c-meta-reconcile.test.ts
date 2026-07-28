import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRow: vi.fn(),
  countApproved: vi.fn(),
  applyState: vi.fn(),
  listChannels: vi.fn(),
  createScoped: vi.fn(),
  decrypt: vi.fn(),
  fetchState: vi.fn(),
  fetchTemplates: vi.fn(),
  getSubscription: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  getWhatsAppChannelStateRow: mocks.getRow,
  countApprovedTemplates: mocks.countApproved,
  applyMetaChannelState: mocks.applyState,
  listActiveMetaChannels: mocks.listChannels,
  createClinicScopedAdminClient: mocks.createScoped,
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: mocks.decrypt }));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  fetchMetaChannelState: mocks.fetchState,
  fetchMetaTemplates: mocks.fetchTemplates,
  getMetaWabaSubscription: mocks.getSubscription,
  subscribeMetaWabaWebhook: mocks.subscribe,
}));

import {
  applyChannelStateSignals,
  reconcileMetaChannel,
} from "@/lib/messaging/meta-reconcile";

/** In-memory clinic_channels state, keyed by clinic, mutated by writeState. */
function makeStore() {
  const rows: Record<string, Record<string, unknown>> = {
    "clinic-a": {
      id: "chan-a",
      status: "pending",
      credentials_encrypted: "cipher-a",
      connection_state: null,
      business_verification_status: null,
      account_review_status: null,
      phone_status: null,
      quality_rating: null,
      messaging_limit_tier: null,
      webhook_subscribed: true,
      provider_account_id: "waba-a",
      last_signal_at: null,
      last_synced_at: null,
      last_state_reason: null,
      updated_at: "2026-07-28T00:00:00.000Z",
    },
    "clinic-b": {
      id: "chan-b",
      status: "pending",
      credentials_encrypted: "cipher-b",
      connection_state: null,
      business_verification_status: null,
      account_review_status: null,
      phone_status: null,
      quality_rating: null,
      messaging_limit_tier: null,
      webhook_subscribed: true,
      provider_account_id: "waba-b",
      last_signal_at: null,
      last_synced_at: null,
      last_state_reason: null,
      updated_at: "2026-07-28T00:00:00.000Z",
    },
  };
  return rows;
}

let store: Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  store = makeStore();
  mocks.getRow.mockImplementation((clinicId: string) =>
    Promise.resolve({ data: store[clinicId] ?? null, error: null }),
  );
  mocks.countApproved.mockResolvedValue(0);
  mocks.applyState.mockImplementation(
    (input: Record<string, unknown> & { clinicId: string }) => {
      const row = store[input.clinicId];
      const transitioned = row.connection_state !== input.connectionState;
      const changed =
        transitioned ||
        row.status !== input.status ||
        row.phone_status !== input.phoneStatus ||
        row.account_review_status !== input.accountReviewStatus ||
        Boolean(input.lastSyncedAt);
      Object.assign(row, {
        status: input.status,
        connection_state: input.connectionState,
        business_verification_status: input.businessVerificationStatus,
        account_review_status: input.accountReviewStatus,
        phone_status: input.phoneStatus,
        quality_rating: input.qualityRating,
        messaging_limit_tier: input.messagingLimitTier,
        webhook_subscribed: input.webhookSubscribed,
        last_state_reason: input.lastStateReason,
        last_synced_at: input.lastSyncedAt ?? row.last_synced_at,
        updated_at: new Date(
          new Date(String(row.updated_at)).valueOf() + 1,
        ).toISOString(),
      });
      return Promise.resolve({
        data: [{
          applied: changed,
          transitioned,
          connection_state: input.connectionState,
          state_reason: input.lastStateReason,
        }],
        error: null,
      });
    },
  );
  mocks.decrypt.mockReturnValue({ accessToken: "t", phoneNumberId: "p", wabaId: "w" });
  mocks.fetchTemplates.mockResolvedValue({ ok: true, templates: [] });
  mocks.getSubscription.mockResolvedValue({ ok: true, subscribed: true });
  mocks.subscribe.mockResolvedValue({ ok: true });
  mocks.createScoped.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  });
});

describe("P6C reconciliation applier", () => {
  it("writes the derived state and audits exactly one transition on a real change", async () => {
    const result = await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: { phoneStatus: "PENDING" },
    });
    expect(result).toMatchObject({ applied: true, transitioned: true, state: "waiting_phone_verification" });
    expect(mocks.applyState).toHaveBeenCalledTimes(1);
    expect(mocks.applyState.mock.calls[0][0]).toMatchObject({
      clinicId: "clinic-a",
      channelId: "chan-a",
      connectionState: "waiting_phone_verification",
    });
  });

  it("is idempotent — the same signals a second time write and audit nothing", async () => {
    await applyChannelStateSignals({ clinicId: "clinic-a", signals: { phoneStatus: "PENDING" } });
    mocks.applyState.mockClear();
    const second = await applyChannelStateSignals({ clinicId: "clinic-a", signals: { phoneStatus: "PENDING" } });
    expect(second).toMatchObject({ applied: false, transitioned: false });
    expect(mocks.applyState).toHaveBeenCalledOnce();
    expect(mocks.applyState.mock.results[0]).toBeDefined();
  });

  it("the same Graph response twice yields one transition (no duplicate audit rows)", async () => {
    mocks.fetchState.mockResolvedValue({
      ok: true,
      snapshot: {
        businessVerificationStatus: "verified",
        accountReviewStatus: "APPROVED",
        phoneStatus: "CONNECTED",
        qualityRating: "GREEN",
        messagingLimitTier: "TIER_1K",
        webhookSubscribed: true,
      },
    });
    mocks.countApproved.mockResolvedValue(1);

    const first = await reconcileMetaChannel("clinic-a");
    const second = await reconcileMetaChannel("clinic-a");
    expect(first).toMatchObject({ ok: true, transitioned: true, state: "connected" });
    expect(second).toMatchObject({ ok: true, transitioned: false, state: "connected" });
    // The transactional RPC reports exactly one transition; it owns the audit row.
    expect(
      mocks.applyState.mock.calls.filter(
        ([call]) => call.connectionState === "connected",
      ),
    ).toHaveLength(2);
  });

  it("promotes channel status to active only when connected", async () => {
    mocks.fetchState.mockResolvedValue({
      ok: true,
      snapshot: {
        businessVerificationStatus: "verified",
        accountReviewStatus: "APPROVED",
        phoneStatus: "CONNECTED",
        qualityRating: "GREEN",
        messagingLimitTier: "TIER_1K",
        webhookSubscribed: true,
      },
    });
    mocks.countApproved.mockResolvedValue(1);
    await reconcileMetaChannel("clinic-a");

    expect(store["clinic-a"].status).toBe("active");
    expect(store["clinic-a"].connection_state).toBe("connected");
  });

  it("clinic A's signal never touches clinic B's channel (two-clinic isolation)", async () => {
    await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: { phoneStatus: "CONNECTED", businessVerificationStatus: "verified" },
    });

    expect(store["clinic-b"].connection_state).toBeNull();
    expect(store["clinic-b"].status).toBe("pending");
    for (const call of mocks.applyState.mock.calls) {
      expect(call[0].clinicId).toBe("clinic-a");
    }
  });

  it("persists a rejected account review across later template-only re-derivation", async () => {
    await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: {
        phoneStatus: "VERIFIED",
        accountReviewStatus: "REJECTED",
      },
    });
    const second = await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: {},
    });
    expect(store["clinic-a"].account_review_status).toBe("REJECTED");
    expect(second.state).toBe("verification_failed");
  });

  it("does not let an unordered stale approval recover a stored rejection", async () => {
    store["clinic-a"].account_review_status = "REJECTED";
    store["clinic-a"].connection_state = "verification_failed";
    store["clinic-a"].status = "error";
    const result = await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: { accountReviewStatus: "APPROVED" },
    });
    expect(store["clinic-a"].account_review_status).toBe("REJECTED");
    expect(result.state).toBe("verification_failed");
  });

  it("ignores a provider signal older than the stored observation timestamp", async () => {
    store["clinic-a"].last_signal_at = "2026-07-28T10:00:00.000Z";
    const result = await applyChannelStateSignals({
      clinicId: "clinic-a",
      signals: { accountReviewStatus: "APPROVED" },
      observedAt: "2026-07-28T09:00:00.000Z",
    });
    expect(result.applied).toBe(false);
    expect(mocks.applyState).not.toHaveBeenCalled();
  });

  it("retries and verifies a missing WABA subscription before activation", async () => {
    mocks.fetchState.mockResolvedValue({
      ok: true,
      snapshot: {
        businessVerificationStatus: null,
        accountReviewStatus: "APPROVED",
        phoneStatus: "VERIFIED",
        qualityRating: "GREEN",
        messagingLimitTier: null,
        webhookSubscribed: false,
      },
    });
    mocks.countApproved.mockResolvedValue(1);
    mocks.subscribe.mockResolvedValue({ ok: true });
    mocks.getSubscription.mockResolvedValue({ ok: true, subscribed: true });
    const result = await reconcileMetaChannel("clinic-a");
    expect(result).toMatchObject({ ok: true, state: "connected" });
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.getSubscription).toHaveBeenCalledOnce();
  });

  it("a Graph poll failure is a no-op result, never a throw", async () => {
    mocks.fetchState.mockResolvedValue({ ok: false, error: "Meta status reconciliation failed with HTTP 500." });
    const result = await reconcileMetaChannel("clinic-a");
    expect(result).toMatchObject({ ok: false });
    expect(mocks.applyState).not.toHaveBeenCalled();
  });
});
