"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ClipboardList } from "lucide-react";
import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database";
import { useTranslations } from "next-intl";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

const ALL_STATUSES_VALUE = "__all__";

const STATUS_OPTIONS: { value: AppointmentStatus; labelKey: string }[] = [
  { value: "pending", labelKey: "statusPending" },
  { value: "confirmed", labelKey: "statusConfirmed" },
  { value: "arrived", labelKey: "statusArrived" },
  { value: "in_session", labelKey: "statusInSession" },
  { value: "completed", labelKey: "statusCompleted" },
  { value: "cancelled", labelKey: "statusCancelled" },
  { value: "no_show", labelKey: "statusNoShow" },
];

interface Props {
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  hideDoctorFilter?: boolean;
  hideDeptFilter?: boolean;
}

export function AppointmentsFilterBar({
  doctors,
  departments,
  hideDoctorFilter = false,
  hideDeptFilter = false,
}: Props) {
  return (
    <PatientScopeFilterBar
      basePath="/appointments"
      doctors={doctors}
      departments={departments}
      hideDoctorFilter={hideDoctorFilter}
      hideDeptFilter={hideDeptFilter}
      clearExtraParams={["status"]}
      actions={<StatusFilter />}
    />
  );
}

function StatusFilter() {
  const t = useTranslations("appointments");
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const current = params.get("status");
  const active = STATUS_OPTIONS.some((option) => option.value === current);
  const label =
    STATUS_OPTIONS.find((option) => option.value === current)?.labelKey ?? null;

  function apply(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === ALL_STATUSES_VALUE) next.delete("status");
    else next.set("status", value);
    startTransition(() => {
      router.push(`/appointments?${next.toString()}`);
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-7 max-w-full gap-1.5 px-2 text-xs font-medium",
            active
              ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground",
          )}
        >
          <ClipboardList className="h-3.5 w-3.5" />
          {t("status")}{active && label && (
            <span className="max-w-[120px] truncate font-semibold">
              : {t(label)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-2">
          <Select
            value={active ? current ?? ALL_STATUSES_VALUE : ALL_STATUSES_VALUE}
            onValueChange={apply}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={t("allStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES_VALUE}>{t("allStatuses")}</SelectItem>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {active && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => apply(ALL_STATUSES_VALUE)}
              >
                {t("clear")}</Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
