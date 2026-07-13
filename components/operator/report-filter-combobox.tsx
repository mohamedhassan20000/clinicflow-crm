"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { SearchableCombobox } from "@/components/shared/searchable-combobox";
import type { ReportFilterOption } from "@/lib/operator-reports/types";
import { cn } from "@/lib/utils";

/** Searchable, form-compatible WS7 filter using the shared WS3/WS4 cmdk pattern. */
export function ReportFilterCombobox({
  name,
  value,
  options,
  label,
  placeholder,
}: {
  name: string;
  value: string;
  options: readonly ReportFilterOption[];
  label: string;
  placeholder: string;
}) {
  const [selected, setSelected] = useState(value);

  return (
    <>
      <input type="hidden" name={name} value={selected} />
      <SearchableCombobox
        items={options}
        value={selected}
        onValueChange={setSelected}
        getValue={(option) => option.value}
        getSearchValue={(option) => `${option.label}|${option.value}`}
        ariaLabel={label}
        searchPlaceholder={`Search ${label.toLowerCase()}…`}
        emptyMessage="No option found."
        triggerClassName="w-full min-w-44 gap-2"
        contentClassName="w-[min(22rem,90vw)]"
        showSelectedCheck={false}
        renderTrigger={(active) => (
          <span className="truncate">{active?.label ?? placeholder}</span>
        )}
        renderItem={(option, isSelected) => (
          <>
            <Check
              className={cn(
                "size-4 shrink-0",
                isSelected ? "opacity-100" : "opacity-0",
              )}
              aria-hidden="true"
            />
            <span className="truncate">{option.label}</span>
          </>
        )}
      />
    </>
  );
}
