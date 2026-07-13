"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type SearchableComboboxProps<Item> = {
  items: readonly Item[];
  value: string;
  onValueChange: (value: string) => void;
  getValue: (item: Item) => string;
  getSearchValue: (item: Item) => string;
  renderTrigger: (selected: Item | undefined) => ReactNode;
  renderItem: (item: Item, selected: boolean) => ReactNode;
  ariaLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  filter?: ComponentProps<typeof Command>["filter"];
  showSelectedCheck?: boolean;
};

/** Shared cmdk trigger, popover, search, and selection behavior. */
export function SearchableCombobox<Item>({
  items,
  value,
  onValueChange,
  getValue,
  getSearchValue,
  renderTrigger,
  renderItem,
  ariaLabel,
  searchPlaceholder,
  emptyMessage,
  disabled,
  triggerClassName,
  contentClassName,
  filter,
  showSelectedCheck = true,
}: SearchableComboboxProps<Item>) {
  const [open, setOpen] = useState(false);
  const selected = items.find((item) => getValue(item) === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn("justify-between font-normal", triggerClassName)}
        >
          {renderTrigger(selected)}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("p-0", contentClassName)} align="start">
        <Command filter={filter}>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {items.map((item) => {
              const itemValue = getValue(item);
              const isSelected = itemValue === value;
              return (
                <CommandItem
                  key={itemValue}
                  value={getSearchValue(item)}
                  data-checked={showSelectedCheck ? isSelected : undefined}
                  onSelect={() => {
                    setOpen(false);
                    onValueChange(itemValue);
                  }}
                >
                  {renderItem(item, isSelected)}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
