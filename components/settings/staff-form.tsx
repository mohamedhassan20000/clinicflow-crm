"use client";

import { useActionState, useEffect } from "react";
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

interface CreateStaffFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  departments: Department[];
  onSuccess?: () => void;
}

export function CreateStaffForm({
  action,
  departments,
  onSuccess,
}: CreateStaffFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);

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
      form.reset();
      onSuccess?.();
    }
  }, [state, form, onSuccess]);

  function onSubmit(values: CreateStaffValues) {
    const fd = new FormData();
    fd.set("full_name", values.full_name);
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
                  value={field.value ?? ""}
                  onValueChange={(v) => field.onChange(v || null)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
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

  const form = useForm<UpdateStaffValues>({
    resolver: zodResolver(updateStaffSchema),
    defaultValues,
  });

  useEffect(() => {
    if (state?.success) {
      toast.success("Staff member updated.");
      onSuccess?.();
    }
  }, [state, onSuccess]);

  function onSubmit(values: UpdateStaffValues) {
    const fd = new FormData();
    fd.set("full_name", values.full_name);
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
                  value={field.value ?? ""}
                  onValueChange={(v) => field.onChange(v || null)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
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
