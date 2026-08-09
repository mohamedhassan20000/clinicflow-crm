"use client";

import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MoveRight,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
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

type RangeEdge = "from" | "to";

type CalendarLabels = {
  from: string;
  to: string;
};

type PickerButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "defaultValue" | "onChange" | "value"
>;

type DateRangePickerProps = {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  labels: CalendarLabels;
  min?: string;
  max?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  id?: string;
  compact?: boolean;
  enforceOrder?: boolean;
};

type SingleDatePickerProps = PickerButtonProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label: string;
  min?: string;
  max?: string;
  className?: string;
  name?: string;
  compact?: boolean;
};

type MonthPickerProps = PickerButtonProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label: string;
  min?: string;
  max?: string;
  className?: string;
  name?: string;
  compact?: boolean;
};

type TimePickerProps = PickerButtonProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label: string;
  className?: string;
  name?: string;
  compact?: boolean;
};

type DateTimePickerProps = {
  value: string;
  onChange: (value: string) => void;
  dateLabel: string;
  timeLabel: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
};

export function DateRangePicker({
  from,
  to,
  onFromChange,
  onToChange,
  labels,
  min,
  max,
  disabled = false,
  loading = false,
  className,
  id,
  compact = false,
  enforceOrder = false,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeEdge, setActiveEdge] = useState<RangeEdge>("from");
  const activeValue = activeEdge === "from" ? from : to;
  const activeMin = enforceOrder && activeEdge === "to" ? laterDate(min, from) : min;
  const activeMax = enforceOrder && activeEdge === "from" ? earlierDate(max, to) : max;

  function openEdge(edge: RangeEdge) {
    setActiveEdge(edge);
    setOpen(true);
  }

  function selectDate(value: string) {
    if (activeEdge === "from") {
      onFromChange(value);
      setActiveEdge("to");
      return;
    }
    onToChange(value);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          id={id}
          data-slot="date-range-picker"
          className={cn(
            "group/range relative flex min-w-0 items-stretch overflow-hidden rounded-xl border border-input bg-background shadow-xs transition-[border-color,box-shadow,opacity] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 dark:bg-input/30",
            disabled && "pointer-events-none opacity-50",
            compact ? "h-8" : "min-h-10",
            className,
          )}
        >
          <DateSegment
            edge="from"
            label={labels.from}
            value={from}
            active={open && activeEdge === "from"}
            expanded={open}
            disabled={disabled}
            onClick={() => openEdge("from")}
            compact={compact}
          />
          <span className="relative flex w-8 shrink-0 items-center justify-center text-primary/65">
            <span className="absolute inset-x-0 top-1/2 h-px bg-primary/20" />
            <span className="relative grid size-5 place-items-center rounded-full border border-primary/20 bg-background dark:bg-card">
              <MoveRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
            </span>
          </span>
          <DateSegment
            edge="to"
            label={labels.to}
            value={to}
            active={open && activeEdge === "to"}
            expanded={open}
            disabled={disabled}
            onClick={() => openEdge("to")}
            compact={compact}
          />
          {loading && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15">
              <span className="block h-full w-full animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
            </span>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        role="dialog"
        aria-label={`${labels.from} ${labels.to}`}
        align="start"
        sideOffset={8}
        className="z-[70] w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border/70 p-0 shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/35 px-3 py-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">
              {activeEdge === "from" ? labels.from : labels.to}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              <RangeSummary from={from} to={to} />
            </p>
          </div>
          <div className="flex rounded-lg bg-background p-0.5 ring-1 ring-border/60 dark:bg-card">
            {(["from", "to"] as const).map((edge) => (
              <button
                key={edge}
                type="button"
                onClick={() => setActiveEdge(edge)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeEdge === edge
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {edge === "from" ? labels.from : labels.to}
              </button>
            ))}
          </div>
        </div>
        <CalendarPanel
          value={activeValue}
          rangeFrom={from}
          rangeTo={to}
          min={activeMin}
          max={activeMax}
          onSelect={selectDate}
        />
      </PopoverContent>
    </Popover>
  );
}

export function SingleDatePicker({
  value,
  defaultValue,
  onChange,
  label,
  min,
  max,
  disabled = false,
  className,
  name,
  compact = false,
  id,
  ...buttonProps
}: SingleDatePickerProps) {
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const selectedValue = value ?? internalValue;

  function updateValue(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {name && <input type="hidden" name={name} value={selectedValue} />}
      <PopoverTrigger asChild>
        <PickerTrigger
          {...buttonProps}
          id={id}
          disabled={disabled}
          className={className}
          compact={compact}
          icon={<CalendarDays className="size-3.5" aria-hidden="true" />}
          label={label}
          empty={!selectedValue}
          value={<FormattedDate value={selectedValue} compact={compact} />}
        />
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={label}
        align="start"
        sideOffset={8}
        className="z-[70] w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border/70 p-0 shadow-xl"
      >
        <CalendarPanel
          value={selectedValue}
          min={min}
          max={max}
          onSelect={(date) => {
            updateValue(date);
            setOpen(false);
          }}
          onClear={selectedValue ? () => {
            updateValue("");
            setOpen(false);
          } : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}

export function MonthPicker({
  value,
  defaultValue,
  onChange,
  label,
  min,
  max,
  disabled = false,
  className,
  name,
  compact = false,
  id,
  ...buttonProps
}: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const selectedValue = value ?? internalValue;

  function updateValue(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {name && <input type="hidden" name={name} value={selectedValue} />}
      <PopoverTrigger asChild>
        <PickerTrigger
          {...buttonProps}
          id={id}
          disabled={disabled}
          className={className}
          compact={compact}
          icon={<CalendarDays className="size-3.5" aria-hidden="true" />}
          label={label}
          empty={!selectedValue}
          value={<FormattedMonth value={selectedValue} />}
        />
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={label}
        align="start"
        sideOffset={8}
        className="z-[70] w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border/70 p-0 shadow-xl"
      >
        <MonthPanel
          value={selectedValue}
          min={min}
          max={max}
          onSelect={(month) => {
            updateValue(month);
            setOpen(false);
          }}
          onClear={selectedValue ? () => {
            updateValue("");
            setOpen(false);
          } : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TimePicker({
  value,
  defaultValue,
  onChange,
  label,
  disabled = false,
  className,
  name,
  compact = false,
  id,
  ...buttonProps
}: TimePickerProps) {
  const t = useTranslations("calendarPicker");
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const selectedValue = value ?? internalValue;
  const [hour = "", minute = ""] = /^\d{2}:\d{2}$/.test(selectedValue)
    ? selectedValue.split(":")
    : [];

  function updateValue(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {name && <input type="hidden" name={name} value={selectedValue} />}
      <PopoverTrigger asChild>
        <PickerTrigger
          {...buttonProps}
          id={id}
          disabled={disabled}
          className={className}
          compact={compact}
          icon={<Clock3 className="size-3.5" aria-hidden="true" />}
          label={label}
          empty={!selectedValue}
          value={<span dir="ltr">{selectedValue || t("chooseTime")}</span>}
        />
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={label}
        align="start"
        sideOffset={8}
        className="z-[70] w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-border/70 p-3 shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-border/60 pb-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <Clock3 className="size-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-semibold text-foreground">{label}</p>
            <p className="text-[11px] text-muted-foreground" dir="ltr">
              {selectedValue || t("chooseTime")}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 py-3">
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t("hour")}
            </span>
            <Select
              value={hour}
              onValueChange={(nextHour) => updateValue(`${nextHour}:${minute || "00"}`)}
            >
              <SelectTrigger aria-label={t("hour")} className="h-9 w-full font-semibold tabular-nums" dir="ltr">
                <SelectValue placeholder="--" />
              </SelectTrigger>
              <SelectContent position="popper" className="z-[80] max-h-64">
                {Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0")).map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="pb-2 text-sm font-bold text-muted-foreground">:</span>
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t("minute")}
            </span>
            <Select
              value={minute}
              onValueChange={(nextMinute) => {
                updateValue(`${hour || "00"}:${nextMinute}`);
                setOpen(false);
              }}
            >
              <SelectTrigger aria-label={t("minute")} className="h-9 w-full font-semibold tabular-nums" dir="ltr">
                <SelectValue placeholder="--" />
              </SelectTrigger>
              <SelectContent position="popper" className="z-[80] max-h-64">
                {Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0")).map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {selectedValue && (
          <Button type="button" variant="ghost" size="xs" className="self-end" onClick={() => {
            updateValue("");
            setOpen(false);
          }}>
            {t("clearTime")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function DateTimePicker({
  value,
  onChange,
  dateLabel,
  timeLabel,
  min,
  max,
  disabled = false,
  className,
}: DateTimePickerProps) {
  const date = value.slice(0, 10);
  const time = value.slice(11, 16);

  return (
    <div className={cn("grid min-w-0 gap-2 sm:grid-cols-2", className)} data-slot="date-time-picker">
      <SingleDatePicker
        value={date}
        label={dateLabel}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(nextDate) => onChange(nextDate ? `${nextDate}T${time || "00:00"}` : "")}
      />
      <TimePicker
        value={time}
        label={timeLabel}
        disabled={disabled || !date}
        onChange={(nextTime) => onChange(date ? `${date}T${nextTime || "00:00"}` : "")}
      />
    </div>
  );
}

function PickerTrigger({
  icon,
  label,
  value,
  empty,
  compact,
  className,
  ...props
}: PickerButtonProps & {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  empty: boolean;
  compact: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border border-input bg-background px-3 text-start text-sm shadow-xs transition-[border-color,box-shadow,background-color] hover:bg-muted/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
        compact ? "h-8" : "h-10",
        className,
      )}
      {...props}
    >
      <span className={cn(
        "grid shrink-0 place-items-center rounded-lg bg-primary/10 text-primary",
        compact ? "size-6" : "size-7",
      )}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {!compact && (
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </span>
        )}
        <span className={cn("block truncate font-medium tabular-nums", empty && "text-muted-foreground")}>
          {value}
        </span>
      </span>
    </button>
  );
}

function DateSegment({
  edge,
  label,
  value,
  active,
  expanded,
  disabled,
  onClick,
  compact,
}: {
  edge: RangeEdge;
  label: string;
  value: string;
  active: boolean;
  expanded: boolean;
  disabled: boolean;
  onClick: () => void;
  compact: boolean;
}) {
  return (
    <button
      type="button"
      data-range-edge={edge}
      aria-pressed={active}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 px-2.5 text-start outline-none transition-colors hover:bg-muted/55 focus-visible:bg-muted/55",
        active && "bg-primary/8",
      )}
    >
        <CalendarDays className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0">
          {!compact && (
            <span className="block text-[9px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
              {label}
            </span>
          )}
          <span className="block truncate text-xs font-semibold tabular-nums text-foreground">
            <FormattedDate value={value} compact={compact} />
          </span>
        </span>
    </button>
  );
}

function CalendarPanel({
  value,
  rangeFrom,
  rangeTo,
  min,
  max,
  onSelect,
  onClear,
}: {
  value: string;
  rangeFrom?: string;
  rangeTo?: string;
  min?: string;
  max?: string;
  onSelect: (value: string) => void;
  onClear?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("calendarPicker");
  const initial = parseDate(value) ?? parseDate(rangeFrom) ?? new Date();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long" }),
    [locale],
  );
  const weekdayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "narrow" }),
    [locale],
  );
  const fullDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "full" }),
    [locale],
  );
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, month) => ({
      month,
      label: monthFormatter.format(new Date(2024, month, 1, 12)),
    })),
    [monthFormatter],
  );
  const years = useMemo(() => {
    const minYear = parseDate(min)?.getFullYear() ?? Math.min(viewYear - 125, new Date().getFullYear() - 125);
    const maxYear = parseDate(max)?.getFullYear() ?? Math.max(viewYear + 100, new Date().getFullYear() + 100);
    return Array.from({ length: Math.max(1, maxYear - minYear + 1) }, (_, index) => minYear + index);
  }, [max, min, viewYear]);
  const days = useMemo(() => calendarGrid(viewYear, viewMonth), [viewMonth, viewYear]);
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, index) =>
      weekdayFormatter.format(new Date(2024, 0, 7 + index, 12))),
    [weekdayFormatter],
  );
  const today = todayIso();

  function moveMonth(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1, 12);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  }

  return (
    <div className="p-3" data-slot="calendar-panel">
      <div className="mb-3 flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("previousMonth")}
          onClick={() => moveMonth(-1)}
          className="shrink-0"
        >
          <ChevronLeft className="rtl:-scale-x-100" />
        </Button>
        <Select value={String(viewMonth)} onValueChange={(next) => setViewMonth(Number(next))}>
          <SelectTrigger aria-label={t("month")} className="h-8 min-w-0 flex-1 font-semibold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="z-[80]">
            {months.map((month) => (
              <SelectItem key={month.month} value={String(month.month)}>
                {month.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(viewYear)} onValueChange={(next) => setViewYear(Number(next))}>
          <SelectTrigger aria-label={t("year")} className="h-8 w-24 font-semibold tabular-nums" dir="ltr">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="z-[80] max-h-64">
            {years.map((year) => (
              <SelectItem key={year} value={String(year)}>
                {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("nextMonth")}
          onClick={() => moveMonth(1)}
          className="shrink-0"
        >
          <ChevronRight className="rtl:-scale-x-100" />
        </Button>
      </div>

      <div className="grid grid-cols-7" role="grid" aria-label={t("calendar")}>
        {weekdays.map((weekday, index) => (
          <div
            key={`${weekday}-${index}`}
            role="columnheader"
            className="grid h-7 place-items-center text-[10px] font-bold uppercase text-muted-foreground"
          >
            {weekday}
          </div>
        ))}
        {days.map((day) => {
          const iso = formatDate(day);
          const outside = day.getMonth() !== viewMonth;
          const selected = iso === value;
          const isToday = iso === today;
          const inRange = Boolean(rangeFrom && rangeTo && iso > rangeFrom && iso < rangeTo);
          const rangeStart = Boolean(rangeFrom && iso === rangeFrom);
          const rangeEnd = Boolean(rangeTo && iso === rangeTo);
          const unavailable = Boolean((min && iso < min) || (max && iso > max));
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              aria-selected={selected || rangeStart || rangeEnd}
              aria-label={fullDateFormatter.format(day)}
              disabled={unavailable}
              onClick={() => onSelect(iso)}
              className={cn(
                "relative grid h-9 place-items-center rounded-lg text-xs font-medium tabular-nums outline-none transition-[color,background-color,box-shadow,transform] hover:z-10 hover:bg-primary/12 hover:text-foreground focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 disabled:pointer-events-none disabled:opacity-25 motion-reduce:transform-none",
                outside && "text-muted-foreground/45",
                inRange && "rounded-none bg-primary/10 text-foreground",
                rangeStart && "rounded-e-none bg-primary text-primary-foreground shadow-sm",
                rangeEnd && "rounded-s-none bg-primary text-primary-foreground shadow-sm",
                rangeStart && rangeEnd && "rounded-lg",
                selected && !rangeStart && !rangeEnd && "bg-primary text-primary-foreground shadow-sm",
                isToday && !selected && !rangeStart && !rangeEnd && "font-bold text-primary ring-1 ring-primary/35",
              )}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          {t("today")}: <FormattedDate value={today} compact />
        </span>
        <span className="flex items-center gap-1">
          {onClear && (
            <Button type="button" variant="ghost" size="xs" onClick={onClear}>
              {t("clearDate")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={Boolean((min && today < min) || (max && today > max))}
            onClick={() => onSelect(today)}
          >
            {t("chooseToday")}
          </Button>
        </span>
      </div>
    </div>
  );
}

function MonthPanel({
  value,
  min,
  max,
  onSelect,
  onClear,
}: {
  value: string;
  min?: string;
  max?: string;
  onSelect: (value: string) => void;
  onClear?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("calendarPicker");
  const initialYear = parseMonth(value)?.year ?? new Date().getFullYear();
  const [viewYear, setViewYear] = useState(initialYear);
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short" }),
    [locale],
  );
  const fullMonthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }),
    [locale],
  );
  const minYear = parseMonth(min)?.year ?? Math.min(viewYear - 125, new Date().getFullYear() - 125);
  const maxYear = parseMonth(max)?.year ?? Math.max(viewYear + 100, new Date().getFullYear() + 100);
  const years = Array.from(
    { length: Math.max(1, maxYear - minYear + 1) },
    (_, index) => minYear + index,
  );

  return (
    <div className="p-3" data-slot="month-panel">
      <div className="mb-3 flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("previousYear")}
          disabled={viewYear <= minYear}
          onClick={() => setViewYear((year) => year - 1)}
        >
          <ChevronLeft className="rtl:-scale-x-100" />
        </Button>
        <Select value={String(viewYear)} onValueChange={(next) => setViewYear(Number(next))}>
          <SelectTrigger aria-label={t("year")} className="h-8 flex-1 font-semibold tabular-nums" dir="ltr">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="z-[80] max-h-64">
            {years.map((year) => (
              <SelectItem key={year} value={String(year)}>{year}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("nextYear")}
          disabled={viewYear >= maxYear}
          onClick={() => setViewYear((year) => year + 1)}
        >
          <ChevronRight className="rtl:-scale-x-100" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {Array.from({ length: 12 }, (_, month) => {
          const monthValue = `${viewYear}-${String(month + 1).padStart(2, "0")}`;
          const selected = monthValue === value;
          const unavailable = Boolean((min && monthValue < min) || (max && monthValue > max));
          const date = new Date(viewYear, month, 1, 12);
          return (
            <button
              key={monthValue}
              type="button"
              aria-label={fullMonthFormatter.format(date)}
              aria-pressed={selected}
              disabled={unavailable}
              onClick={() => onSelect(monthValue)}
              className={cn(
                "rounded-lg px-2 py-2.5 text-xs font-semibold outline-none transition-[color,background-color,box-shadow,transform] hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 disabled:pointer-events-none disabled:opacity-25 motion-reduce:transform-none",
                selected && "bg-primary text-primary-foreground shadow-sm hover:bg-primary",
              )}
            >
              {monthFormatter.format(date)}
            </button>
          );
        })}
      </div>
      {onClear && (
        <div className="mt-2 flex justify-end border-t border-border/60 pt-2">
          <Button type="button" variant="ghost" size="xs" onClick={onClear}>
            {t("clearMonth")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FormattedDate({ value, compact = false }: { value: string; compact?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("calendarPicker");
  const date = parseDate(value);
  if (!date) return <>{t("chooseDate")}</>;
  return (
    <>
      {new Intl.DateTimeFormat(locale, compact
        ? { day: "2-digit", month: "short", year: "numeric" }
        : { day: "numeric", month: "short", year: "numeric" }).format(date)}
    </>
  );
}

function FormattedMonth({ value }: { value: string }) {
  const locale = useLocale();
  const t = useTranslations("calendarPicker");
  const parsed = parseMonth(value);
  if (!parsed) return <>{t("chooseMonth")}</>;
  return <>{new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" })
    .format(new Date(parsed.year, parsed.month - 1, 1, 12))}</>;
}

function RangeSummary({ from, to }: { from: string; to: string }) {
  const t = useTranslations("calendarPicker");
  if (!from && !to) return <>{t("chooseRange")}</>;
  return (
    <span className="inline-flex items-center gap-1">
      <FormattedDate value={from} compact />
      <MoveRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
      <FormattedDate value={to} compact />
    </span>
  );
}

function parseDate(value?: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  return date;
}

function parseMonth(value?: string): { year: number; month: number } | null {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return formatDate(new Date());
}

function calendarGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1, 12);
  const start = new Date(year, month, 1 - first.getDay(), 12);
  return Array.from({ length: 42 }, (_, index) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index, 12));
}

function laterDate(a?: string, b?: string): string | undefined {
  if (!a) return b || undefined;
  if (!b) return a;
  return a > b ? a : b;
}

function earlierDate(a?: string, b?: string): string | undefined {
  if (!a) return b || undefined;
  if (!b) return a;
  return a < b ? a : b;
}
