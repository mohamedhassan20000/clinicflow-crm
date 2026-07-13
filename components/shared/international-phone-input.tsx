"use client";

import { useEffect, useRef, useState } from "react";
import type { CountryCode } from "libphonenumber-js";
import { Input } from "@/components/ui/input";
import { SearchableCombobox } from "@/components/shared/searchable-combobox";
import {
  PHONE_COUNTRIES,
  formatLocalPhone,
  inferPhoneCountry,
  localPhoneValue,
  normalizePhone,
} from "@/lib/phone/registry";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  name?: string;
  defaultCountry?: CountryCode;
  id?: string;
  required?: boolean;
  "aria-invalid"?: boolean;
};

/**
 * Searchable, keyboard-accessible country selector shared by the phone input
 * (WS3) and reused as the pattern for the currency picker (WS4). cmdk provides
 * combobox/listbox roles, type-ahead, and full arrow/Enter/Escape navigation.
 */
function CountryCombobox({
  country,
  onSelect,
  disabled,
}: {
  country: CountryCode;
  onSelect: (code: CountryCode) => void;
  disabled?: boolean;
}) {
  return (
    <SearchableCombobox
      items={PHONE_COUNTRIES}
      value={country}
      onValueChange={(code) => onSelect(code as CountryCode)}
      getValue={(item) => item.code}
      getSearchValue={(item) => `${item.name}|${item.code}|${item.dialCode}`}
      ariaLabel="Country calling code"
      searchPlaceholder="Search country or code…"
      emptyMessage="No country found."
      disabled={disabled}
      triggerClassName="w-[132px] shrink-0 gap-1 px-3"
      contentClassName="w-[280px]"
      filter={(value, search) =>
        value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
      }
      renderTrigger={(active) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden>{active?.flag}</span>
          <span className="truncate tabular-nums">{active?.dialCode}</span>
        </span>
      )}
      renderItem={(item) => (
        <>
          <span aria-hidden>{item.flag}</span>
          <span className="truncate">{item.name}</span>
          <span className="ms-auto text-xs tabular-nums text-muted-foreground">
            {item.dialCode}
          </span>
        </>
      )}
    />
  );
}

export function InternationalPhoneInput({
  value,
  onChange,
  onBlur,
  disabled,
  name,
  defaultCountry = "KW",
  id,
  required,
  "aria-invalid": ariaInvalid,
}: Props) {
  const [country, setCountry] = useState<CountryCode>(() => inferPhoneCountry(value, defaultCountry));
  const [local, setLocal] = useState(() => localPhoneValue(value, country));
  // Tracks what we last emitted so a controlled parent echoing our own value
  // back does NOT trigger a resync (which would fight the user's typing).
  const lastEmitted = useRef(value);
  const phoneCountryAutoFollows = useRef(true);
  const previousDefaultCountry = useRef(defaultCountry);

  // The signup form changes this default as the clinic country changes. Keep
  // following it until the user explicitly chooses a phone country.
  useEffect(() => {
    const previous = previousDefaultCountry.current;
    previousDefaultCountry.current = defaultCountry;
    if (previous === defaultCountry || !phoneCountryAutoFollows.current) return;
    setCountry(defaultCountry);
  }, [defaultCountry]);

  // Resync only on a genuine external value change (e.g. RHF reset reusing a
  // dialog for a different record) — closes P15D-P8 without breaking typing.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const nextCountry = inferPhoneCountry(value, defaultCountry);
    setCountry(nextCountry);
    setLocal(localPhoneValue(value, nextCountry));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function emit(nextLocal: string, nextCountry = country) {
    setLocal(nextLocal);
    const normalized = normalizePhone(nextLocal, nextCountry);
    const next = normalized ?? nextLocal;
    lastEmitted.current = next;
    onChange(next);
  }

  const normalized = normalizePhone(local, country) ?? "";
  return (
    <div className="flex gap-2">
      {name ? (
        <>
          <input type="hidden" name={name} value={normalized || local} />
          <input type="hidden" name={`${name}Country`} value={country} />
        </>
      ) : null}
      <CountryCombobox
        country={country}
        disabled={disabled}
        onSelect={(code) => {
          phoneCountryAutoFollows.current = false;
          setCountry(code);
          setLocal("");
          lastEmitted.current = "";
          onChange("");
        }}
      />
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required={required}
        aria-invalid={ariaInvalid}
        value={local}
        placeholder="Local number"
        disabled={disabled}
        className={cn("min-w-0 flex-1")}
        onChange={(event) => emit(formatLocalPhone(event.target.value, country))}
        onBlur={() => {
          const next = normalizePhone(local, country);
          if (next) {
            lastEmitted.current = next;
            onChange(next);
          }
          onBlur?.();
        }}
      />
    </div>
  );
}

export function InternationalPhoneField(props: Omit<Props, "value" | "onChange"> & { defaultValue?: string }) {
  const [value, setValue] = useState(props.defaultValue ?? "");
  return <InternationalPhoneInput {...props} value={value} onChange={setValue} />;
}
