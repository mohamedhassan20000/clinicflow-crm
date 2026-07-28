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
