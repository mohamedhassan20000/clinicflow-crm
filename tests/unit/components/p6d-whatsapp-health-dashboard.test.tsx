import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import type { WhatsAppHealthSnapshot } from "@/lib/messaging/health";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  action: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({
    dateTime: () => "formatted-date",
    number: (value: number) => String(value),
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/actions/messaging-health", () => ({
  runWhatsAppHealthAction: mocks.action,
}));

import { WhatsAppHealthDashboard } from "@/components/settings/whatsapp-health-dashboard";

function snapshot(
  provider: "dialog360" | "meta",
): WhatsAppHealthSnapshot {
  const meta = provider === "meta";
  return {
    configured: true,
    provider,
    channelStatus: "active",
    connectionState: meta ? "connected" : null,
    connectionReason: null,
    webhook: {
      status: "healthy",
      reason: null,
      lastVerifiedAt: "2026-07-28T10:00:00.000Z",
      lastCheckedAt: "2026-07-28T10:00:00.000Z",
      signatureFailures: 0,
      rateLimitRejections: 0,
      telemetryWindowHours: 24,
    },
    lastIncomingAt: "2026-07-28T09:00:00.000Z",
    lastOutgoing: {
      occurredAt: "2026-07-28T09:30:00.000Z",
      status: "delivered",
    },
    templates: {
      total: 2,
      draft: 0,
      submitted: 1,
      approved: 1,
      rejected: 0,
    },
    lastSyncedAt: "2026-07-28T08:00:00.000Z",
    meta: meta
      ? {
          businessVerificationStatus: null,
          accountReviewStatus: "APPROVED",
          phoneStatus: "VERIFIED",
          qualityRating: "GREEN",
          messagingLimitTier: "TIER_1K",
        }
      : null,
    linkedDevice: null,
    readiness: {
      ready: true,
      checks: [
        {
          key: "channel",
          status: "passed",
          value: meta ? "connected" : "active",
          href: "/settings/messaging",
        },
        {
          key: "webhook",
          status: "passed",
          value: "2026-07-28T10:00:00.000Z",
          href: "#diagnostics",
        },
        {
          key: "template",
          status: "passed",
          value: "1",
          href: "/settings/templates",
        },
        {
          key: "business_verification",
          status: meta ? "passed" : "unavailable",
          value: meta ? "APPROVED" : null,
          href: "/settings/messaging",
        },
        {
          key: "quality",
          status: meta ? "passed" : "unavailable",
          value: meta ? "GREEN" : null,
          href: "#provider-health",
        },
      ],
    },
    timeline: [],
  };
}

/**
 * A connected QR pairing, as `getWhatsAppHealthSnapshot` now reports one: a
 * live worker, a paired number, real message timestamps, and every Meta-only
 * requirement marked not-applicable rather than failed.
 */
function linkedDeviceSnapshot(
  overrides: Partial<WhatsAppHealthSnapshot["linkedDevice"] & object> = {},
  readyOverride?: Partial<WhatsAppHealthSnapshot["readiness"]>,
): WhatsAppHealthSnapshot {
  const linkedDevice = {
    sessionStatus: "connected" as const,
    phoneNumber: "+201234567890",
    connectedAt: "2026-07-28T07:00:00.000Z",
    lastHeartbeatAt: "2026-07-28T09:59:30.000Z",
    workerAssigned: true,
    heartbeat: "online" as const,
    ...overrides,
  };
  const connected =
    linkedDevice.sessionStatus === "connected" &&
    linkedDevice.heartbeat === "online";
  return {
    configured: true,
    provider: "linked_device",
    channelStatus: "active",
    connectionState: linkedDevice.sessionStatus,
    connectionReason: null,
    webhook: {
      status: "unknown",
      reason: null,
      lastVerifiedAt: null,
      lastCheckedAt: null,
      signatureFailures: null,
      rateLimitRejections: null,
      telemetryWindowHours: 24,
    },
    lastIncomingAt: "2026-07-28T09:00:00.000Z",
    lastOutgoing: {
      occurredAt: "2026-07-28T09:30:00.000Z",
      status: "delivered",
    },
    templates: { total: 0, draft: 0, submitted: 0, approved: 0, rejected: 0 },
    lastSyncedAt: null,
    meta: null,
    linkedDevice,
    readiness: {
      ready: connected,
      checks: [
        {
          key: "channel",
          status: linkedDevice.sessionStatus === "connected" ? "passed" : "failed",
          value: linkedDevice.sessionStatus,
          href: "/settings/messaging",
        },
        {
          key: "session",
          status: linkedDevice.heartbeat === "online" ? "passed" : "failed",
          value: linkedDevice.lastHeartbeatAt,
          href: "/settings/messaging",
        },
        {
          key: "webhook",
          status: "unavailable",
          value: null,
          href: "#diagnostics",
        },
        {
          key: "template",
          status: "unavailable",
          value: null,
          href: "/settings/templates",
        },
        {
          key: "business_verification",
          status: "unavailable",
          value: null,
          href: "/settings/messaging",
        },
        {
          key: "quality",
          status: "unavailable",
          value: null,
          href: "#provider-health",
        },
      ],
      ...readyOverride,
    },
    timeline: [],
  };
}

describe("P7F linked-device WhatsApp health rendering", () => {
  it("reports a live pairing as connected, with its number and heartbeat", () => {
    render(
      <WhatsAppHealthDashboard snapshot={linkedDeviceSnapshot()} entitled />,
    );

    expect(
      screen.getAllByText("healthProviderLinkedDevice").length,
    ).toBeGreaterThanOrEqual(2);
    // The page header verdict: never "not connected" for a live pairing.
    expect(screen.getByText("healthOverall_ready")).toBeInTheDocument();
    expect(screen.queryByText("healthOverall_not_connected")).toBeNull();
    expect(screen.queryByText("healthNoChannel")).toBeNull();
    expect(screen.getByText("+201234567890")).toBeInTheDocument();
    expect(screen.getAllByText("healthWorker_online").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("healthConnectedNumber")).toBeInTheDocument();
    // ClinicFlow's own message timestamps are still reported.
    expect(screen.getByText("healthLastIncoming")).toBeInTheDocument();
    expect(screen.getByText("healthLastOutgoing")).toBeInTheDocument();
  });

  it("counts only the two checks a linked device can satisfy", () => {
    render(
      <WhatsAppHealthDashboard snapshot={linkedDeviceSnapshot()} entitled />,
    );

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("/ 2")).toBeInTheDocument();
  });

  it("marks every Meta-only signal not applicable instead of failing it", () => {
    render(
      <WhatsAppHealthDashboard snapshot={linkedDeviceSnapshot()} entitled />,
    );

    // 4 provider signals + 2 template counts + 2 telemetry counts + 4
    // unavailable readiness rows + 4 disabled diagnostics.
    expect(
      screen.getAllByText("notAvailableOnConnection").length,
    ).toBeGreaterThanOrEqual(14);
    expect(screen.queryByText("healthTelemetryUnavailable")).toBeNull();
    expect(screen.queryByText("healthCheckNeedsAttention")).toBeNull();
    for (const action of [
      /healthRefreshStatus/,
      /healthSyncTemplates/,
      /healthRepairWebhook/,
      /healthTestConnectivity/,
    ]) {
      expect(screen.getByRole("button", { name: action })).toBeDisabled();
    }
  });

  it("surfaces a disconnected pairing as needing attention", () => {
    render(
      <WhatsAppHealthDashboard
        snapshot={linkedDeviceSnapshot({
          sessionStatus: "disconnected",
          phoneNumber: null,
          heartbeat: "offline",
          workerAssigned: false,
          lastHeartbeatAt: null,
        })}
        entitled
      />,
    );

    expect(screen.getByText("healthOverall_attention")).toBeInTheDocument();
    expect(
      screen.getAllByText("healthWorker_offline").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("+201234567890")).toBeNull();
  });

  it("ships every linked-device string in both locales", () => {
    for (const bundle of [en, ar]) {
      for (const key of [
        "healthProviderLinkedDevice",
        "healthReadiness_session",
        "healthConnectedNumber",
        "healthWorkerHeartbeat",
        "healthLastHeartbeat",
        "healthWorker_online",
        "healthWorker_stale",
        "healthWorker_offline",
      ]) {
        expect(
          (bundle.settings as Record<string, unknown>)[key],
        ).toBeTypeOf("string");
      }
    }
  });
});

describe("P6D WhatsApp health provider-aware rendering", () => {
  it("shows derived health plus honest Meta-only placeholders for 360dialog", () => {
    render(
      <WhatsAppHealthDashboard
        snapshot={snapshot("dialog360")}
        entitled
      />,
    );

    expect(
      screen.getAllByText("healthProviderDialog360").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("notAvailableOnConnection").length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      screen.getByRole("button", { name: /healthRefreshStatus/ }),
    ).toBeDisabled();
    expect(screen.getByText("healthApprovedTemplates")).toBeInTheDocument();
  });

  it("shows the full Meta verification, phone, quality, and limit signals", () => {
    render(
      <WhatsAppHealthDashboard snapshot={snapshot("meta")} entitled />,
    );

    expect(screen.getAllByText("healthProviderMeta").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("approved").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("verified").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("green").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("tier 1k")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /healthRefreshStatus/ }),
    ).toBeEnabled();
  });

  it("labels the stored webhook timestamp as any verified provider callback", () => {
    expect(en.settings.healthLastVerifiedEvent).toBe(
      "Last verified provider callback",
    );
    expect(ar.settings.healthLastVerifiedEvent).toBe(
      "آخر استدعاء موثّق من المزوّد",
    );
  });
});
