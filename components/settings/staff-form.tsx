"use client";

import { startTransition, useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, UserPlus, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InternationalPhoneInput } from "@/components/shared/international-phone-input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createStaffSchema,
  updateStaffSchema,
  type CreateStaffValues,
  type UpdateStaffValues,
} from "@/lib/validations/settings";
import type { ActionResult } from "@/actions/settings";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";
import { useTranslations } from "next-intl";

type Department = Pick<Tables<"departments">, "id" | "name">;
type DoctorOption = { id: string; full_name: string };
type StaffRole = "admin" | "doctor" | "receptionist" | "manager" | "assistant";

function usesDepartment(role: StaffRole) {
  // Assistants are scoped by doctor assignment, not by department.
  return role !== "admin" && role !== "manager" && role !== "assistant";
}

/**
 * Multi-select of supervising doctors, shown only for the assistant role. Drives
 * the assistant's data scope (union of assigned doctors). Purely presentational;
 * the server re-validates every id against same-clinic active doctors.
 */
function SupervisingDoctorsField({
  doctors,
  value,
  onChange,
  disabled,
  label,
  emptyLabel,
}: {
  doctors: DoctorOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label: string;
  emptyLabel: string;
}) {
  function toggle(id: string, checked: boolean) {
    if (checked) onChange(Array.from(new Set([...value, id])));
    else onChange(value.filter((v) => v !== id));
  }
  return (
    <FormItem className="sm:col-span-2">
      <FormLabel>{label}</FormLabel>
      {doctors.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-lg border border-border/60 p-3 sm:grid-cols-2">
          {doctors.map((doctor) => {
            const checked = value.includes(doctor.id);
            return (
              <label
                key={doctor.id}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4 rounded border-border"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(doctor.id, e.target.checked)}
                />
                <span className="truncate">{doctor.full_name}</span>
              </label>
            );
          })}
        </div>
      )}
      <FormMessage />
    </FormItem>
  );
}

// ── Create staff form ────────────────────────────────────────────────────────

interface CreatedSnapshot {
  full_name: string;
  role: string;
  department_name: string | null;
  phone: string | null;
}

interface CreateStaffFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  departments: Department[];
  doctors: DoctorOption[];
  canCreateAdmin?: boolean;
  onSuccess?: () => void;
  onCreated?: (staffId: string, snapshot: CreatedSnapshot) => void;
}

export function CreateStaffForm({
  action,
  departments,
  doctors,
  canCreateAdmin = true,
  onSuccess,
  onCreated,
}: CreateStaffFormProps) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  const form = useForm<CreateStaffValues>({
    resolver: zodResolver(createStaffSchema),
    defaultValues: {
      full_name: "",
      email: "",
      temporary_password: "",
      role: "receptionist",
      department_id: null,
      supervising_doctor_ids: [],
      phone: "",
    },
  });
  const selectedRole = useWatch({ control: form.control, name: "role" });
  const showDepartment = usesDepartment(selectedRole);
  const showSupervisingDoctors = selectedRole === "assistant";

  useEffect(() => {
    if (!showDepartment) {
      form.setValue("department_id", null, { shouldValidate: true });
    }
  }, [form, showDepartment]);

  useEffect(() => {
    if (state?.success) {
      toast.success(t("staffMemberCreatedTheyWillBe"));
      if (state.staffId && onCreated) {
        const values = form.getValues();
        const deptName =
          departments.find((d) => d.id === values.department_id)?.name ?? null;
        onCreated(state.staffId, {
          full_name: values.full_name,
          role: values.role,
          department_name: deptName,
          phone: values.phone ?? null,
        });
      } else {
        form.reset();
        router.refresh();
        onSuccess?.();
      }
    }
  }, [state, form, router, onSuccess, onCreated, departments]);

  function onSubmit(values: CreateStaffValues) {
    const fullName =
      values.role === "doctor"
        ? formatDoctorName(values.full_name)
        : values.full_name.trim();

    const fd = new FormData();
    fd.set("full_name", fullName);
    fd.set("email", values.email);
    fd.set("temporary_password", values.temporary_password);
    fd.set("role", values.role);
    if (usesDepartment(values.role) && values.department_id) {
      fd.set("department_id", values.department_id);
    }
    if (values.role === "assistant") {
      for (const id of values.supervising_doctor_ids ?? []) {
        fd.append("supervising_doctor_ids", id);
      }
    }
    if (values.phone) fd.set("phone", values.phone);
    startTransition(() => formAction(fd));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="full_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fullName")}</FormLabel>
                <FormControl>
                  <Input {...field} disabled={isPending} placeholder={t("drAyEKaya")} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("email")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    disabled={isPending}
                    placeholder={t("ayseClinicCom")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="temporary_password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("temporaryPassword")}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="password"
                    autoComplete="new-password"
                    disabled={isPending}
                    placeholder={t("clinic123")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("role")}</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {canCreateAdmin && <SelectItem value="admin">{t("admin")}</SelectItem>}
                    <SelectItem value="doctor">{t("doctor")}</SelectItem>
                    <SelectItem value="receptionist">{t("receptionist")}</SelectItem>
                    <SelectItem value="manager">{t("manager")}</SelectItem>
                    <SelectItem value="assistant">{t("roleAssistant")}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {showSupervisingDoctors && (
            <FormField
              control={form.control}
              name="supervising_doctor_ids"
              render={({ field }) => (
                <SupervisingDoctorsField
                  doctors={doctors}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  disabled={isPending}
                  label={t("supervisingDoctors")}
                  emptyLabel={t("noDoctorsToAssign")}
                />
              )}
            />
          )}
          {showDepartment && (
            <FormField
              control={form.control}
              name="department_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("departmentOptional")}</FormLabel>
                  <Select
                    value={field.value ?? "__none__"}
                    onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                    disabled={isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t("none")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">{t("none")}</SelectItem>
                      {departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>{t("phoneOptional")}</FormLabel>
                <FormControl>
                  <InternationalPhoneInput
                    {...field}
                    name={undefined}
                    value={field.value ?? ""}
                    disabled={isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {t("createStaffMember")}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ── Edit staff form ──────────────────────────────────────────────────────────

interface EditStaffFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  departments: Department[];
  doctors: DoctorOption[];
  defaultValues: UpdateStaffValues;
  initialSupervisingDoctorIds?: string[];
  onSuccess?: () => void;
}

export function EditStaffForm({
  action,
  departments,
  doctors,
  defaultValues,
  initialSupervisingDoctorIds = [],
  onSuccess,
}: EditStaffFormProps) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  const form = useForm<UpdateStaffValues>({
    resolver: zodResolver(updateStaffSchema),
    defaultValues: {
      ...defaultValues,
      supervising_doctor_ids: initialSupervisingDoctorIds,
    },
  });
  const selectedRole = useWatch({ control: form.control, name: "role" });
  const showDepartment = usesDepartment(selectedRole);
  const showSupervisingDoctors = selectedRole === "assistant";

  useEffect(() => {
    if (!showDepartment) {
      form.setValue("department_id", null, { shouldValidate: true });
    }
  }, [form, showDepartment]);

  useEffect(() => {
    if (state?.success) {
      toast.success(t("staffMemberUpdated"));
      router.refresh();
      onSuccess?.();
    }
  }, [state, router, onSuccess]);

  function onSubmit(values: UpdateStaffValues) {
    const fullName =
      values.role === "doctor"
        ? formatDoctorName(values.full_name)
        : values.full_name.trim();

    const fd = new FormData();
    fd.set("full_name", fullName);
    fd.set("role", values.role);
    if (usesDepartment(values.role) && values.department_id) {
      fd.set("department_id", values.department_id);
    }
    if (values.role === "assistant") {
      for (const id of values.supervising_doctor_ids ?? []) {
        fd.append("supervising_doctor_ids", id);
      }
    }
    if (values.phone) fd.set("phone", values.phone);
    fd.set("is_active", String(values.is_active));
    startTransition(() => formAction(fd));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="full_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("fullName")}</FormLabel>
                <FormControl>
                  <Input {...field} disabled={isPending} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("role")}</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="admin">{t("admin")}</SelectItem>
                    <SelectItem value="doctor">{t("doctor")}</SelectItem>
                    <SelectItem value="receptionist">{t("receptionist")}</SelectItem>
                    <SelectItem value="manager">{t("manager")}</SelectItem>
                    <SelectItem value="assistant">{t("roleAssistant")}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {showSupervisingDoctors && (
            <FormField
              control={form.control}
              name="supervising_doctor_ids"
              render={({ field }) => (
                <SupervisingDoctorsField
                  doctors={doctors}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  disabled={isPending}
                  label={t("supervisingDoctors")}
                  emptyLabel={t("noDoctorsToAssign")}
                />
              )}
            />
          )}
          {showDepartment && (
            <FormField
              control={form.control}
              name="department_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("department")}</FormLabel>
                  <Select
                    value={field.value ?? "__none__"}
                    onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                    disabled={isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t("none")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">{t("none")}</SelectItem>
                      {departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("phone")}</FormLabel>
                <FormControl>
                  <InternationalPhoneInput
                    {...field}
                    name={undefined}
                    value={field.value ?? ""}
                    disabled={isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="is_active"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>{t("status")}</FormLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(v === "true")}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="true">{t("active")}</SelectItem>
                    <SelectItem value="false">{t("deactivated")}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("saveChanges")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
