import { LockKeyhole, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { StaffAssistantSurfaceAccess } from "@/lib/ai/surface";

export function AssistantAccessGate({
  access,
  compact = false,
}: {
  access: Exclude<StaffAssistantSurfaceAccess, { state: "available" }>;
  compact?: boolean;
}) {
  const t = useTranslations("assistant");
  const isUpgrade = access.state === "upgrade";
  const Icon = isUpgrade ? Sparkles : access.state === "cap_reached" ? LockKeyhole : TriangleAlert;
  const title = isUpgrade
    ? t("upgradeTitle")
    : access.state === "cap_reached"
      ? t("capTitle")
      : access.state === "subscription_inactive"
        ? t("subscriptionTitle")
        : t("unavailableTitle");
  const description = isUpgrade
    ? t("upgradeDescription")
    : access.state === "cap_reached"
      ? t("capDescription", { limit: access.limit })
      : access.state === "subscription_inactive"
        ? t("subscriptionDescription")
        : t("unavailableDescription");

  return (
    <div
      className={compact
        ? "flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center"
        : "mx-auto flex min-h-[28rem] max-w-2xl flex-col items-center justify-center rounded-3xl border border-border/70 bg-card px-8 py-14 text-center shadow-sm"}
    >
      <div className="mb-5 grid size-12 place-items-center rounded-2xl border border-primary/20 bg-primary/8 text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      <p className="mt-5 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {t("readOnlyPromise")}
      </p>
    </div>
  );
}
