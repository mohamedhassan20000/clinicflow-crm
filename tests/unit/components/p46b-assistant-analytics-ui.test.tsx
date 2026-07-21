import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AssistantCapabilities } from "@/lib/ai/capabilities";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
  setStaffAiPermission: vi.fn(),
  error: undefined as Error | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { messages?: unknown[] }) => ({
    messages: options.messages ?? [],
    sendMessage: mocks.sendMessage,
    status: "ready",
    error: mocks.error,
    stop: mocks.stop,
    clearError: mocks.clearError,
  }),
}));

vi.mock("@/actions/ai-permissions", () => ({
  setStaffAiPermission: mocks.setStaffAiPermission,
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";
import { CapabilityPanel } from "@/components/assistant/capability-panel";
import { AiFinancialPermissions } from "@/components/settings/ai-financial-permissions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.error = undefined;
});

const CONVERSATION = "00000000-0000-4000-8000-000000000010";

function capabilities(
  overrides: Partial<AssistantCapabilities> = {},
): AssistantCapabilities {
  return {
    toolNames: [],
    items: [],
    clinicAnalytics: false,
    operational: false,
    financial: "not_applicable",
    allowedReportIds: [],
    ...overrides,
  };
}

function renderChat(
  capability: AssistantCapabilities | null,
  messages: unknown[] = [],
) {
  return render(
    <AssistantChat
      initialConversationId={CONVERSATION}
      initialMessages={messages as never}
      remaining={25}
      role="admin"
      capabilities={capability}
    />,
  );
}

/** One completed tool call, in the shape the AI SDK produces. */
/**
 * A tool part in the `output-error` state — the shape the SDK produces when a
 * tool's execute() throws. Proven against the real transport in
 * `tests/unit/ai/p46-tool-error-transport.test.ts`; this file asserts what the
 * user then sees.
 */
function failedToolPart(name: string, errorText: string) {
  return {
    id: `msg-${name}`,
    role: "assistant",
    parts: [
      {
        type: `tool-${name}`,
        toolCallId: `call-${name}`,
        state: "output-error",
        input: {},
        errorText,
      },
    ],
  };
}

function toolPart(name: string, output: unknown) {
  return {
    id: `msg-${name}`,
    role: "assistant",
    parts: [
      {
        type: `tool-${name}`,
        toolCallId: `call-${name}`,
        state: "output-available",
        input: {},
        output,
      },
    ],
  };
}

describe("P4.6B — capability-driven affordances", () => {
  it("offers analytics and financial prompts to an admin with the full mount", () => {
    renderChat(
      capabilities({
        toolNames: [
          "get_clinic_summary",
          "get_appointment_stats",
          "list_appointments",
          "run_clinic_report",
        ],
        clinicAnalytics: true,
        operational: true,
        financial: "available",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Give me an overview of the clinic this month" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Summarize this month's revenue" })).toBeVisible();
  });

  it("never offers a financial prompt to a receptionist, whose mount has none", () => {
    renderChat(
      capabilities({
        toolNames: ["list_appointments", "count_new_patients", "list_pending_followups"],
        operational: true,
        financial: "not_applicable",
      }),
    );

    expect(screen.getByRole("button", { name: "List today's appointments" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Summarize this month's revenue" }),
    ).not.toBeInTheDocument();
    // No financial story is told to a role that can never be granted one.
    expect(screen.queryByText(/Financial insights are not/)).not.toBeInTheDocument();
  });

  it("sends a manager without the grant to their admin, not to a pricing page", () => {
    renderChat(
      capabilities({
        toolNames: ["get_clinic_summary", "list_appointments"],
        clinicAnalytics: true,
        operational: true,
        financial: "not_granted",
      }),
    );

    expect(
      screen.getByText(
        "Financial insights are not enabled for your account. A clinic admin can enable them in Settings → AI.",
      ),
    ).toBeVisible();
  });

  it("tells a manager on a plan without financial AI that it is a plan limit", () => {
    renderChat(
      capabilities({
        toolNames: ["get_clinic_summary"],
        clinicAnalytics: true,
        financial: "not_entitled",
      }),
    );

    expect(screen.getByText(/not part of this clinic's plan/)).toBeVisible();
  });

  it("falls back to the role defaults when no capabilities were resolved", () => {
    renderChat(null);
    expect(
      screen.getByRole("button", { name: "Find an authorized patient by name" }),
    ).toBeVisible();
  });
});

describe("P4.6B — result presentation", () => {
  it("labels a financial result as financial rather than as a plain figure", () => {
    renderChat(
      capabilities({ financial: "available" }),
      [toolPart("get_revenue_summary", { revenue: { total: 42000 } })],
    );

    expect(screen.getByText("Reviewing revenue summary")).toBeVisible();
    expect(screen.getByText("Financial")).toBeVisible();
  });

  it("does not mark an operational result as financial", () => {
    renderChat(capabilities(), [toolPart("list_appointments", { appointments: [] })]);

    expect(screen.getByText("Listing appointments")).toBeVisible();
    expect(screen.queryByText("Financial")).not.toBeInTheDocument();
  });

  it("says a capped list may be incomplete, independently of the model's summary", () => {
    renderChat(
      capabilities(),
      [toolPart("list_appointments", { truncated: true, row_cap: 50, appointments: [] })],
    );

    expect(
      screen.getByText("Only the first 50 rows were read, so this may not be everything."),
    ).toBeVisible();
  });

  /**
   * H1 (review #3), at the layer the user actually reads. A clinic with 100 O+,
   * 4 A+ and 3 B+ now sees one combined "Other" total of 7 covering 2 groups.
   * The copy must state both figures and must not describe, name, or size any
   * individual hidden group — there no longer is one in the payload.
   */
  it("discloses that small groups were combined, with both exact figures", () => {
    renderChat(
      capabilities({ clinicAnalytics: true }),
      [
        toolPart("get_patient_stats", {
          stats: {
            patients_total: 107,
            patients_total_exact: true,
            suppression_floor: 5,
            suppressed_bucket_count: 2,
            suppressed_patient_count: 7,
            distribution_withheld: false,
            buckets_all_time: [
              {
                bucket: "O+",
                count: 100,
                display: "100",
                suppressed: false,
                suppression_reason: null,
              },
              {
                bucket: "Other",
                count: 7,
                display: "7",
                suppressed: true,
                suppression_reason: "aggregated",
                grouped_bucket_count: 2,
              },
            ],
          },
        }),
      ],
    );

    expect(
      screen.getByText(
        "2 groups were combined into a single “Other” total of 7 so that no group smaller than 5 can be identified. Which groups they are isn't shown.",
      ),
    ).toBeVisible();
    // The old vocabulary made claims about individual hidden groups. Neither
    // sentence may reappear: the payload no longer supports either.
    expect(screen.queryByText(/too small to report/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rounded to the nearest/)).not.toBeInTheDocument();
  });

  it("says a fully suppressed distribution cannot be shown at all", () => {
    renderChat(
      capabilities({ clinicAnalytics: true }),
      [
        toolPart("get_patient_stats", {
          stats: {
            patients_total: 205,
            patients_total_exact: true,
            suppression_floor: 5,
            suppressed_bucket_count: 2,
            suppressed_patient_count: 205,
            distribution_withheld: true,
            distribution_withheld_reason: "all_buckets_suppressed",
            buckets_all_time: [],
          },
        }),
      ],
    );

    expect(
      screen.getByText(
        "This grouping can't be shown for this clinic without identifying individuals, so no groups are reported.",
      ),
    ).toBeVisible();
  });

  it("announces a narrowed date range rather than answering a question nobody asked", () => {
    renderChat(
      capabilities(),
      [
        toolPart("count_new_patients", {
          range: { preset: "this_month", from: "2026-07-01", to: "2026-07-31", clamped: true },
          new_patients: 12,
        }),
      ],
    );

    expect(
      screen.getByText(
        "The requested range was too long, so 2026-07-01 to 2026-07-31 was used instead.",
      ),
    ).toBeVisible();
  });

  it("links to the real report so a quoted number can be verified", () => {
    renderChat(
      capabilities({ operational: true }),
      [
        toolPart("run_clinic_report", {
          report: "cancellations",
          link: "/reports/cancellations?preset=this_month",
          result: {},
        }),
      ],
    );

    expect(screen.getByRole("link", { name: /Open the full report/ })).toHaveAttribute(
      "href",
      "/reports/cancellations?preset=this_month",
    );
  });

  it("renders the Arabic receptionist help article as a citation with its working deep link", () => {
    renderChat(capabilities(), [
      toolPart("search_help", {
        results: [
          {
            article_id: "record-payment-and-invoice",
            title: "إصدار فاتورة الجلسة وتسجيل الدفع",
            section: "المواعيد",
            link: "/appointments",
            steps: ["افتح الموعد المكتمل."],
          },
        ],
        corpus_only: true,
      }),
    ]);

    expect(
      screen.getByText("Help article: إصدار فاتورة الجلسة وتسجيل الدفع"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open المواعيد" })).toHaveAttribute(
      "href",
      "/appointments",
    );
  });

  it("cites an unavailable help article without rendering a forbidden link", () => {
    renderChat(capabilities(), [
      toolPart("search_help", {
        results: [
          {
            article_id: "control-page-visibility",
            title: "Show or hide pages for a staff member",
            section: "Settings → Customize",
            unavailable_reason: "hidden_by_admin",
            steps: [],
          },
        ],
        corpus_only: true,
      }),
    ]);

    expect(
      screen.getByText("Help article: Show or hide pages for a staff member"),
    ).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("labels a navigation destination as a page, never as a full report", () => {
    renderChat(capabilities(), [
      toolPart("get_navigation_target", {
        status: "available",
        section: "Settings → Messaging",
        link: "/settings/messaging",
      }),
    ]);

    expect(
      screen.getByRole("link", { name: "Open Settings → Messaging" }),
    ).toHaveAttribute("href", "/settings/messaging");
    expect(screen.queryByText("Open the full report")).not.toBeInTheDocument();
  });

  it("asks the user to disambiguate instead of letting the model pick a namesake", () => {
    renderChat(
      capabilities(),
      [
        toolPart("search_authorized_patients", {
          confidence: "low",
          guidance: "Ask which patient.",
          patients: [{ id: "a" }, { id: "b" }],
        }),
      ],
    );

    expect(
      screen.getByText("More than one match — confirm which one you mean."),
    ).toBeVisible();
  });
});

describe("P4.7 — capability panel component and accessibility", () => {
  const items: AssistantCapabilities["items"] = [
    {
      name: "get_patient_summary",
      group: "clinical",
      description: "Summarize an authorized patient record.",
    },
    {
      name: "get_revenue_summary",
      group: "financial",
      description: "Report authorized revenue figures.",
    },
    {
      name: "search_help",
      group: "guidance",
      description: "شرح كيفية استخدام كلينيك فلو.",
    },
  ];

  it("opens from the labelled toggle, groups localized items, closes, and restores focus", () => {
    renderChat(capabilities({ items }));
    const toggle = screen.getByRole("button", { name: "What can I ask?" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "What you can ask" })).toBeVisible();
    expect(screen.getByText("Patient care")).toBeVisible();
    expect(screen.getByText("Finance")).toBeVisible();
    expect(screen.getByText("Help & guidance")).toBeVisible();
    expect(screen.getByText("شرح كيفية استخدام كلينيك فلو.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "What you can ask" })).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the honest empty state and keeps long lists scrollable", () => {
    const { rerender, container } = render(
      <CapabilityPanel items={[]} onClose={() => {}} titleId="capability-title" />,
    );
    expect(
      screen.getByText("No assistant capabilities are available for your account right now."),
    ).toBeVisible();

    rerender(
      <CapabilityPanel
        items={Array.from({ length: 30 }, (_, index) => ({
          name: `help-${index}`,
          group: "guidance" as const,
          description: `Help capability ${index + 1}`,
        }))}
        onClose={() => {}}
        titleId="capability-title"
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(30);
    expect(container.querySelector(".max-h-64.overflow-y-auto")).toHaveAttribute(
      "tabindex",
      "0",
    );
  });
});

describe("P4.6B — denial copy", () => {
  it("distinguishes a missing per-user grant from a missing plan feature", () => {
    mocks.error = new Error("permission_not_granted");
    renderChat(capabilities({ financial: "not_granted" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Financial insights are not enabled for your account. Ask a clinic admin to enable them for you.",
    );
  });

  it("still shows the plan-level message for feature_not_entitled", () => {
    mocks.error = new Error("feature_not_entitled");
    renderChat(capabilities());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The AI assistant is not enabled for this clinic.",
    );
  });
});

/**
 * P4.6 phase review H1, client half. A tool that denies mid-stream now reaches
 * the client as its reason code rather than a fixed sentence, so the same copy
 * a pre-stream denial gets must apply — and the mid-turn denial that
 * `run_clinic_report` returns as data must render as a caveat on the tool card
 * rather than disappearing into a loose model summary.
 */
describe("P4.6 H1 — a mid-turn denial is presented, not swallowed", () => {
  it("renders a returned permission denial as a notice on the tool card", () => {
    renderChat(capabilities({ financial: "not_granted" }), [
      toolPart("run_clinic_report", {
        permission_denied: true,
        reason: "permission_not_granted",
        report: "revenue",
      }),
    ]);

    expect(
      screen.getByText(
        "Financial insights are not enabled for your account. Ask a clinic admin to enable them for you.",
      ),
    ).toBeVisible();
  });

  it("renders a plan-level denial with plan-level copy", () => {
    renderChat(capabilities(), [
      toolPart("run_clinic_report", {
        permission_denied: true,
        reason: "feature_not_entitled",
        report: "revenue",
      }),
    ]);

    expect(
      screen.getByText("The AI assistant is not enabled for this clinic."),
    ).toBeVisible();
  });

  it("does not classify an unknown error code as anything specific", () => {
    mocks.error = new Error("some_unmapped_code");
    renderChat(capabilities());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The response could not be completed. Try again; no records were changed.",
    );
  });

  it("tells a manager the assistant is briefly unavailable, not that their plan is wrong", () => {
    renderChat(capabilities({ financial: "unavailable" }));

    expect(
      screen.getByText(/enabled for you, but the assistant cannot reach them/i),
    ).toBeVisible();
  });
});

describe("P4.6B — financial permission settings", () => {
  const MANAGER = {
    id: "22222222-2222-4222-8222-222222222222",
    fullName: "Layla Mansour",
    role: "manager" as const,
    granted: false,
    implicit: false,
  };
  const ADMIN = {
    id: "33333333-3333-4333-8333-333333333333",
    fullName: "Omar Khalid",
    role: "admin" as const,
    granted: true,
    implicit: true,
  };

  it("grants a manager the financial permission through the server action", async () => {
    mocks.setStaffAiPermission.mockResolvedValue({ success: true });
    render(<AiFinancialPermissions staff={[MANAGER]} entitled />);

    fireEvent.click(screen.getByRole("switch", { name: "Layla Mansour" }));

    expect(mocks.setStaffAiPermission).toHaveBeenCalledWith(
      MANAGER.id,
      "ai.financial_insights",
      true,
    );
  });

  it("shows admins as permanently on and refuses to pretend the toggle is real", () => {
    render(<AiFinancialPermissions staff={[ADMIN]} entitled />);

    const toggle = screen.getByRole("switch", { name: "Omar Khalid" });
    expect(toggle).toBeDisabled();
    expect(toggle).toBeChecked();
    expect(screen.getByText("Always on for admins")).toBeVisible();
  });

  it("offers no toggles at all when the plan has no financial AI", () => {
    render(<AiFinancialPermissions staff={[]} entitled={false} />);

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/not part of this clinic's plan/)).toBeVisible();
  });
});

/**
 * H2 (review #2). `useChat`'s `error` is never set for a tool that throws, so
 * the page-level banner never renders — this chip is the *only* place the user
 * can learn why. It previously showed "Could not complete" and nothing else,
 * discarding the reason code the route had emitted.
 */
describe("P4.6B — a tool that fails mid-stream explains itself", () => {
  it.each([
    ["page_hidden", "Your access to this section has been turned off, so the assistant can't read it. Ask a clinic admin to restore it."],
    ["subscription_inactive", "The clinic subscription is inactive, so the assistant is unavailable."],
    ["permission_not_granted", "Financial insights are not enabled for your account. Ask a clinic admin to enable them for you."],
    ["lookup_failed", "Your permissions couldn't be checked just now, so nothing was read. Try again in a moment."],
    ["role_forbidden", "That isn't available for your role."],
  ])("renders localized copy for %s", (code, copy) => {
    renderChat(capabilities({ clinicAnalytics: true }), [
      failedToolPart("get_clinic_summary", code),
    ]);

    expect(screen.getByText(copy)).toBeVisible();
  });

  it("falls back to the generic sentence for an unrecognized error string", () => {
    // An SDK-internal failure can produce arbitrary text. Rendering it would
    // put an untranslated internal message in front of the user.
    renderChat(capabilities({ clinicAnalytics: true }), [
      failedToolPart("get_clinic_summary", "TypeError: undefined is not a function"),
    ]);

    expect(
      screen.queryByText(/TypeError/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("The response could not be completed. Try again; no records were changed."),
    ).toBeVisible();
  });
});
