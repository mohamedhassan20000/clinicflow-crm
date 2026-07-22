import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LaunchableAssistantPageContext } from "@/lib/ai/page-context";

vi.mock("@/components/assistant/assistant-launcher", () => ({
  AssistantLauncher: ({ context }: { context: LaunchableAssistantPageContext }) => (
    <div data-testid={`launcher-${context.type}`} />
  ),
}));

import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";

const ACCESS = { state: "available" as const, remaining: 19, limit: 20 };
const CONTEXTS: readonly LaunchableAssistantPageContext[] = [
  {
    type: "patient",
    patientId: "00000000-0000-4000-8000-000000000011",
  },
  {
    type: "appointments",
    dateRange: { from: "2026-07-01", to: "2026-07-07" },
  },
  { type: "dashboard" },
  { type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } },
  { type: "reports", report: "no_shows", range: { from: "2026-07-01", to: "2026-07-31" } },
  { type: "invoices", filter: "outstanding" },
  { type: "staff" },
  { type: "departments" },
  { type: "doctor-schedule" },
];

describe("P4.8 rendered server launcher entries", () => {
  it.each(CONTEXTS)(
    "renders an authorized $type entry and omits its unauthorized counterpart",
    (context) => {
      const { rerender } = render(
        <AssistantLauncherEntry
          resolution={{ context, access: ACCESS }}
          role="doctor"
        />,
      );
      expect(screen.getByTestId(`launcher-${context.type}`)).toBeInTheDocument();

      rerender(
        <AssistantLauncherEntry resolution={null} role="doctor" />,
      );
      expect(screen.queryByTestId(`launcher-${context.type}`)).not.toBeInTheDocument();
    },
  );
});
