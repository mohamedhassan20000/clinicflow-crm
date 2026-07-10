"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/actions/settings";

interface Department {
  id: string;
  name: string;
  color: string;
}

interface ServiceFormProps {
  action: (
    prev: ActionResult | null,
    fd: FormData,
  ) => Promise<ActionResult>;
  departments: Department[];
  defaults?: {
    department_id?: string;
    name?: string;
    price?: number;
  };
  submitLabel: string;
  onSuccess?: () => void;
}

export function ServiceForm({
  action,
  departments,
  defaults,
  submitLabel,
  onSuccess,
}: ServiceFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);

  useEffect(() => {
    if (!state) return;
    if (state.error) toast.error(state.error);
    else if (state.success) {
      toast.success("Saved.");
      onSuccess?.();
    }
  }, [state, onSuccess]);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="svc-department" className="text-xs">
          Department
        </Label>
        <Select
          name="department_id"
          defaultValue={defaults?.department_id}
          disabled={isPending}
        >
          <SelectTrigger id="svc-department">
            <SelectValue placeholder="Select department" />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="svc-name" className="text-xs">
          Service name
        </Label>
        <Input
          id="svc-name"
          name="name"
          placeholder="e.g. Consultation"
          defaultValue={defaults?.name}
          disabled={isPending}
          required
          minLength={2}
          maxLength={100}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="svc-price" className="text-xs">
          Price
        </Label>
        <Input
          id="svc-price"
          name="price"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.00"
          defaultValue={defaults?.price ?? ""}
          disabled={isPending}
          required
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending} className="gap-2">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
