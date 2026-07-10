"use client";

import { useActionState } from "react";
import { requestEarlyAccess, type PublicActionResult } from "@/actions/early-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function EarlyAccessForm() {
  const [state, action, pending] = useActionState<PublicActionResult | null, FormData>(requestEarlyAccess, null);
  if (state?.ok) {
    return <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 text-center"><h2 className="text-lg font-semibold">Request received</h2><p className="mt-2 text-sm text-muted-foreground">We’ll contact you at the email address provided after reviewing your clinic.</p></div>;
  }
  return (
    <form action={action} className="space-y-4">
      {[['clinicName','Clinic name','Your clinic'],['ownerName','Owner name','Full name'],['phone','Phone','+965 …'],['email','Email','owner@clinic.com']].map(([name,label,placeholder]) => (
        <div className="space-y-2" key={name}>
          <Label htmlFor={name}>{label}</Label>
          <Input id={name} name={name} type={name === 'email' ? 'email' : 'text'} placeholder={placeholder} required disabled={pending} />
          {state?.fieldErrors?.[name]?.[0] && <p className="text-sm text-destructive">{state.fieldErrors[name][0]}</p>}
        </div>
      ))}
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button className="w-full" disabled={pending}>{pending ? 'Submitting…' : 'Request invitation'}</Button>
    </form>
  );
}

