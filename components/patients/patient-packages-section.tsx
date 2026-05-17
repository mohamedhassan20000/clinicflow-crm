"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Package, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { deactivatePatientPackage } from "@/actions/patient-packages";
import { AddPackageDialog } from "@/components/patients/add-package-dialog";
import { EditPackageDialog } from "@/components/patients/edit-package-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PatientPackageDepartment = {
  id: string;
  name: string;
  color: string | null;
};

export type PatientPackageService = {
  id: string;
  name: string;
  department_id: string | null;
};

export type PatientPackageItem = {
  id: string;
  patient_id: string;
  department_id: string | null;
  service_id: string | null;
  name: string;
  total_sessions: number;
  used_sessions: number;
  price_per_session: number | null;
  notes: string | null;
  is_active: boolean;
  departments: PatientPackageDepartment | null;
  services: { id: string; name: string } | null;
};

export type PatientPackageTemplate = {
  id: string;
  department_id: string;
  name: string;
  total_sessions: number;
  price_per_session: number | null;
  total_price: number | null;
  notes: string | null;
  is_active: boolean;
};

interface PatientPackagesSectionProps {
  patientId: string;
  packages: PatientPackageItem[];
  departments: PatientPackageDepartment[];
  services: PatientPackageService[];
  packageTemplates: PatientPackageTemplate[];
  patientDepartmentId: string | null;
  canManage: boolean;
}

function fmtTRY(value: number | null) {
  if (value == null) return "Not set";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export function PatientPackagesSection({
  patientId,
  packages,
  departments,
  services,
  packageTemplates,
  patientDepartmentId,
  canManage,
}: PatientPackagesSectionProps) {
  const activeCount = packages.filter((pkg) => pkg.is_active).length;

  return (
    <section className="space-y-3 print:hidden" aria-labelledby="patient-packages-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="patient-packages-heading"
            className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <Package className="h-4 w-4" />
            Packages
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {activeCount} active of {packages.length} total
          </p>
        </div>
        {canManage && (
          <AddPackageDialog
            patientId={patientId}
            departments={departments}
            services={services}
            packageTemplates={packageTemplates}
            patientDepartmentId={patientDepartmentId}
          />
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        {packages.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <Archive className="mx-auto h-6 w-6 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">No packages yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Session bundles created for this patient will appear here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {packages.map((pkg) => (
              <PackageRow
                key={pkg.id}
                packageItem={pkg}
                departments={departments}
                services={services}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PackageRow({
  packageItem,
  departments,
  services,
  canManage,
}: {
  packageItem: PatientPackageItem;
  departments: PatientPackageDepartment[];
  services: PatientPackageService[];
  canManage: boolean;
}) {
  const remaining = Math.max(
    0,
    packageItem.total_sessions - packageItem.used_sessions,
  );
  const progress =
    packageItem.total_sessions > 0
      ? Math.min(100, (packageItem.used_sessions / packageItem.total_sessions) * 100)
      : 0;
  const department = packageItem.departments;
  const service = packageItem.services;

  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold">
            {packageItem.name}
          </h3>
          <Badge
            variant={packageItem.is_active ? "default" : "secondary"}
            className={cn(
              "h-5 px-2 text-[10px]",
              packageItem.is_active
                ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            {packageItem.is_active ? "Active" : "Inactive"}
          </Badge>
          {department && (
            <Badge variant="outline" className="h-5 gap-1 px-2 text-[10px]">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: department.color ?? "currentColor" }}
              />
              {department.name}
            </Badge>
          )}
          {service && (
            <Badge variant="outline" className="h-5 px-2 text-[10px]">
              {service.name}
            </Badge>
          )}
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-4">
          <Metric label="Total" value={packageItem.total_sessions} />
          <Metric label="Used" value={packageItem.used_sessions} />
          <Metric label="Remaining" value={remaining} />
          <Metric
            label="Price/session"
            value={fmtTRY(packageItem.price_per_session)}
          />
        </div>

        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                remaining > 0 ? "bg-primary" : "bg-muted-foreground/50",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          {packageItem.notes && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {packageItem.notes}
            </p>
          )}
        </div>
      </div>

      {canManage && (
        <div className="flex items-center gap-1 sm:justify-end">
          <EditPackageDialog
            packageItem={packageItem}
            departments={departments}
            services={services}
          />
          {packageItem.is_active && (
            <DeactivatePackageButton packageId={packageItem.id} />
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function DeactivatePackageButton({ packageId }: { packageId: string }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    deactivatePatientPackage,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toast.error(state.error);
      return;
    }
    if (state.success) {
      toast.success("Package deactivated.");
      router.refresh();
    }
  }, [router, state]);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <PowerOff className="h-3 w-3" />
          )}
          Deactivate
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate package?</AlertDialogTitle>
          <AlertDialogDescription>
            This keeps the package history but hides it from active package lists.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <form action={formAction}>
            <input type="hidden" name="package_id" value={packageId} />
            <AlertDialogAction asChild>
              <Button
                type="submit"
                variant="destructive"
                disabled={isPending}
                className="gap-2"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Deactivate
              </Button>
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
