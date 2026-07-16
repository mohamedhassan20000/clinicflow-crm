import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import { NetworkStatusToast } from "@/components/shared/network-status-toast";

const activeMessages = vi.hoisted(() => ({
  current: {} as Record<string, string>,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => activeMessages.current[key],
}));
vi.mock("sonner", () => ({ toast }));

describe("NetworkStatusToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeMessages.current = en.shared;
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["English", en.shared],
    ["Arabic", ar.shared],
  ])("shows each %s status once and deduplicates repeated events", (_, messages) => {
    activeMessages.current = messages;
    render(<NetworkStatusToast />);

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("offline"));
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(toast.warning).toHaveBeenCalledWith(messages.youAreOffline, {
      id: "network-status",
      duration: Infinity,
    });

    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    expect(toast.success).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith(messages.backOnline, {
      id: "network-status",
      duration: 4000,
    });
  });

  it("removes both listeners on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(<NetworkStatusToast />);

    view.unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "offline",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "online",
      expect.any(Function),
    );
  });
});
