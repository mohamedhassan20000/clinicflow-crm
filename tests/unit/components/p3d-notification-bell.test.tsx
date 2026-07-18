import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: () => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  }),
}));

import { NotificationBell } from "@/components/notifications/notification-bell";

describe("NotificationBell", () => {
  it("navigates to the notifications page", () => {
    render(<NotificationBell unreadCount={0} />);
    const link = screen.getByTestId("notification-bell");
    expect(link).toHaveAttribute("href", "/notifications");
    expect(link).toHaveAccessibleName("Notifications");
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("shows the unread badge with the exact count", () => {
    render(<NotificationBell unreadCount={5} />);
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("5");
    expect(screen.getByTestId("notification-bell")).toHaveAccessibleName(
      "Notifications, 5 unread",
    );
  });

  it("caps the badge at 99+", () => {
    render(<NotificationBell unreadCount={250} />);
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("99+");
  });
});
