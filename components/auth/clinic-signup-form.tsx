"use client";

import { useActionState, useState } from "react";
import type { CountryCode } from "libphonenumber-js";
import { signUpClinic, type AuthActionResult } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InternationalPhoneInput } from "@/components/shared/international-phone-input";
import { useTranslations } from "next-intl";

type Defaults = { token?: string; clinicName?: string; ownerName?: string; email?: string };

export function ClinicSignupForm({ defaults }: { defaults: Defaults }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState<AuthActionResult | null, FormData>(signUpClinic, null);
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState<CountryCode>("KW");
  if (state?.ok) {
    return <div className="text-center"><h2 className="text-xl font-semibold">{t("checkYourEmail")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("confirmYourEmailThenSignIn")}</p></div>;
  }
  const fields: Array<[string, string, string, string | undefined]> = [
    ['clinicName','Clinic name','text',defaults.clinicName],
    ['ownerName','Owner name','text',defaults.ownerName], ['email','Owner email','email',defaults.email],
    ['password','Password','password',''],
  ];
  return (
    <form action={action} className="space-y-4">
      {defaults.token && <input type="hidden" name="token" value={defaults.token} />}
      {fields.map(([name,label,type,value]) => <div className="space-y-2" key={name}>
        <Label htmlFor={name}>{label}</Label><Input id={name} name={name} type={type} defaultValue={value} required disabled={pending} />
        {state?.fieldErrors?.[name]?.[0] && <p className="text-sm text-destructive">{state.fieldErrors[name][0]}</p>}
      </div>)}
      <div className="space-y-2"><Label htmlFor="signup-phone">{t("clinicPhone")}</Label><InternationalPhoneInput id="signup-phone" name="phone" value={phone} onChange={setPhone} defaultCountry={country} required disabled={pending} />{state?.fieldErrors?.phone?.[0] && <p className="text-sm text-destructive">{state.fieldErrors.phone[0]}</p>}</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2"><Label htmlFor="country">{t("country")}</Label><select id="country" name="country" value={country} onChange={(event) => setCountry(event.target.value as CountryCode)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="KW">{t("kuwait")}</option><option value="SA">{t("saudiArabia")}</option><option value="AE">{t("uae")}</option><option value="EG">{t("egypt")}</option></select></div>
        <div className="space-y-2"><Label htmlFor="locale">{t("language")}</Label><select id="locale" name="locale" defaultValue="ar" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="ar">{t("arabic")}</option><option value="en">{t("english")}</option></select></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("password8CharactersOneUppercaseLetter")}</p>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button className="w-full" disabled={pending}>{pending ? t("creatingClinic") : t("createClinic")}</Button>
    </form>
  );
}
