"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { useState, useTransition } from "react";
import { Building2, Filter, Search, Stethoscope, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  function set(key: "dept" | "doctor" | "q", value: string | null) {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (!value) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    startTransition(() => router.push(`/revenue?${next.toString()}`));
  }

  function clearAll() {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("dept");
    next.delete("doctor");
    next.delete("q");
    next.delete("page");
    startTransition(() => router.push(`/revenue?${next.toString()}`));
  }

  const dept = departments.find((d) => d.id === activeDept);
  const doctor = doctors.find((d) => d.id === activeDoctor);
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

      <FilterChip
        icon={Building2}
        label="Department"
        value={dept?.name}
        active={!!activeDept}
      >
        <Select
          value={activeDept ?? ""}
          onValueChange={(v) => set("dept", v || null)}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select department" />
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
        {activeDept && (
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => set("dept", null)}
            >
              Clear
            </Button>
          </div>
        )}
      </FilterChip>

      <FilterChip
        icon={Stethoscope}
        label="Doctor"
        value={doctor ? `Dr. ${doctor.full_name.split(" ")[0]}` : null}
        active={!!activeDoctor}
      >
        <Select
          value={activeDoctor ?? ""}
          onValueChange={(v) => set("doctor", v || null)}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select doctor" />
          </SelectTrigger>
          <SelectContent>
            {doctors.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                Dr. {d.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeDoctor && (
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => set("doctor", null)}
            >
              Clear
            </Button>
          </div>
        )}
      </FilterChip>

      <FilterChip
        icon={Search}
        label="Search"
        value={activePatientQuery}
        active={activePatientQuery.trim().length > 0}
      >
        <TextFilter
          value={activePatientQuery}
          placeholder="Patient name, file # or national ID..."
          onApply={(value) => set("q", value || null)}
          onClear={() => set("q", null)}
        />
      </FilterChip>

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

function FilterChip({
  icon: Icon,
  label,
  value,
  active,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs",
            active
              ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
          {value && (
            <span className="max-w-[120px] truncate font-semibold">
              : {value}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function TextFilter({
  value,
  placeholder,
  onApply,
  onClear,
}: {
  value: string;
  placeholder: string;
  onApply: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft.trim());
      }}
    >
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
      <div className="flex justify-end gap-2">
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
        <Button type="submit" size="sm" className="h-7 text-xs">
          Apply
        </Button>
      </div>
    </form>
  );
}
