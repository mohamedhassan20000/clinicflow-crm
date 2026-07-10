"use client";

import { useActionState } from "react";
import { signUpClinic, type AuthActionResult } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Defaults = { token?: string; clinicName?: string; ownerName?: string; email?: string };

export function ClinicSignupForm({ defaults }: { defaults: Defaults }) {
  const [state, action, pending] = useActionState<AuthActionResult | null, FormData>(signUpClinic, null);
  if (state?.ok) {
    return <div className="text-center"><h2 className="text-xl font-semibold">Check your email</h2><p className="mt-2 text-sm text-muted-foreground">Confirm your email, then sign in to finish clinic setup.</p></div>;
  }
  const fields: Array<[string, string, string, string | undefined]> = [
    ['clinicName','Clinic name','text',defaults.clinicName], ['phone','Clinic phone','text',''],
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
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2"><Label htmlFor="country">Country</Label><select id="country" name="country" defaultValue="KW" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="KW">Kuwait</option><option value="SA">Saudi Arabia</option><option value="AE">UAE</option><option value="EG">Egypt</option></select></div>
        <div className="space-y-2"><Label htmlFor="locale">Language</Label><select id="locale" name="locale" defaultValue="ar" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"><option value="ar">Arabic</option><option value="en">English</option></select></div>
      </div>
      <p className="text-xs text-muted-foreground">Password: 8+ characters, one uppercase letter, and one number.</p>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button className="w-full" disabled={pending}>{pending ? 'Creating clinic…' : 'Create clinic'}</Button>
    </form>
  );
}
