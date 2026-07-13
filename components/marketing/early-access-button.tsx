"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { marketingCopy as copy } from "@/lib/marketing-copy";

const EarlyAccessDialog = dynamic(
  () => import("@/components/marketing/early-access-dialog").then((module) => module.EarlyAccessDialog),
  { ssr: false },
);

export function EarlyAccessButton({
  registrationMode,
  className,
  label = copy.earlyAccess.button,
  openLabel = copy.earlyAccess.openButton,
}: {
  registrationMode: string;
  className?: string;
  label?: string;
  openLabel?: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (registrationMode === "open") {
    return (
      <Button asChild className={cn("min-h-11", className)}>
        <Link href="/signup">
          {openLabel}
          <ArrowUpRight className="size-4" />
        </Link>
      </Button>
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
        {label}
        <ArrowUpRight className="size-4" />
      </Button>
      {dialogOpen ? (
        <EarlyAccessDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      ) : null}
    </>
  );
}
