"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, UserPlus, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type Department = Pick<Tables<"departments">, "id" | "name">;

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
  onSuccess?: () => void;
  onCreated?: (staffId: string, snapshot: CreatedSnapshot) => void;
}

export function CreateStaffForm({
  action,
  departments,
  onSuccess,
  onCreated,
}: CreateStaffFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  const form = useForm<CreateStaffValues>({
    resolver: zodResolver(createStaffSchema),
    defaultValues: {
      full_name: "",
      email: "",
      role: "receptionist",
      department_id: null,
      phone: "",
    },
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Staff member created. They will be prompted to set their password on first login.");
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
    // Auto-prefix "Dr. " when role is doctor (unless already present)
    const fullName =
      values.role === "doctor" && !/^dr\.?\s/i.test(values.full_name.trim())
        ? `Dr. ${values.full_name.trim()}`
        : values.full_name.trim();

    const fd = new FormData();
    fd.set("full_name", fullName);
    fd.set("email", values.email);
    fd.set("role", values.role);
    if (values.department_id) fd.set("department_id", values.department_id);
    if (values.phone) fd.set("phone", values.phone);
    formAction(fd);
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
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input {...field} disabled={isPending} placeholder="Dr. Ayşe Kaya" />
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
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    disabled={isPending}
                    placeholder="ayse@clinic.com"
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
                <FormLabel>Role</FormLabel>
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
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="doctor">Doctor</SelectItem>
                    <SelectItem value="receptionist">Receptionist</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Department (optional)</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
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
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>Phone (optional)</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    disabled={isPending}
                    placeholder="0532 000 00 00"
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
            Create staff member
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
  defaultValues: UpdateStaffValues;
  onSuccess?: () => void;
}

export function EditStaffForm({
  action,
  departments,
  defaultValues,
  onSuccess,
}: EditStaffFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  const form = useForm<UpdateStaffValues>({
    resolver: zodResolver(updateStaffSchema),
    defaultValues,
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Staff member updated.");
      router.refresh();
      onSuccess?.();
    }
  }, [state, router, onSuccess]);

  function onSubmit(values: UpdateStaffValues) {
    const fullName =
      values.role === "doctor" && !/^dr\.?\s/i.test(values.full_name.trim())
        ? `Dr. ${values.full_name.trim()}`
        : values.full_name.trim();

    const fd = new FormData();
    fd.set("full_name", fullName);
    fd.set("role", values.role);
    if (values.department_id) fd.set("department_id", values.department_id);
    if (values.phone) fd.set("phone", values.phone);
    fd.set("is_active", String(values.is_active));
    formAction(fd);
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
                <FormLabel>Full name</FormLabel>
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
                <FormLabel>Role</FormLabel>
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
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="doctor">Doctor</SelectItem>
                    <SelectItem value="receptionist">Receptionist</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Department</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
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
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input
                    {...field}
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
                <FormLabel>Status</FormLabel>
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
                    <SelectItem value="true">Active</SelectItem>
                    <SelectItem value="false">Deactivated</SelectItem>
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
            Save changes
          </Button>
        </div>
      </form>
    </Form>
  );
}
