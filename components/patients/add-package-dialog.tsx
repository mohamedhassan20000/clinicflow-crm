"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { createPatientPackage } from "@/actions/patient-packages";
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
import { Textarea } from "@/components/ui/textarea";
import type { PatientPackageDepartment, PatientPackageService } from "./patient-packages-section";

interface AddPackageDialogProps {
  patientId: string;
  departments: PatientPackageDepartment[];
  services: PatientPackageService[];
}

function fieldError(
  fieldErrors: Record<string, string[]> | undefined,
  key: string,
) {
  return fieldErrors?.[key]?.[0] ?? null;
}

export function AddPackageDialog({
  patientId,
  departments,
  services,
}: AddPackageDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [totalSessions, setTotalSessions] = useState("10");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [departmentId, setDepartmentId] = useState("none");
  const [serviceId, setServiceId] = useState("none");
  const [state, formAction, isPending] = useActionState(
    createPatientPackage,
    null,
  );

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
      toast.success("Package added.");
      router.refresh();
      queueMicrotask(() => {
        setOpen(false);
        setName("");
        setTotalSessions("10");
        setPrice("");
        setNotes("");
        setDepartmentId("none");
        setServiceId("none");
      });
    }
  }, [router, state]);

  const total = Number(totalSessions);
  const invalid = !name.trim() || !Number.isInteger(total) || total <= 0;

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <PackagePlus className="h-3.5 w-3.5" />
        Add package
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
            <DialogTitle>Add patient package</DialogTitle>
            <DialogDescription>
              Create a prepaid session bundle for this patient.
            </DialogDescription>
          </DialogHeader>

          <form action={formAction} className="space-y-4">
            <input type="hidden" name="patient_id" value={patientId} />
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
                <Label htmlFor="package-name" className="text-xs">
                  Package name
                </Label>
                <Input
                  id="package-name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isPending}
                  maxLength={120}
                  placeholder="10-session physiotherapy package"
                  autoFocus
                  aria-invalid={Boolean(fieldError(state?.fieldErrors, "name"))}
                />
                {fieldError(state?.fieldErrors, "name") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "name")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="package-total" className="text-xs">
                  Total sessions
                </Label>
                <Input
                  id="package-total"
                  name="total_sessions"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={totalSessions}
                  onChange={(event) => setTotalSessions(event.target.value)}
                  disabled={isPending}
                  aria-invalid={Boolean(
                    fieldError(state?.fieldErrors, "total_sessions"),
                  )}
                />
                {fieldError(state?.fieldErrors, "total_sessions") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "total_sessions")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="package-price" className="text-xs">
                  Price per session
                </Label>
                <Input
                  id="package-price"
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

            <div className="space-y-1.5">
              <Label htmlFor="package-notes" className="text-xs">
                Notes
              </Label>
              <Textarea
                id="package-notes"
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isPending}
                maxLength={500}
                rows={3}
                className="resize-none"
                placeholder="Optional internal notes"
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
                Create package
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
