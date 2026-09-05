/**
 * Phase 7 · P7-01 — the capability panel renders the write surface.
 *
 * Phase 7 added a correctly-resolved `actions` array to
 * `resolveAssistantCapabilities` and wired it into the model-facing
 * `list_my_capabilities`, but never into the component a *user* looks at when
 * deciding what they are authorizing. The resolver was therefore doing the work
 * and the panel was discarding it, while a code comment, a test's describe name
 * and the implementation report all claimed otherwise.
 *
 * `tests/unit/ai/phase7-capability-surface.test.ts` asserts the *resolution*.
 * This file asserts the *render*, and — the part that actually failed — that the
 * chat's own call site passes it through. Every assertion here is against
 * rendered output, so re-introducing the gap by dropping the prop fails.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AssistantCapabilities } from "@/lib/ai/capabilities";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { messages?: unknown[] }) => ({
    messages: options.messages ?? [],
    sendMessage: mocks.sendMessage,
    status: "ready",
    error: undefined,
    stop: mocks.stop,
    clearError: mocks.clearError,
  }),
}));

vi.mock("@/actions/ai-permissions", () => ({
  setStaffAiPermission: vi.fn(),
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";
import { CapabilityPanel } from "@/components/assistant/capability-panel";

const CONVERSATION = "00000000-0000-4000-8000-000000000010";

const ITEMS: AssistantCapabilities["items"] = [
  {
    name: "query_resource",
    group: "operational",
    description: "Read authorized clinic records.",
  },
];

const RESOURCES: AssistantCapabilities["resources"] = [
  { id: "patients", label: "Patients", description: "Authorized patient records." },
  {
    id: "appointments",
    label: "Appointments",
    description: "Authorized appointment records.",
  },
];

/**
 * One action per risk class the registry declares, so the render is checked
 * across the whole vocabulary rather than on the happy path only.
 */
const ACTIONS: AssistantCapabilities["actions"] = [
  {
    id: "appointments.create",
    label: "Book an appointment",
    description: "Create an appointment for an authorized patient.",
    risk: "normal",
  },
  {
    id: "documents.issue",
    label: "Issue a document",
    description: "Issue a clinical or administrative document.",
    risk: "sensitive",
  },
  {
    id: "appointments.cancel",
    label: "Cancel an appointment",
    description: "Cancel a scheduled appointment.",
    risk: "destructive",
  },
  {
    id: "followups.bulk_close",
    label: "Close follow-ups in bulk",
    description: "Close several follow-up records at once.",
    risk: "bulk",
  },
  {
    id: "staff.change_role",
    label: "Change a staff role",
    description: "Change which role a staff member holds in this clinic.",
    risk: "privileged",
  },
];

function capabilities(
  overrides: Partial<AssistantCapabilities> = {},
): AssistantCapabilities {
  return {
    toolNames: ["query_resource"],
    items: ITEMS,
    clinicAnalytics: false,
    operational: true,
    financial: "not_applicable",
    allowedReportIds: [],
    resources: [],
    actions: [],
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof CapabilityPanel>[0]> = {}) {
  return render(
    <CapabilityPanel
      items={ITEMS}
      onClose={() => {}}
      titleId="capability-title"
      {...props}
    />,
  );
}

describe("P7-01 · the panel renders every authorized action", () => {
  it("shows each action's label, description and risk class", () => {
    renderPanel({ actions: ACTIONS });

    expect(screen.getByText("Changes it can make")).toBeVisible();
    // The honesty line: an action listed here is not a grant, it is a request
    // the user still has to confirm.
    expect(
      screen.getByText("Nothing is saved until you confirm it on screen."),
    ).toBeVisible();

    for (const action of ACTIONS) {
      expect(screen.getByText(action.label), action.id).toBeVisible();
      expect(screen.getByText(action.description), action.id).toBeVisible();
    }

    for (const risk of [
      "Routine",
      "Sensitive",
      "Removes data",
      "Affects many records",
      "Needs your password",
    ]) {
      expect(screen.getByText(risk), risk).toBeVisible();
    }
  });

  it("distinguishes a privileged action from a routine one", () => {
    // A privileged change costs a re-authentication; if it rendered identically
    // to booking an appointment the panel would be misreporting the thing it
    // exists to report.
    renderPanel({ actions: ACTIONS });

    const privileged = screen.getByText("Change a staff role").closest("li")!;
    const routine = screen.getByText("Book an appointment").closest("li")!;

    expect(within(privileged).getByText("Needs your password")).toBeVisible();
    expect(within(routine).getByText("Routine")).toBeVisible();
    expect(privileged.className).not.toBe(routine.className);
    expect(privileged.className).toMatch(/red/);
    expect(routine.className).not.toMatch(/red/);
  });

  it("shows no actions section for a role the executor authorizes none for", () => {
    // A caller whose mount or entitlements yield no authorized action gets an
    // empty `actions` list, and the panel must stay silent rather than render
    // an empty heading. (Since final review B-2 that is no longer the doctor
    // or assistant case — both now resolve a real write surface; see
    // `tests/unit/ai/phase7-capability-surface.test.ts`. It remains the case
    // for a clinic without the AI write features, which is why the render
    // contract is still asserted here.)
    renderPanel({ actions: [] });
    expect(screen.queryByText("Changes it can make")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs your password")).not.toBeInTheDocument();
  });

  it("lists the readable record kinds alongside the question types", () => {
    renderPanel({ resources: RESOURCES, actions: ACTIONS });
    expect(screen.getByText("Records it can read")).toBeVisible();
    expect(screen.getByText("Patients")).toBeVisible();
    expect(screen.getByText("Appointments")).toBeVisible();
  });

  it("keeps the honest empty state when there is nothing at all to show", () => {
    render(
      <CapabilityPanel
        items={[]}
        resources={[]}
        actions={[]}
        onClose={() => {}}
        titleId="capability-title"
      />,
    );
    expect(
      screen.getByText(
        "No assistant capabilities are available for your account right now.",
      ),
    ).toBeVisible();
  });

  it("still renders the write surface when the user has no readable resources", () => {
    // The empty-state guard must key on all three sections, not on `items`
    // alone, or a user with writes and no reads sees "nothing is available".
    render(
      <CapabilityPanel
        items={[]}
        actions={ACTIONS}
        onClose={() => {}}
        titleId="capability-title"
      />,
    );
    expect(
      screen.queryByText(
        "No assistant capabilities are available for your account right now.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Change a staff role")).toBeVisible();
  });
});

describe("P7-01 · the chat's own call site passes the write surface through", () => {
  it("renders the resolved actions when the panel is opened from the toggle", () => {
    // The defect was here, not in the resolver: the call site passed `items`
    // only, so a correctly-resolved `actions` array was discarded on every page
    // load. Driving the real toggle is what makes that regression fail.
    render(
      <AssistantChat
        initialConversationId={CONVERSATION}
        initialMessages={[] as never}
        remaining={25}
        role="admin"
        capabilities={capabilities({
          toolNames: ["query_resource", "execute_action"],
          resources: RESOURCES,
          actions: ACTIONS,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "What can I ask?" }));

    expect(screen.getByText("Changes it can make")).toBeVisible();
    expect(screen.getByText("Change a staff role")).toBeVisible();
    expect(screen.getByText("Needs your password")).toBeVisible();
    expect(screen.getByText("Records it can read")).toBeVisible();
    expect(screen.getByText("Patients")).toBeVisible();
  });

  it("says nothing about writes for a role with no authorized actions", () => {
    render(
      <AssistantChat
        initialConversationId={CONVERSATION}
        initialMessages={[] as never}
        remaining={25}
        role="doctor"
        capabilities={capabilities({ resources: RESOURCES })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "What can I ask?" }));

    expect(screen.getByText("Records it can read")).toBeVisible();
    expect(screen.queryByText("Changes it can make")).not.toBeInTheDocument();
  });
});
