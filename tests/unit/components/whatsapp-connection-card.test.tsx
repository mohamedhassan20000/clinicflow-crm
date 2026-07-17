import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/actions/messaging", () => ({
  connectWhatsAppChannel: vi.fn(),
}));

import { WhatsAppConnectionCard } from "@/components/settings/whatsapp-connection-card";

const status = {
  configured: true,
  status: "active" as const,
  displayPhoneNumber: "+96550000001",
  connectedAt: "2026-07-17T09:00:00.000Z",
};

describe("WhatsAppConnectionCard", () => {
  it("shows only safe connection metadata and never prefills a credential", () => {
    render(<WhatsAppConnectionCard status={status} canManage entitled signupUrl="https://hub.360dialog.com/signup" />);
    expect(screen.getByText("+96550000001")).toBeInTheDocument();
    const credential = screen.getByLabelText("360dialog API key");
    expect(credential).toHaveAttribute("type", "password");
    expect(credential).toHaveValue("");
    expect(screen.getByRole("link", { name: /Open 360dialog signup/ })).toHaveAttribute("rel", "noreferrer");
  });

  it("keeps credential controls read-only for managers", () => {
    render(<WhatsAppConnectionCard status={status} canManage={false} entitled signupUrl={null} />);
    expect(screen.getByLabelText("360dialog API key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rotate credentials" })).toBeDisabled();
    expect(screen.getByText(/Only clinic administrators/)).toBeInTheDocument();
  });
});
