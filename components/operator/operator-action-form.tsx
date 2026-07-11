"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";

type ActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  rawToken?: string;
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
    <form action={formAction} className={className ?? "space-y-3"}>
      {children}
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
        </div>
      ) : null}
      <Button type="submit" size="sm" variant={submitVariant} disabled={pending}>
        {pending ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
