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

type FilterKey =
  | "doctor"
  | "dept"
  | "file"
  | "nat"
  | "phone"
  | "name";

interface Props {
  doctors: { id: string; full_name: string }[];
  departments: { id: string; name: string; color: string }[];
  hideDoctorFilter?: boolean;
  hideDeptFilter?: boolean;
}

const ICONS: Record<FilterKey, React.ComponentType<{ className?: string }>> = {
  doctor: Stethoscope,
  dept: Building2,
  file: Hash,
  nat: IdCard,
  phone: Phone,
  name: User,
};

const LABELS: Record<FilterKey, string> = {
  doctor: "Doctor",
  dept: "Department",
  file: "File #",
  nat: "National ID",
  phone: "Phone",
  name: "Name",
};

export function AppointmentsFilterBar({ doctors, departments, hideDoctorFilter = false, hideDeptFilter = false }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function apply(key: FilterKey, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    // Preserve week navigation; clear page param if any
    startTransition(() => {
      router.push(`/appointments?${next.toString()}`);
    });
  }

  function clearAll() {
    const next = new URLSearchParams(params.toString());
    (["doctor", "dept", "file", "nat", "phone", "name"] as FilterKey[]).forEach(
      (k) => next.delete(k),
    );
    startTransition(() => {
      router.push(`/appointments?${next.toString()}`);
    });
  }

  const activeCount = (["doctor", "dept", "file", "nat", "phone", "name"] as FilterKey[])
    .filter((k) => params.get(k))
    .length;

  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        Filter
      </span>

      {!hideDoctorFilter && (
        <FilterChip
          filterKey="doctor"
          active={!!params.get("doctor")}
          value={doctorName(doctors, params.get("doctor"))}
        >
          <DoctorFilter
            current={params.get("doctor")}
            doctors={doctors}
            onApply={(v) => apply("doctor", v)}
          />
        </FilterChip>
      )}

      {!hideDeptFilter && (
        <FilterChip
          filterKey="dept"
          active={!!params.get("dept")}
          value={deptName(departments, params.get("dept"))}
        >
          <DeptFilter
            current={params.get("dept")}
            departments={departments}
            onApply={(v) => apply("dept", v)}
          />
        </FilterChip>
      )}

      <FilterChip
        filterKey="file"
        active={!!params.get("file")}
        value={params.get("file")}
      >
        <TextFilter
          placeholder="CF-0001"
          current={params.get("file")}
          uppercase
          onApply={(v) => apply("file", v)}
        />
      </FilterChip>

      <FilterChip
        filterKey="nat"
        active={!!params.get("nat")}
        value={params.get("nat")}
      >
        <TextFilter
          placeholder="National ID"
          current={params.get("nat")}
          onApply={(v) => apply("nat", v)}
        />
      </FilterChip>

      <FilterChip
        filterKey="phone"
        active={!!params.get("phone")}
        value={params.get("phone")}
      >
        <TextFilter
          placeholder="05XX XXX XX XX"
          current={params.get("phone")}
          onApply={(v) => apply("phone", v)}
        />
      </FilterChip>

      <FilterChip
        filterKey="name"
        active={!!params.get("name")}
        value={params.get("name")}
      >
        <TextFilter
          placeholder="Patient name"
          current={params.get("name")}
          onApply={(v) => apply("name", v)}
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
    </div>
  );
}

function FilterChip({
  filterKey,
  active,
  value,
  children,
}: {
  filterKey: FilterKey;
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
  onApply: (v: string | null) => void;
}) {
  const [val, setVal] = useState(current ?? "");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(val.trim() || null);
      }}
    >
      <Input
        value={val}
        onChange={(e) =>
          setVal(uppercase ? e.target.value.toUpperCase() : e.target.value)
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
  onApply: (v: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <Select
        value={current ?? ""}
        onValueChange={(v) => onApply(v || null)}
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
  onApply: (v: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <Select
        value={current ?? ""}
        onValueChange={(v) => onApply(v || null)}
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
  const d = doctors.find((x) => x.id === id);
  return d ? `Dr. ${d.full_name.split(" ")[0]}` : id;
}

function deptName(
  departments: { id: string; name: string; color: string }[],
  id: string | null,
) {
  if (!id) return null;
  const d = departments.find((x) => x.id === id);
  return d ? d.name : id;
}
