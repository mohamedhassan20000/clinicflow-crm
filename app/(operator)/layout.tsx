import { getTranslations } from "next-intl/server";
import { requirePlatformAdmin } from "@/lib/rbac";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { OPERATOR_SHELL_NAVIGATION } from "@/lib/dashboard-navigation";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { resolveLocale, resolveTheme } from "@/lib/preferences/server";

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  const operatorTranslations = getTranslations("operator");
  const [theme, locale, languageT] = await Promise.all([
    resolveTheme(),
    resolveLocale(),
    getTranslations("language"),
  ]);
  const t = await operatorTranslations;

  // The reserved operator-header slot (POST_PRE_P2_MANUAL_POLISH.md §6.A) is filled here, and the
  // placeholder-free rule ends: this control actually switches the language. Scope "account" writes
  // the platform admin's OWN `user_ui_preferences` row, so it governs the operator dashboard only
  // and can never reach a clinic or a clinic user.
  const languageSwitcher = (
    <LanguageSwitcher
      locale={locale}
      scope="account"
      className="h-8 w-auto gap-2 border-none bg-transparent px-2 text-sm shadow-none hover:bg-accent focus-visible:ring-1"
      aria-label={languageT("selectLabel")}
      labels={{
        selectLabel: languageT("selectLabel"),
        updated: languageT("updated"),
        updateFailed: languageT("updateFailed"),
      }}
    />
  );

  return (
    <DashboardShell
      navItems={OPERATOR_SHELL_NAVIGATION}
      user={{ fullName: admin.email, email: admin.email, roleLabel: t("platformAdmin") }}
      theme={theme}
      surface="operator"
      brandLabel={t("clinicflowOperator")}
      headerSlot={languageSwitcher}
      contentClassName="mx-auto w-full max-w-7xl space-y-8 px-5 py-8 lg:px-10"
    >
      {children}
    </DashboardShell>
  );
}
