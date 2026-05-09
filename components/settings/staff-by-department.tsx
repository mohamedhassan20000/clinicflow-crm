"use client";

import { useMemo } from "react";
import { Users } from "lucide-react";
import { StaffTable, type StaffMember } from "@/components/settings/staff-table";
import type { Tables } from "@/types/database";

type DepartmentLite = Pick<Tables<"departments">, "id" | "name"> & {
  color?: string | null;
};

interface Props {
  staff: StaffMember[];
  departments: DepartmentLite[];
  currentUserId: string;
}

const UNASSIGNED_COLOR = "#94a3b8"; // slate-400
const MANAGEMENT_COLOR = "#0f766e"; // teal-700

function isManagementRole(role: string) {
  return role === "admin" || role === "manager";
}

export function StaffByDepartment({
  staff,
  departments,
  currentUserId,
}: Props) {
  const groups = useMemo(() => {
    const byDept = new Map<string, StaffMember[]>();
    for (const dept of departments) byDept.set(dept.id, []);
    const management: StaffMember[] = [];
    const unassigned: StaffMember[] = [];

    for (const member of staff) {
      if (isManagementRole(member.role)) {
        management.push(member);
        continue;
      }
      if (member.department_id && byDept.has(member.department_id)) {
        byDept.get(member.department_id)!.push(member);
      } else {
        unassigned.push(member);
      }
    }
    return { byDept, management, unassigned };
  }, [staff, departments]);

  // For dropdowns inside StaffTable
  const deptOptions = departments.map(({ id, name }) => ({ id, name }));

  return (
    <div className="space-y-6">
      {groups.management.length > 0 && (
        <DepartmentSection
          name="Management / Administration"
          color={MANAGEMENT_COLOR}
          count={groups.management.length}
          subtitle="Admin and manager accounts"
        >
          <StaffTable
            staff={groups.management}
            departments={deptOptions}
            currentUserId={currentUserId}
          />
        </DepartmentSection>
      )}

      {departments.map((dept) => {
        const members = groups.byDept.get(dept.id) ?? [];
        const color = dept.color ?? UNASSIGNED_COLOR;
        return (
          <DepartmentSection
            key={dept.id}
            name={dept.name}
            color={color}
            count={members.length}
          >
            {members.length === 0 ? (
              <EmptyState
                color={color}
                message={`No staff assigned to ${dept.name} yet.`}
              />
            ) : (
              <StaffTable
                staff={members}
                departments={deptOptions}
                currentUserId={currentUserId}
              />
            )}
          </DepartmentSection>
        );
      })}

      {groups.unassigned.length > 0 && (
        <DepartmentSection
          name="Unassigned"
          color={UNASSIGNED_COLOR}
          count={groups.unassigned.length}
          subtitle="Members not currently linked to a department"
        >
          <StaffTable
            staff={groups.unassigned}
            departments={deptOptions}
            currentUserId={currentUserId}
          />
        </DepartmentSection>
      )}

      {departments.length === 0 &&
        groups.management.length === 0 &&
        groups.unassigned.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          No staff members yet. Add a department first, then create staff
          accounts.
        </div>
      )}
    </div>
  );
}

function DepartmentSection({
  name,
  color,
  count,
  subtitle,
  children,
}: {
  name: string;
  color: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      style={{ borderColor: `color-mix(in oklab, ${color} 35%, transparent)` }}
    >
      <header
        className="flex items-center justify-between gap-3 px-4 py-3 border-b"
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
          borderColor: `color-mix(in oklab, ${color} 25%, transparent)`,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: color }}
          />
          <div>
            <h3
              className="text-sm font-semibold tracking-tight"
              style={{ color }}
            >
              {name}
            </h3>
            {subtitle && (
              <p className="text-[11px] text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
          style={{
            backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
            color,
          }}
        >
          <Users className="h-3 w-3" />
          {count} member{count !== 1 ? "s" : ""}
        </span>
      </header>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function EmptyState({
  color,
  message,
}: {
  color: string;
  message: string;
}) {
  return (
    <div
      className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground"
      style={{
        borderColor: `color-mix(in oklab, ${color} 30%, transparent)`,
      }}
    >
      {message}
    </div>
  );
}
