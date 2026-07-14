import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import actionErrorsEn from "@/messages/action-errors/en.json";
import actionErrorsAr from "@/messages/action-errors/ar.json";

const cases = [
  {
    file: "actions/auth.ts",
    key: "auth.invalidEmailOrPassword",
    en: "Invalid email or password.",
    ar: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  },
  {
    file: "actions/auth.ts",
    key: "auth.tooManySignInAttemptsPleaseTryAgainLater",
    en: "Too many sign-in attempts. Please try again later.",
    ar: "عدد محاولات تسجيل الدخول كبير جدًا. يُرجى المحاولة مرة أخرى لاحقًا.",
  },
  {
    file: "actions/early-access.ts",
    key: "early-access.invitationCouldNotBeIssued",
    en: "Invitation could not be issued.",
    ar: "تعذر إصدار الدعوة.",
  },
  {
    file: "actions/appointments.ts",
    key: "appointments.chooseAFutureDateAndTimeForTheAppointment",
    en: "Choose a future date and time for the appointment.",
    ar: "اختر تاريخًا ووقتًا مستقبليين للموعد.",
  },
  {
    file: "actions/settings.ts",
    key: "settings.onlyAdminsCanManageAdminUsers",
    en: "Only admins can manage admin users.",
    ar: "يمكن للمسؤولين فقط إدارة حسابات المسؤولين.",
  },
  {
    file: "actions/patient-avatar.ts",
    key: "patient-avatar.failedToUploadAvatar",
    en: "Failed to upload avatar.",
    ar: "تعذر رفع صورة المريض.",
  },
  {
    file: "actions/page-permissions.ts",
    key: "page-permissions.clinicScopeMismatch",
    en: "Clinic scope mismatch.",
    ar: "لا يطابق الطلب نطاق العيادة المسموح به.",
  },
] as const;

function translate(locale: "en" | "ar", key: string) {
  const messages = locale === "en" ? actionErrorsEn : actionErrorsAr;
  const t = createTranslator({ locale, messages: { actionErrors: messages } });
  return t(`actionErrors.${key}` as never);
}

describe("P2 Server Action failure localization", () => {
  it.each(cases)("wires $key to readable English and Arabic alert copy", ({ file, key, en, ar }) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain(`actionError("${key}")`);
    expect(translate("en", key)).toBe(en);

    const arabic = translate("ar", key);
    render(<div role="alert">{arabic}</div>);
    expect(screen.getByRole("alert")).toHaveTextContent(ar);
    expect(arabic).not.toContain(key);
    expect(arabic).toMatch(/[\u0600-\u06ff]/);
  });
});
