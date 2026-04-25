"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Building2, Filter, Search, Stethoscope, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  departments: { id: string; name: string; color: string }[];
  doctors: { id: string; full_name: string }[];
  activeDept: string | null;
  activeDoctor: string | null;
  activePatientQuery: string;
}

export function RevenueFilters({
  departments,
  doctors,
  activeDept,
  activeDoctor,
  activePatientQuery,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [patientQ, setPatientQ] = useState(activePatientQuery);

  // Keep the search input synced when the URL changes from elsewhere
  // (e.g. clearing all filters).
  useEffect(() => {
    queueMicrotask(() => setPatientQ(activePatientQuery));
  }, [activePatientQuery]);

  function set(key: "dept" | "doctor" | "q", value: string | null) {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (!value) next.delete(key);
    else next.set(key, value);
    startTransition(() => router.push(`/revenue?${next.toString()}`));
  }

  function clearAll() {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("dept");
    next.delete("doctor");
    next.delete("q");
    startTransition(() => router.push(`/revenue?${next.toString()}`));
  }

  const activeCount =
    Number(!!activeDept) +
    Number(!!activeDoctor) +
    Number(activePatientQuery.trim().length > 0);

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        Filter
      </span>

      <Select
        value={activeDept ?? ""}
        onValueChange={(v) => set("dept", v || null)}
      >
        <SelectTrigger
          className={cn(
            "h-8 w-[180px] gap-1.5 px-2 text-xs",
            activeDept &&
              "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          <Building2 className="h-3.5 w-3.5" />
          <SelectValue placeholder="All departments" />
        </SelectTrigger>
        <SelectContent>
          {departments.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: d.color }}
                />
                {d.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={activeDoctor ?? ""}
        onValueChange={(v) => set("doctor", v || null)}
      >
        <SelectTrigger
          className={cn(
            "h-8 w-[180px] gap-1.5 px-2 text-xs",
            activeDoctor &&
              "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          <Stethoscope className="h-3.5 w-3.5" />
          <SelectValue placeholder="All doctors" />
        </SelectTrigger>
        <SelectContent>
          {doctors.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              Dr. {d.full_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          set("q", patientQ.trim() || null);
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={patientQ}
          onChange={(e) => setPatientQ(e.target.value)}
          onBlur={() => {
            if (patientQ.trim() !== activePatientQuery)
              set("q", patientQ.trim() || null);
          }}
          placeholder="Patient name, file # or national ID…"
          className="h-8 w-[240px] pl-7 text-xs"
        />
      </form>

      {activeCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={clearAll}
        >
          <X className="h-3.5 w-3.5" />
          Clear filters
        </Button>
      )}
    </div>
  );
}
