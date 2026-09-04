"use client";

import { useMemo } from "react";
import {
  Database,
  HeartPulse,
  ListChecks,
  PenLine,
  ShieldAlert,
  Sparkles,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AssistantCapabilities, AssistantCapabilityItem } from "@/lib/ai/capabilities";
import type { AssistantToolGroup } from "@/lib/ai/tool-presentation";
import type { ActionRiskClass } from "@/lib/ai/actions/types";

/**
 * The capability panel (P4.7B, completed in Phase 7).
 *
 * Shows, grouped and localized, exactly what the current user is authorized to
 * ask the assistant to do. Everything it renders is server-resolved by
 * `resolveAssistantCapabilities` — the authorized union across the task classes
 * supported for the user's role. An individual turn mounts only the subset
 * needed for that task; the union and every subset come from the same registry
 * resolution. This component makes no authorization decision and holds no
 * fallback list. When there is nothing to show it says so honestly rather than
 * inventing a generic list.
 *
 * **Three sections, because there are three kinds of claim.** `items` are the
 * question types the assistant answers. `resources` are the record kinds the
 * generic read tools may reach. `actions` are the writes — and those are the
 * ones the panel exists for after five phases of write work: a user opening
 * this panel is deciding what they are authorizing, and a surface that lists
 * every read while staying silent about the appointments the assistant can
 * create, the documents it can issue and the roles it can change under-reports
 * in the more dangerous direction (P7-01). Each action carries its registered
 * risk class, in the same vocabulary the confirmation card uses, and privileged
 * changes are marked distinctly. Nothing here is a grant: every action still
 * requires an on-screen confirmation, and privileged ones a re-authentication,
 * before anything is written.
 *
 * `group`, `description`, `label` and `risk` come straight from the server; only
 * the section headings, the risk words and the panel chrome are translated
 * client-side, because those are fixed UI labels rather than per-user data.
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

/**
 * The risk vocabulary, in the order a user should read it as escalating. Kept as
 * an exhaustive `Record` over `ActionRiskClass` so adding a class to the action
 * registry fails the build here rather than rendering an unlabelled badge.
 */
const RISK_META: Record<
  ActionRiskClass,
  { labelKey: string; className: string }
> = {
  normal: {
    labelKey: "capabilityRiskNormal",
    className: "border-border/70 bg-muted text-muted-foreground",
  },
  sensitive: {
    labelKey: "capabilityRiskSensitive",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  },
  bulk: {
    labelKey: "capabilityRiskBulk",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  },
  destructive: {
    labelKey: "capabilityRiskDestructive",
    className: "border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-200",
  },
  privileged: {
    labelKey: "capabilityRiskPrivileged",
    className: "border-red-500/50 bg-red-500/15 font-semibold text-red-900 dark:text-red-200",
  },
};

export function CapabilityPanel({
  items,
  resources = [],
  actions = [],
  onClose,
  titleId,
}: {
  items: readonly AssistantCapabilityItem[];
  resources?: AssistantCapabilities["resources"];
  actions?: AssistantCapabilities["actions"];
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

      <div
        className="max-h-64 overflow-y-auto px-4 pb-3 pt-1 sm:px-5"
        tabIndex={0}
        role="region"
        aria-label={t("capabilitiesTitle")}
      >
        {grouped.length === 0 && resources.length === 0 && actions.length === 0 ? (
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

            {resources.length > 0 ? (
              <div>
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Database className="size-3.5" aria-hidden="true" />
                  {t("capabilityResourcesTitle")}
                </h3>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {resources.map((resource) => (
                    <li
                      key={resource.id}
                      title={resource.description}
                      className="rounded-lg border border-border/60 bg-card px-2 py-1 text-[11px] leading-4 text-foreground/80"
                    >
                      {resource.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {actions.length > 0 ? (
              <div>
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <PenLine className="size-3.5" aria-hidden="true" />
                  {t("capabilityActionsTitle")}
                </h3>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t("capabilityActionsDescription")}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {actions.map((action) => {
                    const risk = RISK_META[action.risk];
                    return (
                      <li
                        key={action.id}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-xs leading-5",
                          action.risk === "privileged"
                            ? "border-red-500/40 bg-red-500/8 text-foreground"
                            : "border-border/60 bg-card text-foreground/80",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">
                            {action.label}
                          </span>
                          <span
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 text-[10px] uppercase leading-4 tracking-wide",
                              risk.className,
                            )}
                          >
                            {action.risk === "privileged" ? (
                              <ShieldAlert
                                className="me-0.5 inline size-3 align-[-2px]"
                                aria-hidden="true"
                              />
                            ) : null}
                            {t(risk.labelKey)}
                          </span>
                        </div>
                        <p className="mt-0.5">{action.description}</p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
