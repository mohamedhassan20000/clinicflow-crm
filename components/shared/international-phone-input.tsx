"use client";

import { useState } from "react";
import type { CountryCode } from "libphonenumber-js";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PHONE_COUNTRIES, formatLocalPhone, inferPhoneCountry, localPhoneValue, normalizePhone } from "@/lib/phone/registry";

type Props = { value: string; onChange: (value: string) => void; onBlur?: () => void; disabled?: boolean; name?: string; defaultCountry?: CountryCode; id?: string; required?: boolean; "aria-invalid"?: boolean };

export function InternationalPhoneInput({ value, onChange, onBlur, disabled, name, defaultCountry = "KW", id, required, "aria-invalid": ariaInvalid }: Props) {
  const [country, setCountry] = useState<CountryCode>(() => inferPhoneCountry(value, defaultCountry));
  const [local, setLocal] = useState(() => localPhoneValue(value, country));

  function emit(nextLocal: string, nextCountry = country) {
    setLocal(nextLocal);
    const normalized = normalizePhone(nextLocal, nextCountry);
    onChange(normalized ?? nextLocal);
  }

  const normalized = normalizePhone(local, country) ?? "";
  return <div className="flex gap-2">
    {name ? <><input type="hidden" name={name} value={normalized || local} /><input type="hidden" name={`${name}Country`} value={country} /></> : null}
    <Select value={country} onValueChange={(next) => { const code = next as CountryCode; setCountry(code); setLocal(""); onChange(""); }} disabled={disabled}>
      <SelectTrigger className="w-[190px] shrink-0" aria-label="Country calling code"><SelectValue /></SelectTrigger>
      <SelectContent>{PHONE_COUNTRIES.map((item) => <SelectItem key={item.code} value={item.code}>{item.flag} {item.name} {item.dialCode}</SelectItem>)}</SelectContent>
    </Select>
    <Input id={id} type="tel" inputMode="tel" autoComplete="tel" required={required} aria-invalid={ariaInvalid} value={local} placeholder="Local number" disabled={disabled} onChange={(event) => emit(formatLocalPhone(event.target.value, country))} onBlur={() => { const normalized = normalizePhone(local, country); if (normalized) onChange(normalized); onBlur?.(); }} />
  </div>;
}

export function InternationalPhoneField(props: Omit<Props, "value" | "onChange"> & { defaultValue?: string }) {
  const [value, setValue] = useState(props.defaultValue ?? "");
  return <InternationalPhoneInput {...props} value={value} onChange={setValue} />;
}
