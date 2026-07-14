"use client";

import { useActionState, useCallback, useEffect, useMemo, useState } from "react";
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
import type {
  PatientPackageDepartment,
  PatientPackageService,
  PatientPackageTemplate,
} from "./patient-packages-section";
import { useTranslations } from "next-intl";

interface AddPackageDialogProps {
  patientId: string;
  departments: PatientPackageDepartment[];
  services: PatientPackageService[];
  packageTemplates: PatientPackageTemplate[];
  patientDepartmentId: string | null;
}

function fieldError(
  fieldErrors: Record<string, string[]> | undefined,
  key: string,
) {
  return fieldErrors?.[key]?.[0] ?? null;
}

function templatePrice(template: PatientPackageTemplate) {
  if (template.price_per_session != null) return String(template.price_per_session);
  if (template.total_price != null && template.total_sessions > 0) {
    return (Number(template.total_price) / template.total_sessions).toFixed(2);
  }
  return "";
}

export function AddPackageDialog({
  patientId,
  departments,
  services,
  packageTemplates,
  patientDepartmentId,
}: AddPackageDialogProps) {
  const t = useTranslations("patients");
  const router = useRouter();
  const initialDepartmentId = patientDepartmentId ?? "none";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"template" | "custom">("template");
  const [name, setName] = useState("");
  const [totalSessions, setTotalSessions] = useState("10");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [serviceId, setServiceId] = useState("none");
  const [templateId, setTemplateId] = useState("none");
  const [state, formAction, isPending] = useActionState(
    createPatientPackage,
    null,
  );

  const selectedTemplate = useMemo(
    () => packageTemplates.find((template) => template.id === templateId) ?? null,
    [packageTemplates, templateId],
  );

  const filteredTemplates = useMemo(() => {
    if (departmentId === "none") return [];
    return packageTemplates.filter(
      (template) =>
        template.is_active && template.department_id === departmentId,
    );
  }, [departmentId, packageTemplates]);

  const filteredServices = useMemo(() => {
    if (departmentId === "none") return services;
    return services.filter((service) => service.department_id === departmentId);
  }, [departmentId, services]);

  const resetForm = useCallback(() => {
    setMode("template");
    setName("");
    setTotalSessions("10");
    setPrice("");
    setNotes("");
    setDepartmentId(initialDepartmentId);
    setServiceId("none");
    setTemplateId("none");
  }, [initialDepartmentId]);

  const selectTemplate = (value: string) => {
    setTemplateId(value);
    const template =
      packageTemplates.find((item) => item.id === value) ?? null;

    if (!template) {
      setName("");
      setTotalSessions("10");
      setPrice("");
      setNotes("");
      return;
    }

    setDepartmentId(template.department_id);
    setName(template.name);
    setTotalSessions(String(template.total_sessions));
    setPrice(templatePrice(template));
    setNotes(template.notes ?? "");
    setServiceId("none");
  };

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toast.error(state.error);
      return;
    }
    if (state.success) {
      toast.success(t("packageAdded"));
      router.refresh();
      queueMicrotask(() => {
        setOpen(false);
        resetForm();
      });
    }
  }, [resetForm, router, state]);

  const total = Number(totalSessions);
  const invalid =
    !name.trim() ||
    !Number.isInteger(total) ||
    total <= 0 ||
    (mode === "template" && (departmentId === "none" || templateId === "none"));
  const departmentLocked = Boolean(patientDepartmentId) || Boolean(selectedTemplate);
  const isTemplateMode = mode === "template";

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <PackagePlus className="h-3.5 w-3.5" />
        {t("addPackage")}</Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (isPending) return;
          setOpen(next);
          if (!next) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("addPatientPackage")}</DialogTitle>
            <DialogDescription>
              {t("chooseAPackageTemplateOrCreate")}</DialogDescription>
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

            <div className="space-y-1.5">
              <Label className="text-xs">{t("department")}</Label>
              <Select
                value={departmentId}
                onValueChange={(value) => {
                  setDepartmentId(value);
                  setTemplateId("none");
                  setServiceId("none");
                  if (isTemplateMode) {
                    setName("");
                    setTotalSessions("10");
                    setPrice("");
                    setNotes("");
                  }
                }}
                disabled={isPending || departmentLocked}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("selectDepartment")} />
                </SelectTrigger>
                <SelectContent>
                  {!patientDepartmentId && (
                    <SelectItem value="none">{t("selectDepartment")}</SelectItem>
                  )}
                  {departments.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {patientDepartmentId && (
                <p className="text-xs text-muted-foreground">
                  {t("thisPatientSDepartmentIsUsed")}</p>
              )}
              {fieldError(state?.fieldErrors, "department_id") && (
                <p className="text-xs text-destructive">
                  {fieldError(state?.fieldErrors, "department_id")}
                </p>
              )}
            </div>

            {isTemplateMode ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("packageTemplate")}</Label>
                  <Select
                    value={templateId}
                    onValueChange={selectTemplate}
                    disabled={isPending || departmentId === "none"}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("selectTemplate")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("selectTemplate")}</SelectItem>
                      {filteredTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {departmentId !== "none" && filteredTemplates.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("noActiveTemplatesForThisDepartment")}</p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="package-name" className="text-xs">
                      {t("packageName")}</Label>
                    <Input
                      id="package-name"
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      readOnly={Boolean(selectedTemplate)}
                      disabled={isPending}
                      maxLength={120}
                      placeholder={t("selectedTemplateName")}
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
                      {t("totalSessions")}</Label>
                    <Input
                      id="package-total"
                      name="total_sessions"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={totalSessions}
                      onChange={(event) => setTotalSessions(event.target.value)}
                      readOnly={Boolean(selectedTemplate)}
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
                      {t("pricePerSession")}</Label>
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
                </div>
              </>
            ) : (
              <CustomPackageFields
                state={state}
                isPending={isPending}
                name={name}
                setName={setName}
                totalSessions={totalSessions}
                setTotalSessions={setTotalSessions}
                price={price}
                setPrice={setPrice}
                notes={notes}
                setNotes={setNotes}
                serviceId={serviceId}
                setServiceId={setServiceId}
                filteredServices={filteredServices}
              />
            )}

            {isTemplateMode && (
              <div className="space-y-1.5">
                <Label htmlFor="package-notes" className="text-xs">
                  {t("notes")}</Label>
                <Textarea
                  id="package-notes"
                  name="notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={isPending}
                  maxLength={500}
                  rows={3}
                  className="resize-none"
                  placeholder={t("optionalInternalNotes")}
                />
                {fieldError(state?.fieldErrors, "notes") && (
                  <p className="text-xs text-destructive">
                    {fieldError(state?.fieldErrors, "notes")}
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-start">
              {isTemplateMode ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  disabled={isPending}
                  onClick={() => {
                    setMode("custom");
                    setTemplateId("none");
                    setName("");
                    setTotalSessions("10");
                    setPrice("");
                    setNotes("");
                  }}
                >
                  {t("createCustomPackage")}</Button>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  disabled={isPending}
                  onClick={() => {
                    setMode("template");
                    setTemplateId("none");
                    setServiceId("none");
                    setName("");
                    setTotalSessions("10");
                    setPrice("");
                    setNotes("");
                  }}
                >
                  {t("useAPackageTemplate")}</Button>
              )}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                {t("cancel")}</Button>
              <Button type="submit" disabled={isPending || invalid} className="gap-2">
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("createPackage")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CustomPackageFields({
  state,
  isPending,
  name,
  setName,
  totalSessions,
  setTotalSessions,
  price,
  setPrice,
  notes,
  setNotes,
  serviceId,
  setServiceId,
  filteredServices,
}: {
  state: Awaited<ReturnType<typeof createPatientPackage>> | null;
  isPending: boolean;
  name: string;
  setName: (value: string) => void;
  totalSessions: string;
  setTotalSessions: (value: string) => void;
  price: string;
  setPrice: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  serviceId: string;
  setServiceId: (value: string) => void;
  filteredServices: PatientPackageService[];
}) {
  const t = useTranslations("patients");
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="package-name" className="text-xs">
            {t("packageName")}</Label>
          <Input
            id="package-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isPending}
            maxLength={120}
            placeholder={t("10SessionPhysiotherapyPackage")}
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
            {t("totalSessions")}</Label>
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
            {t("pricePerSession")}</Label>
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

        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">{t("service")}</Label>
          <Select
            value={serviceId}
            onValueChange={setServiceId}
            disabled={isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("optional")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("noService")}</SelectItem>
              {filteredServices.map((service) => (
                <SelectItem key={service.id} value={service.id}>
                  {service.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldError(state?.fieldErrors, "service_id") && (
            <p className="text-xs text-destructive">
              {fieldError(state?.fieldErrors, "service_id")}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="package-notes" className="text-xs">
          {t("notes")}</Label>
        <Textarea
          id="package-notes"
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          disabled={isPending}
          maxLength={500}
          rows={3}
          className="resize-none"
          placeholder={t("optionalInternalNotes")}
        />
        {fieldError(state?.fieldErrors, "notes") && (
          <p className="text-xs text-destructive">
            {fieldError(state?.fieldErrors, "notes")}
          </p>
        )}
      </div>
    </>
  );
}
