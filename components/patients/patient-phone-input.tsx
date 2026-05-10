"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatPatientPhoneForInput,
  formatPhoneInputValue,
  inferPhoneCountry,
  normalizePatientPhone,
  PHONE_COUNTRIES,
} from "@/lib/patient-phone";

interface PatientPhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  name?: string;
}

export function PatientPhoneInput({
  value,
  onChange,
  onBlur,
  disabled,
  name,
}: PatientPhoneInputProps) {
  const initialCountry = useMemo(() => inferPhoneCountry(value), [value]);
  const [country, setCountry] = useState(initialCountry);
  const displayValue = formatPatientPhoneForInput(value, country);

  function handleCountryChange(nextCountry: string) {
    setCountry(nextCountry);
    const nextValue = formatPatientPhoneForInput(value, nextCountry);
    onChange(nextValue);
  }

  function handleInputChange(nextValue: string) {
    const formatted = formatPhoneInputValue(nextValue, country);
    onChange(formatted);
  }

  function handleBlur() {
    const normalized = normalizePatientPhone(displayValue, country);
    if (normalized) {
      onChange(normalized);
    }
    onBlur?.();
  }

  return (
    <div className="flex gap-2">
      <Select value={country} onValueChange={handleCountryChange} disabled={disabled}>
        <SelectTrigger className="w-[132px] shrink-0">
          <SelectValue aria-label="Phone country" />
        </SelectTrigger>
        <SelectContent>
          {PHONE_COUNTRIES.map((item) => (
            <SelectItem key={item.code} value={item.code}>
              {item.code === "INTL" ? item.label : `${item.code} ${item.dialCode}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder={country === "TR" ? "+90 (5__) ___ __ __" : "+1 555 123 4567"}
        value={displayValue}
        onChange={(event) => handleInputChange(event.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
      />
    </div>
  );
}
