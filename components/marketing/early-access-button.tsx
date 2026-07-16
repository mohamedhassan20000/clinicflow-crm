"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollToSectionButton } from "@/components/marketing/scroll-to-section-button";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const EarlyAccessDialog = dynamic(
  () => import("@/components/marketing/early-access-dialog").then((module) => module.EarlyAccessDialog),
  { ssr: false },
);

export function EarlyAccessButton({
  registrationMode,
  className,
  label,
  openLabel,
  scrollTargetId,
}: {
  registrationMode: string;
  className?: string;
  /** Overridden by the hero, which uses its own stronger call to action. */
  label?: string;
  openLabel?: string;
  scrollTargetId?: string;
}) {
  const t = useTranslations("marketing.earlyAccess");
  const [dialogOpen, setDialogOpen] = useState(false);

  const requestLabel = label ?? t("button");
  const createLabel = openLabel ?? t("openButton");

  if (registrationMode === "open") {
    return (
      <Button asChild className={cn("min-h-11", className)}>
        <Link href="/signup">
          {createLabel}
          <ArrowUpRight className="size-4 rtl:-scale-x-100" />
        </Link>
      </Button>
    );
  }

  if (scrollTargetId) {
    return (
      <ScrollToSectionButton targetId={scrollTargetId} className={cn("min-h-11", className)}>
        {requestLabel}
        <ArrowUpRight className="size-4 rtl:-scale-x-100" />
      </ScrollToSectionButton>
    );
  }

  return (
    <>
      <Button
        className={cn("min-h-11", className)}
        aria-haspopup="dialog"
        aria-expanded={dialogOpen}
        onClick={() => setDialogOpen(true)}
      >
        {requestLabel}
        <ArrowUpRight className="size-4 rtl:-scale-x-100" />
      </Button>
      {dialogOpen ? (
        <EarlyAccessDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      ) : null}
    </>
  );
}
