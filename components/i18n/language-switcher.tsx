"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { toast } from "sonner";
import { setMarketingLocale, updateOwnLocale } from "@/actions/locale";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The one real language control, mounted on all three P2A surfaces (§4.1, §6.A).
 *
 * `scope` is what makes the three mounts independent, and it is passed explicitly rather than
 * inferred:
 *   - "account"   — writes `user_ui_preferences.locale` for the signed-in account. Used by the
 *                   clinic user's Preferences page AND the Platform Admin's operator header. The
 *                   Platform Admin's choice governs the operator dashboard only; it can never reach
 *                   a clinic, because the row is keyed on their own auth user id.
 *   - "marketing" — writes the anonymous cookie for the public site only. It touches no account.
 *
 * There is no clinic language and no clinic-wide setting here, by construction: this control has no
 * way to address anything but the caller's own row or this browser's cookie.
 */
export function LanguageSwitcher({
  locale,
  scope,
  labels,
  className,
  "aria-label": ariaLabel,
}: {
  locale: Locale;
  scope: "account" | "marketing";
  /** Pre-resolved so this renders inside the marketing tree, which has no intl provider today. */
  labels: { selectLabel: string; updated: string; updateFailed: string };
  className?: string;
  "aria-label"?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function change(next: string) {
    if (next === locale) return;
    const target = next as Locale;

    startTransition(async () => {
      try {
        if (scope === "account") {
          await updateOwnLocale(target);
        } else {
          await setMarketingLocale(target);
        }
        // Re-render the tree: the root layout re-resolves `lang`/`dir` and the font stack from the
        // new value. No sign-out and no full reload.
        router.refresh();
        toast.success(labels.updated);
      } catch {
        toast.error(labels.updateFailed);
      }
    });
  }

  return (
    <Select value={locale} onValueChange={change} disabled={isPending}>
      <SelectTrigger
        className={className}
        aria-label={ariaLabel ?? labels.selectLabel}
        data-testid={`language-switcher-${scope}`}
      >
        <Languages className="size-4 shrink-0 opacity-70" aria-hidden="true" />
        <SelectValue placeholder={labels.selectLabel} />
      </SelectTrigger>
      <SelectContent>
        {LOCALES.map((value) => (
          <SelectItem key={value} value={value}>
            {LOCALE_LABELS[value].native}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
