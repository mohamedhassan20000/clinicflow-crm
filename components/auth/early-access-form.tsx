"use client";

import { useActionState, useState } from "react";
import { requestEarlyAccess, type PublicActionResult } from "@/actions/early-access";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InternationalPhoneInput } from "@/components/shared/international-phone-input";
import { useTranslations } from "next-intl";

export function EarlyAccessForm({ mode = "standalone" }: { mode?: "standalone" | "dialog" }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState<PublicActionResult | null, FormData>(requestEarlyAccess, null);
  const [phone, setPhone] = useState("");
  if (state?.ok) {
    return <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 text-center"><h2 className="text-lg font-semibold">{t("requestReceived")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("weLlContactYouAtThe")}</p>{mode === "dialog" ? <DialogClose asChild><Button className="mt-5" variant="outline">{t("backToClinicflow")}</Button></DialogClose> : null}</div>;
  }
  return (
    <form action={action} className="space-y-4">
      {[
        ["clinicName", t("clinicName"), t("yourClinic")],
        ["ownerName", t("ownerName"), t("fullName")],
        ["email", t("email"), t("ownerClinicCom")],
      ].map(([name,label,placeholder]) => (
        <div className="space-y-2" key={name}>
          <Label htmlFor={name}>{label}</Label>
          <Input id={name} name={name} type={name === 'email' ? 'email' : 'text'} placeholder={placeholder} required disabled={pending} />
          {state?.fieldErrors?.[name]?.[0] && <p className="text-sm text-destructive">{state.fieldErrors[name][0]}</p>}
        </div>
      ))}
      <div className="space-y-2"><Label htmlFor="early-access-phone">{t("phone")}</Label><InternationalPhoneInput id="early-access-phone" name="phone" value={phone} onChange={setPhone} required disabled={pending} />{state?.fieldErrors?.phone?.[0] && <p className="text-sm text-destructive">{state.fieldErrors.phone[0]}</p>}</div>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button className="w-full" disabled={pending}>{pending ? t("submitting") : t("requestInvitation")}</Button>
    </form>
  );
}
