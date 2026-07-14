"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Filter } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "next-intl";

const OUTCOMES = [
  { value: "all", labelKey: "outcomeAll" },
  { value: "all_fine", labelKey: "outcomeAllFine" },
  { value: "has_problem", labelKey: "outcomeHasProblem" },
  { value: "no_response", labelKey: "outcomeNoResponse" },
];

export function FollowupsOutcomeFilter({ value }: { value: string }) {
  const t = useTranslations("reports");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function update(nextValue: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (nextValue === "all") params.delete("outcome");
    else params.set("outcome", nextValue);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t("outcome")}</div>
        <Select value={value || "all"} onValueChange={update}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOMES.map((outcome) => (
              <SelectItem key={outcome.value} value={outcome.value}>
                {t(outcome.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
