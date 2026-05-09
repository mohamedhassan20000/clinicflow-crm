"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { useState, useTransition } from "react";
import { Building2, Filter, Printer, Search, Stethoscope, X } from "lucide-react";
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
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  showScopeFilters?: boolean;
}

export function PatientsFilterBar({
  doctors,
  departments,
  showScopeFilters = true,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const activeDept = params.get("dept");
  const activeDoctor = params.get("doctor");
  const activeQuery = params.get("q") ?? "";

  function set(key: "dept" | "doctor" | "q", value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    startTransition(() => {
      router.push(`/patients?${next.toString()}`);
    });
  }

  function clearAll() {
    const next = new URLSearchParams(params.toString());
    next.delete("dept");
    next.delete("doctor");
    next.delete("q");
    next.delete("page");
    startTransition(() => {
      router.push(`/patients?${next.toString()}`);
    });
  }

  const dept = departments.find((d) => d.id === activeDept);
  const doc = doctors.find((d) => d.id === activeDoctor);
  const activeCount =
    Number(showScopeFilters && !!activeDept) +
    Number(showScopeFilters && !!activeDoctor) +
    Number(activeQuery.trim().length > 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        Filter
      </span>

      {showScopeFilters && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className={cn(
                "h-7 gap-1.5 px-2 text-xs",
                activeDept
                  ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground",
              )}
            >
              <Building2 className="h-3.5 w-3.5" />
              Department
              {dept && (
                <span className="max-w-[120px] truncate font-semibold">
                  : {dept.name}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-2">
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
                <div className="flex justify-end">
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
            </div>
          </PopoverContent>
        </Popover>
      )}

      {showScopeFilters && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className={cn(
                "h-7 gap-1.5 px-2 text-xs",
                activeDoctor
                  ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground",
              )}
            >
              <Stethoscope className="h-3.5 w-3.5" />
              Doctor
              {doc && (
                <span className="max-w-[120px] truncate font-semibold">
                  : Dr. {doc.full_name.split(" ")[0]}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-2">
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
                <div className="flex justify-end">
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
            </div>
          </PopoverContent>
        </Popover>
      )}

      <FilterChip
        icon={Search}
        label="Search"
        value={activeQuery}
        active={activeQuery.trim().length > 0}
      >
        <TextFilter
          value={activeQuery}
          placeholder="Name, phone, file #, national ID..."
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
          Clear all
        </Button>
      )}

      <span className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => window.print()}
        >
          <Printer className="h-3.5 w-3.5" />
          Print roster
        </Button>
      </span>
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
