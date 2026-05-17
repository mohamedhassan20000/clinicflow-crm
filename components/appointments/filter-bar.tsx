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

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

const ALL_STATUSES_VALUE = "__all__";

const STATUS_OPTIONS: { value: AppointmentStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "arrived", label: "Arrived" },
  { value: "in_session", label: "In session" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No-show" },
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
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const current = params.get("status");
  const active = STATUS_OPTIONS.some((option) => option.value === current);
  const label =
    STATUS_OPTIONS.find((option) => option.value === current)?.label ?? null;

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
          Status
          {active && label && (
            <span className="max-w-[120px] truncate font-semibold">
              : {label}
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
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES_VALUE}>All statuses</SelectItem>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
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
                Clear
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
