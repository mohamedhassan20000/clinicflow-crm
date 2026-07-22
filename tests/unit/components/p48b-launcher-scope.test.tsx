import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/assistant/assistant-launcher", () => ({
  AssistantLauncher: ({ context }: { context: { type: string } }) => (
    <button type="button">Scoped {context.type} launcher</button>
  ),
}));

import {
  AssistantLauncherScope,
  ScopedAssistantLauncher,
} from "@/components/assistant/assistant-launcher-scope";

describe("P4.8B nested launcher authorization scope", () => {
  it("renders only the exact server-authorized nested context", () => {
    render(
      <AssistantLauncherScope
        context={{ type: "invoices", filter: "outstanding" }}
        role="admin"
      >
        <ScopedAssistantLauncher />
      </AssistantLauncherScope>,
    );

    expect(
      screen.getByRole("button", { name: "Scoped invoices launcher" }),
    ).toBeVisible();
  });

  it("fails closed when the server resolver omitted the launcher", () => {
    render(
      <AssistantLauncherScope context={null} role="admin">
        <ScopedAssistantLauncher />
      </AssistantLauncherScope>,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing outside an authorized source-page scope", () => {
    render(<ScopedAssistantLauncher />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
