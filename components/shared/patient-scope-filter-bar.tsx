"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Building2,
  Filter,
  Hash,
  IdCard,
  Phone,
  Stethoscope,
  User,
  X,
} from "lucide-react";
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
import { formatDoctorFirstName, formatDoctorName } from "@/lib/format-doctor";

export type PatientFilterKey =
  | "doctor"
  | "dept"
  | "file"
  | "nat"
  | "phone"
  | "name";

type ParamNames = Partial<Record<PatientFilterKey, string>>;

interface PatientScopeFilterBarProps {
  basePath: string;
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  hideDoctorFilter?: boolean;
  hideDeptFilter?: boolean;
  className?: string;
  paramNames?: ParamNames;
  fallbackParams?: Partial<Record<PatientFilterKey, string[]>>;
  resetParamsOnApply?: string[];
  clearExtraParams?: string[];
  actions?: React.ReactNode;
}

const FILTER_KEYS: PatientFilterKey[] = [
  "doctor",
  "dept",
  "file",
  "nat",
  "phone",
  "name",
];

const ICONS: Record<
  PatientFilterKey,
  React.ComponentType<{ className?: string }>
> = {
  doctor: Stethoscope,
  dept: Building2,
  file: Hash,
  nat: IdCard,
  phone: Phone,
  name: User,
};

const LABELS: Record<PatientFilterKey, string> = {
  doctor: "Doctor",
  dept: "Department",
  file: "File #",
  nat: "National ID",
  phone: "Phone",
  name: "Name",
};

const DEFAULT_PARAM_NAMES: Record<PatientFilterKey, string> = {
  doctor: "doctor",
  dept: "dept",
  file: "file",
  nat: "nat",
  phone: "phone",
  name: "name",
};

export function PatientScopeFilterBar({
  basePath,
  doctors,
  departments,
  hideDoctorFilter = false,
  hideDeptFilter = false,
  className,
  paramNames,
  fallbackParams,
  resetParamsOnApply = [],
  clearExtraParams = [],
  actions,
}: PatientScopeFilterBarProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const names = { ...DEFAULT_PARAM_NAMES, ...paramNames };

  function currentValue(key: PatientFilterKey) {
    const primary = params.get(names[key]);
    if (primary) return primary;
    for (const fallback of fallbackParams?.[key] ?? []) {
      const value = params.get(fallback);
      if (value) return value;
    }
    return null;
  }

  function deleteKeyAndFallbacks(
    next: URLSearchParams,
    key: PatientFilterKey,
  ) {
    next.delete(names[key]);
    for (const fallback of fallbackParams?.[key] ?? []) next.delete(fallback);
  }

  function apply(key: PatientFilterKey, value: string | null) {
    const next = new URLSearchParams(params.toString());
    deleteKeyAndFallbacks(next, key);
    if (value) next.set(names[key], value);
    for (const resetKey of resetParamsOnApply) next.delete(resetKey);
    startTransition(() => {
      router.push(`${basePath}?${next.toString()}`);
    });
  }

  function clearAll() {
    const next = new URLSearchParams(params.toString());
    FILTER_KEYS.forEach((key) => deleteKeyAndFallbacks(next, key));
    for (const key of clearExtraParams) next.delete(key);
    for (const resetKey of resetParamsOnApply) next.delete(resetKey);
    startTransition(() => {
      router.push(`${basePath}?${next.toString()}`);
    });
  }

  const active = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, currentValue(key)]),
  ) as Record<PatientFilterKey, string | null>;
  const activeCount = FILTER_KEYS.filter((key) => {
    if (key === "doctor" && hideDoctorFilter) return false;
    if (key === "dept" && hideDeptFilter) return false;
    return active[key];
  }).length;

  return (
    <div
      className={cn("flex max-w-full flex-wrap items-center gap-2", className)}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        Filter
      </span>

      {!hideDoctorFilter && (
        <FilterChip
          filterKey="doctor"
          active={!!active.doctor}
          value={doctorName(doctors, active.doctor)}
        >
          <DoctorFilter
            current={active.doctor}
            doctors={doctors}
            onApply={(value) => apply("doctor", value)}
          />
        </FilterChip>
      )}

      {!hideDeptFilter && (
        <FilterChip
          filterKey="dept"
          active={!!active.dept}
          value={deptName(departments, active.dept)}
        >
          <DeptFilter
            current={active.dept}
            departments={departments}
            onApply={(value) => apply("dept", value)}
          />
        </FilterChip>
      )}

      <FilterChip filterKey="file" active={!!active.file} value={active.file}>
        <TextFilter
          placeholder="CF-0001"
          current={active.file}
          uppercase
          onApply={(value) => apply("file", value)}
        />
      </FilterChip>

      <FilterChip filterKey="nat" active={!!active.nat} value={active.nat}>
        <TextFilter
          placeholder="National ID"
          current={active.nat}
          onApply={(value) => apply("nat", value)}
        />
      </FilterChip>

      <FilterChip
        filterKey="phone"
        active={!!active.phone}
        value={active.phone}
      >
        <TextFilter
          placeholder="05XX XXX XX XX"
          current={active.phone}
          onApply={(value) => apply("phone", value)}
        />
      </FilterChip>

      <FilterChip filterKey="name" active={!!active.name} value={active.name}>
        <TextFilter
          placeholder="Patient name"
          current={active.name}
          onApply={(value) => apply("name", value)}
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

      {actions && <span className="ml-auto flex items-center gap-2">{actions}</span>}
    </div>
  );
}

function FilterChip({
  filterKey,
  active,
  value,
  children,
}: {
  filterKey: PatientFilterKey;
  active: boolean;
  value: string | null | undefined;
  children: React.ReactNode;
}) {
  const Icon = ICONS[filterKey];
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
          <Icon className="h-3.5 w-3.5" />
          {LABELS[filterKey]}
          {active && value && (
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
  placeholder,
  current,
  uppercase,
  onApply,
}: {
  placeholder: string;
  current: string | null;
  uppercase?: boolean;
  onApply: (value: string | null) => void;
}) {
  const [val, setVal] = useState(current ?? "");
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(val.trim() || null);
      }}
    >
      <Input
        value={val}
        onChange={(event) =>
          setVal(uppercase ? event.target.value.toUpperCase() : event.target.value)
        }
        placeholder={placeholder}
        className={cn("h-8 text-sm", uppercase && "uppercase")}
        autoFocus
      />
      <div className="flex justify-end gap-2">
        {current && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setVal("");
              onApply(null);
            }}
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

function DoctorFilter({
  current,
  doctors,
  onApply,
}: {
  current: string | null;
  doctors: { id: string; full_name: string }[];
  onApply: (value: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <Select value={current ?? ""} onValueChange={(value) => onApply(value || null)}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder="Select doctor" />
        </SelectTrigger>
        <SelectContent>
          {doctors.map((doctor) => (
            <SelectItem key={doctor.id} value={doctor.id}>
              {formatDoctorName(doctor.full_name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onApply(null)}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function DeptFilter({
  current,
  departments,
  onApply,
}: {
  current: string | null;
  departments: { id: string; name: string; color: string }[];
  onApply: (value: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <Select value={current ?? ""} onValueChange={(value) => onApply(value || null)}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder="Select department" />
        </SelectTrigger>
        <SelectContent>
          {departments.map((department) => (
            <SelectItem key={department.id} value={department.id}>
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: department.color }}
                />
                {department.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onApply(null)}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function doctorName(
  doctors: { id: string; full_name: string }[],
  id: string | null,
) {
  if (!id) return null;
  const doctor = doctors.find((item) => item.id === id);
  return doctor ? formatDoctorFirstName(doctor.full_name) : id;
}

function deptName(
  departments: { id: string; name: string; color: string }[],
  id: string | null,
) {
  if (!id) return null;
  const department = departments.find((item) => item.id === id);
  return department ? department.name : id;
}
