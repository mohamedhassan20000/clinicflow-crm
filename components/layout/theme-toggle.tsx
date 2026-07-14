"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setTheme } from "@/actions/theme";
import { useTranslations } from "next-intl";

interface ThemeToggleProps {
  currentTheme: "light" | "dark";
}

export function ThemeToggle({ currentTheme }: ThemeToggleProps) {
  const t = useTranslations("layout");
  const [, startTransition] = useTransition();
  const router = useRouter();
  const isDark = currentTheme === "dark";

  function toggle() {
    const next = isDark ? "light" : "dark";

    // Instant DOM update — no flash
    if (next === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    // Persist via server action (cookie)
    startTransition(async () => {
      await setTheme(next);
      router.refresh();
    });
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={toggle}
      aria-label={isDark ? t("switchToLightMode") : t("switchToDarkMode")}
      title={isDark ? t("lightMode") : t("darkMode")}
    >
      {isDark ? (
        <Sun className="h-3.5 w-3.5" />
      ) : (
        <Moon className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
