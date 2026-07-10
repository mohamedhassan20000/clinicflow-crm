import { completeOnboarding } from "@/actions/early-access";
import { getClinicWorkingHours } from "@/actions/settings";
import { AddDepartmentDialog } from "@/components/settings/add-department-dialog";
import { AddInsuranceDialog } from "@/components/settings/add-insurance-dialog";
import { AddServiceDialog } from "@/components/settings/add-service-dialog";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";
import { ClinicWorkingHoursForm } from "@/components/settings/clinic-working-hours-form";
import { StaffByDepartment } from "@/components/settings/staff-by-department";
import { Button } from "@/components/ui/button";
import { getCachedDepartments, getCachedStaff } from "@/lib/cache/reference-data";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { requireRole } from "@/lib/rbac";

export default async function OnboardingPage() {
  const user = await requireRole("admin");
  const [workingHours, cachedDepartments, cachedStaff, canCustomize] = await Promise.all([
    getClinicWorkingHours(),
    getCachedDepartments(user.clinicId),
    getCachedStaff(user.clinicId),
    isPrimaryClinicAdmin(user.id, user.clinicId),
  ]);
  const departments = cachedDepartments.filter((department) => !department.deleted_at && department.is_active);
  const staff = cachedStaff.filter((member) => !member.deleted_at);

  return <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-10">
    <header><p className="text-sm font-medium text-primary">Clinic setup</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Build your clinic workspace</h1><p className="mt-2 text-muted-foreground">These steps are safe to repeat. Add what you need now; you can refine everything later in Settings.</p></header>

    <section className="rounded-xl border bg-card p-6"><h2 className="text-xl font-semibold">1. Working hours</h2><p className="mb-5 mt-1 text-sm text-muted-foreground">Set the hours used for appointment availability.</p><ClinicWorkingHoursForm defaultValues={workingHours} /></section>

    <section className="rounded-xl border bg-card p-6"><h2 className="text-xl font-semibold">2. Departments and services</h2><p className="mb-5 mt-1 text-sm text-muted-foreground">Create your care structure and price list.</p><div className="flex flex-wrap gap-3"><AddDepartmentDialog /><AddServiceDialog departments={departments} /><AddInsuranceDialog /></div></section>

    <section className="rounded-xl border bg-card p-6"><h2 className="text-xl font-semibold">3. Doctors, staff, and schedules</h2><p className="mb-5 mt-1 text-sm text-muted-foreground">Invite your team, then open a doctor profile below to configure the doctor schedule.</p><div className="mb-5"><AddStaffDialog departments={departments} currentRole={user.role} canCustomize={canCustomize} /></div><StaffByDepartment staff={staff as Parameters<typeof StaffByDepartment>[0]["staff"]} departments={departments} currentUserId={user.id} isAdmin /></section>

    <section className="rounded-xl border border-primary/30 bg-primary/5 p-6"><h2 className="text-xl font-semibold">Ready to start</h2><p className="mb-5 mt-1 text-sm text-muted-foreground">Completing setup unlocks the dashboard. This action is idempotent.</p><form action={completeOnboarding}><Button size="lg">Complete setup</Button></form></section>
  </div>;
}
