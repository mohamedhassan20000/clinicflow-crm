import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnsavedChangesGuard } from "@/components/shared/unsaved-changes-guard";

describe("UnsavedChangesGuard", () => {
  it("registers only while active and removes the beforeunload handler", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(<UnsavedChangesGuard when={false} />);

    expect(
      addEventListener.mock.calls.filter(([type]) => type === "beforeunload"),
    ).toHaveLength(0);

    view.rerender(<UnsavedChangesGuard when />);
    const firstHandler = addEventListener.mock.calls.find(
      ([type]) => type === "beforeunload",
    )?.[1];
    expect(firstHandler).toBeTypeOf("function");

    const event = new Event("beforeunload", { cancelable: true });
    (firstHandler as EventListener)(event);
    expect(event.defaultPrevented).toBe(true);

    view.rerender(<UnsavedChangesGuard when={false} />);
    expect(removeEventListener).toHaveBeenCalledWith("beforeunload", firstHandler);

    view.rerender(<UnsavedChangesGuard when />);
    const handlers = addEventListener.mock.calls.filter(
      ([type]) => type === "beforeunload",
    );
    const secondHandler = handlers.at(-1)?.[1];
    view.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("beforeunload", secondHandler);
  });
});
