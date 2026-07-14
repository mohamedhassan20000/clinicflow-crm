"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

type PublicTheme = "light" | "dark";

const PublicThemeContext = createContext<{
  theme: PublicTheme;
  toggleTheme: () => void;
} | null>(null);

export function usePublicTheme() {
  const context = useContext(PublicThemeContext);
  if (!context) throw new Error("usePublicTheme must be used inside PublicThemeShell.");
  return context;
}

export function PublicThemeShell({ className, children, ...props }: React.ComponentProps<"main">) {
  const [theme, setTheme] = useState<PublicTheme>("light");
  const value = useMemo(
    () => ({
      theme,
      toggleTheme: () => setTheme((current) => current === "light" ? "dark" : "light"),
    }),
    [theme],
  );

  return (
    <PublicThemeContext.Provider value={value}>
      <main
        {...props}
        data-public-theme={theme}
        className={cn(theme, "forced-public-scope marketing-page", className)}
      >
        {children}
      </main>
    </PublicThemeContext.Provider>
  );
}

export function PublicThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("marketing");
  const { theme, toggleTheme } = usePublicTheme();
  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={t("switchMarketingTheme", { theme: t(`theme.${nextTheme}`) })}
      title={t("switchTheme", { theme: t(`theme.${nextTheme}`) })}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--m-line-strong)] bg-[var(--m-panel)] text-[var(--m-ink)] transition-colors hover:bg-[var(--m-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--m-paper)]",
        className,
      )}
    >
      {theme === "light" ? <Moon className="size-4.5" aria-hidden="true" /> : <Sun className="size-4.5" aria-hidden="true" />}
    </button>
  );
}
