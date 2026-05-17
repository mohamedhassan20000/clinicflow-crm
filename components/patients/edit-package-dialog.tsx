"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { updatePatientPackage } from "@/actions/patient-packages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  PatientPackageDepartment,
  PatientPackageItem,
  PatientPackageService,
} from "./patient-packages-section";

interface EditPackageDialogProps {
  packageItem: PatientPackageItem;
  departments: PatientPackageDepartment[];
  services: PatientPackageService[];
}

function fieldError(
  fieldErrors: Record<string, string[]> | undefined,
  key: string,
) {
  return fieldErrors?.[key]?.[0] ?? null;
}

export function EditPackageDialog({
  packageItem,
  departments,
  services,
}: EditPackageDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(packageItem.name);
  const [totalSessions, setTotalSessions] = useState(
    String(packageItem.total_sessions),
  );
  const [price, setPrice] = useState(
    packageItem.price_per_session == null
      ? ""
      : String(packageItem.price_per_session),
  );
  const [notes, setNotes] = useState(packageItem.notes ?? "");
  const [isActive, setIsActive] = useState(packageItem.is_active);
  const [departmentId, setDepartmentId] = useState(
    packageItem.department_id ?? "none",
  );
  const [serviceId, setServiceId] = useState(packageItem.service_id ?? "none");
  const [state, formAction, isPending] = useActionState(
    updatePatientPackage,
    null,
  );

  useEffect(() => {
    if (!open) return;

    queueMicrotask(() => {
      setName(packageItem.name);
      setTotalSessions(String(packageItem.total_sessions));
      setPrice(
        packageItem.price_per_session == null
          ? ""
          : String(packageItem.price_per_session),
      );
      setNotes(packageItem.notes ?? "");
      setIsActive(packageItem.is_active);
      setDepartmentId(packageItem.department_id ?? "none");
      setServiceId(packageItem.service_id ?? "none");
    });
  }, [open, packageItem]);

  const filteredServices = useMemo(() => {
    if (departmentId === "none") return services;
    return services.filter((service) => service.department_id === departmentId);
  }, [departmentId, services]);

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toast.error(state.error);
      return;
    }
    if (state.success) {
      toast.success("Package updated.");
      router.refresh();
      queueMicrotask(() => setOpen(false));
    }
  }, [router, state]);

  const total = Number(totalSessions);
  const invalid =
    !name.trim() ||
    !Number.isInteger(total) ||
    total <= 0 ||
    total < packageItem.used_sessions;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <Pencil className="h-3 w-3" />
        Edit
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (isPending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit package</DialogTitle>
            <DialogDescription>
              Update package details without changing used sessions.
            </DialogDescription>
          </DialogHeader>

          <form action={formAction} className="space-y-4">
            <input type="hidden" name="package_id" value={packageItem.id} />
            <input type="hidden" name="is_active" value={String(isActive)} />
            <input
              type="hidden"
              name="department_id"
              value={departmentId === "none" ? "" : departmentId}
            />
            <input
              type="hidden"
              name="service_id"
              value={serviceId === "none" ? "" : serviceId}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`package-name-${packageItem.id}`} className="text-xs">
                  Package name
                </Label>
                <Input
                  id={`package-name-${packageItem.id}`}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isPending}
                  maxLength={120}
                  aria-invalid={Boolean(fieldError(state?.fieldErrors, "name"))}
                />
                {fieldError(state?.fieldErrors, "name") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "name")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`package-total-${packageItem.id}`} className="text-xs">
                  Total sessions
                </Label>
                <Input
                  id={`package-total-${packageItem.id}`}
                  name="total_sessions"
                  type="number"
                  inputMode="numeric"
                  min={packageItem.used_sessions}
                  step={1}
                  value={totalSessions}
                  onChange={(event) => setTotalSessions(event.target.value)}
                  disabled={isPending}
                  aria-invalid={Boolean(
                    fieldError(state?.fieldErrors, "total_sessions"),
                  )}
                />
                {invalid && total < packageItem.used_sessions && (
                  <p className="text-xs text-destructive">
                    Cannot be less than {packageItem.used_sessions} used.
                  </p>
                )}
                {fieldError(state?.fieldErrors, "total_sessions") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "total_sessions")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`package-price-${packageItem.id}`} className="text-xs">
                  Price per session
                </Label>
                <Input
                  id={`package-price-${packageItem.id}`}
                  name="price_per_session"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  disabled={isPending}
                  placeholder="0.00"
                  aria-invalid={Boolean(
                    fieldError(state?.fieldErrors, "price_per_session"),
                  )}
                />
                {fieldError(state?.fieldErrors, "price_per_session") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "price_per_session")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Department</Label>
                <Select
                  value={departmentId}
                  onValueChange={(value) => {
                    setDepartmentId(value);
                    setServiceId("none");
                  }}
                  disabled={isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No department</SelectItem>
                    {departments.map((department) => (
                      <SelectItem key={department.id} value={department.id}>
                        {department.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Service</Label>
                <Select
                  value={serviceId}
                  onValueChange={setServiceId}
                  disabled={isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No service</SelectItem>
                    {filteredServices.map((service) => (
                      <SelectItem key={service.id} value={service.id}>
                        {service.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
              <Label htmlFor={`package-active-${packageItem.id}`} className="text-sm">
                Active package
              </Label>
              <Switch
                id={`package-active-${packageItem.id}`}
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={isPending}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`package-notes-${packageItem.id}`} className="text-xs">
                Notes
              </Label>
              <Textarea
                id={`package-notes-${packageItem.id}`}
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isPending}
                maxLength={500}
                rows={3}
                className="resize-none"
              />
              {fieldError(state?.fieldErrors, "notes") && (
                <p className="text-xs text-destructive">
                  {fieldError(state?.fieldErrors, "notes")}
                </p>
              )}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || invalid} className="gap-2">
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
