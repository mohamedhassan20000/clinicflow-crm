"use client";

import { useMemo } from "react";
import {
  HeartPulse,
  ListChecks,
  Sparkles,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AssistantCapabilityItem,
} from "@/lib/ai/capabilities";
import type { AssistantToolGroup } from "@/lib/ai/tool-presentation";

/**
 * The capability panel (P4.7B).
 *
 * Shows, grouped and localized, exactly what the current user is authorized to
 * ask the assistant to do. It renders nothing but its `items` — the
 * server-resolved authorized union across task classes supported for the user's
 * role (`resolveAssistantCapabilities`). An individual turn mounts only the
 * subset needed for that task; the union and every subset come from the same
 * registry resolution. This component makes no authorization decision and
 * holds no fallback list. When `items` is empty it says so honestly rather than
 * inventing a generic list.
 *
 * `group` and `description` come straight from the server; only the group
 * headings and the panel chrome are translated client-side, because those are
 * fixed UI labels rather than per-user data.
 */

const GROUP_META: Record<
  AssistantToolGroup,
  { labelKey: string; icon: LucideIcon }
> = {
  clinical: { labelKey: "capabilityGroupClinical", icon: HeartPulse },
  operational: { labelKey: "capabilityGroupOperational", icon: ListChecks },
  financial: { labelKey: "capabilityGroupFinancial", icon: Wallet },
  guidance: { labelKey: "capabilityGroupGuidance", icon: Sparkles },
};

// Mirrors the server-side GROUP_ORDER in lib/ai/capabilities.ts; the items
// already arrive in this order, and this only decides the render order of the
// group buckets a Map iteration would otherwise leave to insertion order.
const GROUP_ORDER: readonly AssistantToolGroup[] = [
  "clinical",
  "operational",
  "financial",
  "guidance",
];

export function CapabilityPanel({
  items,
  onClose,
  titleId,
}: {
  items: readonly AssistantCapabilityItem[];
  onClose: () => void;
  titleId: string;
}) {
  const t = useTranslations("assistant");

  const grouped = useMemo(() => {
    const byGroup = new Map<AssistantToolGroup, AssistantCapabilityItem[]>();
    for (const item of items) {
      const bucket = byGroup.get(item.group);
      if (bucket) bucket.push(item);
      else byGroup.set(item.group, [item]);
    }
    return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
      group,
      items: byGroup.get(group)!,
    }));
  }, [items]);

  return (
    <section
      aria-labelledby={titleId}
      className="border-b border-border/60 bg-muted/20"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3 sm:px-5">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
          >
            <ListChecks className="size-4 text-primary" aria-hidden="true" />
            {t("capabilitiesTitle")}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t("capabilitiesDescription")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={onClose}
          aria-label={t("capabilitiesClose")}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="max-h-64 overflow-y-auto px-4 pb-3 pt-1 sm:px-5">
        {grouped.length === 0 ? (
          <p className="rounded-xl border border-border/70 bg-card px-3 py-2 text-xs text-muted-foreground">
            {t("capabilitiesEmpty")}
          </p>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ group, items: groupItems }) => {
              const meta = GROUP_META[group];
              const Icon = meta.icon;
              return (
                <div key={group}>
                  <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden="true" />
                    {t(meta.labelKey)}
                  </h3>
                  <ul className="mt-1.5 space-y-1.5">
                    {groupItems.map((item) => (
                      <li
                        key={item.name}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-xs leading-5",
                          group === "financial"
                            ? "border-amber-500/30 bg-amber-500/8 text-amber-900 dark:text-amber-200"
                            : "border-border/60 bg-card text-foreground/80",
                        )}
                      >
                        {item.description}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
