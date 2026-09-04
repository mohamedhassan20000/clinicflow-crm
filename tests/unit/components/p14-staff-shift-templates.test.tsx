import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import type { ClinicLocale } from "@/lib/datetime";

const localeState = vi.hoisted(() => ({ current: "en" as "en" | "ar" }));
const mocks = vi.hoisted(() => ({ upsertStaffShiftTemplates: vi.fn() }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => localeState.current,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: localeState.current,
        messages: localeState.current === "en" ? en : ar,
        namespace: namespace as never,
      }),
    useFormatter: () => actual.createFormatter({ locale: localeState.current }),
  };
});

vi.mock("@/actions/settings", () => ({
  upsertStaffShiftTemplates: mocks.upsertStaffShiftTemplates,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ClinicSettingsProvider } from "@/contexts/clinic-settings-context";
import { StaffShiftTemplatesForm } from "@/components/settings/staff-shift-templates-form";

// Morning and Evening deliberately overlap. They are staff shifts, not clinic
// opening intervals, so the card must accept them without a validation error.
const OVERLAPPING_TEMPLATES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Morning shift",
    start_time: "09:00",
    end_time: "17:00",
    is_enabled: true,
    sort_order: 0,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Evening shift",
    start_time: "15:00",
    end_time: "22:00",
    is_enabled: true,
    sort_order: 1,
  },
];

function locale(overrides: Partial<ClinicLocale> = {}): ClinicLocale {
  return {
    timeZone: "Africa/Cairo",
    locale: localeState.current,
    weekStart: 6,
    timeFormat: "24h",
    digits: "latin",
    currency: "EGP",
    country: "EG",
    ...overrides,
  };
}

function renderCard(timeFormat: "12h" | "24h" = "24h") {
  return render(
    <ClinicSettingsProvider timeFormat={timeFormat} locale={locale({ timeFormat })}>
      <StaffShiftTemplatesForm defaultValues={OVERLAPPING_TEMPLATES} />
    </ClinicSettingsProvider>,
  );
}

describe("P14 · staff shift templates card", () => {
  beforeEach(() => {
    localeState.current = "en";
    vi.clearAllMocks();
    mocks.upsertStaffShiftTemplates.mockResolvedValue({ success: true });
  });

  it("renders the card as a concept separate from clinic working hours", () => {
    renderCard();
    expect(screen.getByText(en.settings.staffShiftTemplates)).toBeInTheDocument();
    expect(screen.getByText(en.settings.staffShiftTemplatesDescription)).toBeInTheDocument();
    // No "Shift 1 / Shift 2" numbering: templates carry real names.
    expect(screen.getByDisplayValue("Morning shift")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Evening shift")).toBeInTheDocument();
  });

  it("shows no validation error for overlapping templates", async () => {
    const user = userEvent.setup();
    renderCard();
    expect(screen.queryByText(en.settings.staffShiftTemplatesLimit, { exact: false })).toBeNull();
    await user.click(screen.getByRole("button", { name: en.settings.saveShiftTemplates }));
    expect(mocks.upsertStaffShiftTemplates).toHaveBeenCalled();
    const payload = JSON.parse(
      (mocks.upsertStaffShiftTemplates.mock.calls[0]![1] as FormData).get("templates") as string,
    );
    expect(payload).toMatchObject([
      { name: "Morning shift", start_time: "09:00", end_time: "17:00", sort_order: 0 },
      { name: "Evening shift", start_time: "15:00", end_time: "22:00", sort_order: 1 },
    ]);
  });

  it("follows the clinic 24-hour display preference", () => {
    renderCard("24h");
    expect(screen.getByRole("button", { name: /09:00/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /22:00/ })).toBeInTheDocument();
  });

  it("follows the clinic 12-hour display preference", () => {
    renderCard("12h");
    expect(screen.getByRole("button", { name: /9:00\s*AM/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /10:00\s*PM/i })).toBeInTheDocument();
  });

  it("renders Arabic labels and Arabic 12-hour meridiem", () => {
    localeState.current = "ar";
    render(
      <ClinicSettingsProvider timeFormat="12h" locale={locale({ locale: "ar", timeFormat: "12h" })}>
        <StaffShiftTemplatesForm defaultValues={OVERLAPPING_TEMPLATES} />
      </ClinicSettingsProvider>,
    );
    expect(screen.getByText(ar.settings.staffShiftTemplates)).toBeInTheDocument();
    expect(ar.settings.staffShiftTemplates).toBe("قوالب شفتات الموظفين");
    expect(screen.getAllByRole("button", { name: /صباحًا/ }).length).toBeGreaterThan(0);
    // 15:00 and 22:00 both render as afternoon/evening in Arabic 12-hour form.
    expect(screen.getAllByRole("button", { name: /مساءً/ })).toHaveLength(3);
  });

  it("uses logical properties so the layout mirrors under RTL", () => {
    const { container } = renderCard();
    const inset = container.querySelectorAll('[class*="ps-"], [class*="pe-"], [class*="ms-"], [class*="me-"]');
    expect(inset.length).toBeGreaterThan(0);
    expect(container.querySelector('[class*="pl-"], [class*="pr-"], [class*="ml-"], [class*="mr-"]')).toBeNull();
  });

  it("flags more enabled templates than the supported maximum", async () => {
    const user = userEvent.setup();
    renderCard();
    // A fourth template is added disabled; enabling it crosses the cap.
    await user.click(screen.getByRole("button", { name: en.settings.addShiftTemplate }));
    await user.click(screen.getByRole("button", { name: en.settings.addShiftTemplate }));
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles).toHaveLength(4);
    await user.click(toggles[3]!);

    expect(
      screen.getByText(en.settings.staffShiftTemplatesLimit.replace("{count}", "3")),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.settings.saveShiftTemplates })).toBeDisabled();
  });
});
