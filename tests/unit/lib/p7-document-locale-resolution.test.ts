import { beforeEach, describe, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({
  resolveLocale: vi.fn(),
}));

vi.mock("@/lib/preferences/server", () => ({
  resolveLocale: preferences.resolveLocale,
}));

import { createI18nRequestConfig } from "@/i18n/request";

describe("P7 document locale resolution", () => {
  beforeEach(() => {
    preferences.resolveLocale.mockReset();
    preferences.resolveLocale.mockResolvedValue("en");
  });

  it("honors an explicit Arabic document locale independently of the English UI locale", async () => {
    const config = await createI18nRequestConfig({
      locale: "ar",
      requestLocale: Promise.resolve(undefined),
    });
    const messages = config.messages as {
      documentPlatform: { revenue: { title: string; labels: { documentNumber: string } } };
    };

    expect(config.locale).toBe("ar");
    expect(messages.documentPlatform.revenue.title).toBe("تقرير الإيرادات");
    expect(messages.documentPlatform.revenue.labels.documentNumber).toBe("رقم التقرير");
    expect(preferences.resolveLocale).not.toHaveBeenCalled();
  });

  it("continues resolving the application locale when no explicit locale is supplied", async () => {
    const config = await createI18nRequestConfig({
      requestLocale: Promise.resolve(undefined),
    });

    expect(config.locale).toBe("en");
    expect(preferences.resolveLocale).toHaveBeenCalledOnce();
  });
});
