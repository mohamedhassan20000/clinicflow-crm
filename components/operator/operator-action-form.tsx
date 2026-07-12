"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { sendInvitationEmail } from "@/actions/operator";

type ActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  rawToken?: string;
  invitationId?: string;
  invitationEmail?: string;
} | null;

/**
 * Shared shell for operator mutations: wires useActionState around a server
 * action, surfaces errors/success, and shows one-time invitation links (raw
 * tokens are displayed exactly once and never persisted or logged).
 */
export function OperatorActionForm({
  action,
  submitLabel,
  submitVariant = "default",
  className,
  children,
}: {
  action: (previous: ActionState, formData: FormData) => Promise<NonNullable<ActionState>>;
  submitLabel: string;
  submitVariant?: "default" | "destructive" | "outline" | "secondary";
  className?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <div className={className ?? "space-y-3"}>
      <form action={formAction} className="space-y-3">
        {children}
        <Button type="submit" size="sm" variant={submitVariant} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
      </form>
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state?.fieldErrors
        ? Object.entries(state.fieldErrors).map(([field, messages]) => (
            <p key={field} className="text-sm text-destructive">
              {field}: {messages.join(", ")}
            </p>
          ))
        : null}
      {state?.ok && !state.rawToken ? <p className="text-sm text-emerald-600">Saved.</p> : null}
      {state?.rawToken ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <p className="font-medium">One-time invitation link — copy it now; it is not stored:</p>
          <code className="mt-1 block break-all text-xs">{`${typeof window !== "undefined" ? window.location.origin : ""}/signup/${state.rawToken}`}</code>
          {state.invitationId && state.invitationEmail ? <InvitationEmailForm invitationId={state.invitationId} invitationEmail={state.invitationEmail} invitationLink={`${typeof window !== "undefined" ? window.location.origin : ""}/signup/${state.rawToken}`} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function InvitationEmailForm({ invitationId, invitationEmail, invitationLink }: { invitationId: string; invitationEmail: string; invitationLink: string }) {
  const [state, action, pending] = useActionState(sendInvitationEmail, null);
  return <form action={action} className="mt-3 space-y-2"><input type="hidden" name="invitationId" value={invitationId} /><input type="hidden" name="invitationEmail" value={invitationEmail} /><input type="hidden" name="invitationLink" value={invitationLink} /><Button type="submit" size="sm" disabled={pending}>{pending ? "Sending…" : "Send Invitation Email"}</Button>{state?.error ? <p className="text-destructive">{state.error}</p> : null}{state?.ok ? <p className="text-emerald-700">Invitation email sent.</p> : null}</form>;
}
