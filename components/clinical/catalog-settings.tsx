"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Power } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDrugCatalogEntry, saveLabTestCatalogEntry } from "@/actions/clinical/catalogs";

type Department = { id: string; name: string };
type Drug = { id: string; name: string; form: string | null; strength: string | null; is_controlled: boolean; is_active: boolean; departmentIds: string[] };
type LabTest = { id: string; name: string; is_active: boolean; departmentIds: string[] };

export function ClinicalCatalogSettings({ departments, drugs, tests }: { departments: Department[]; drugs: Drug[]; tests: LabTest[] }) {
  const t = useTranslations("clinical");
  return <div className="grid gap-6 xl:grid-cols-2">
    <DrugCatalogPanel departments={departments} entries={drugs} t={t} />
    <LabCatalogPanel departments={departments} entries={tests} t={t} />
  </div>;
}

type Translator = ReturnType<typeof useTranslations>;
function DepartmentChecks({ departments, selected, onChange, t }: { departments: Department[]; selected: string[]; onChange: (ids: string[]) => void; t: Translator }) {
  return <div className="space-y-2"><Label>{t("departmentScope")}</Label><p className="text-xs text-muted-foreground">{t("emptyDepartmentScope")}</p><div className="grid gap-2 sm:grid-cols-2">{departments.map((department) => <label key={department.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(department.id)} onChange={(event) => onChange(event.target.checked ? [...selected, department.id] : selected.filter((id) => id !== department.id))} />{department.name}</label>)}</div></div>;
}

function DrugCatalogPanel({ departments, entries, t }: { departments: Department[]; entries: Drug[]; t: Translator }) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(""); const [form, setForm] = useState(""); const [strength, setStrength] = useState("");
  const [controlled, setControlled] = useState(false); const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  function save() { startTransition(async () => { const result = await saveDrugCatalogEntry({ name, form, strength, is_controlled: controlled, is_active: true, department_ids: departmentIds }); if (result.error) toast.error(result.error); else { toast.success(t("catalogSaved")); setName(""); setForm(""); setStrength(""); setControlled(false); setDepartmentIds([]); } }); }
  function toggle(entry: Drug) { startTransition(async () => { const result = await saveDrugCatalogEntry({ id: entry.id, name: entry.name, form: entry.form, strength: entry.strength, is_controlled: entry.is_controlled, is_active: !entry.is_active, department_ids: entry.departmentIds }); if (result.error) toast.error(result.error); else toast.success(t("catalogSaved")); }); }
  return <section className="space-y-5 rounded-xl border bg-card p-5"><div><h2 className="font-semibold">{t("drugCatalog")}</h2><p className="text-sm text-muted-foreground">{t("drugCatalogDescription")}</p></div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5 sm:col-span-2"><Label>{t("name")}</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div><div className="space-y-1.5"><Label>{t("form")}</Label><Input value={form} onChange={(event) => setForm(event.target.value)} /></div><div className="space-y-1.5"><Label>{t("strength")}</Label><Input value={strength} onChange={(event) => setStrength(event.target.value)} /></div><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={controlled} onChange={(event) => setControlled(event.target.checked)} />{t("controlledMedicine")}</label><div className="sm:col-span-2"><DepartmentChecks departments={departments} selected={departmentIds} onChange={setDepartmentIds} t={t} /></div></div><Button type="button" onClick={save} disabled={pending || !name.trim()}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t("addCatalogEntry")}</Button><div className="divide-y">{entries.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-medium">{entry.name}</p><p className="text-xs text-muted-foreground">{[entry.form, entry.strength].filter(Boolean).join(" · ") || t("noAdditionalDetails")}</p></div><Button type="button" variant="outline" size="sm" onClick={() => toggle(entry)} disabled={pending}><Power className="size-4" />{entry.is_active ? t("deactivate") : t("activate")}</Button></div>)}</div></section>;
}

function LabCatalogPanel({ departments, entries, t }: { departments: Department[]; entries: LabTest[]; t: Translator }) {
  const [pending, startTransition] = useTransition(); const [name, setName] = useState(""); const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  function save() { startTransition(async () => { const result = await saveLabTestCatalogEntry({ name, is_active: true, department_ids: departmentIds }); if (result.error) toast.error(result.error); else { toast.success(t("catalogSaved")); setName(""); setDepartmentIds([]); } }); }
  function toggle(entry: LabTest) { startTransition(async () => { const result = await saveLabTestCatalogEntry({ id: entry.id, name: entry.name, is_active: !entry.is_active, department_ids: entry.departmentIds }); if (result.error) toast.error(result.error); else toast.success(t("catalogSaved")); }); }
  return <section className="space-y-5 rounded-xl border bg-card p-5"><div><h2 className="font-semibold">{t("labTestCatalog")}</h2><p className="text-sm text-muted-foreground">{t("labCatalogDescription")}</p></div><div className="space-y-3"><div className="space-y-1.5"><Label>{t("name")}</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div><DepartmentChecks departments={departments} selected={departmentIds} onChange={setDepartmentIds} t={t} /></div><Button type="button" onClick={save} disabled={pending || !name.trim()}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t("addCatalogEntry")}</Button><div className="divide-y">{entries.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 py-3"><p className="font-medium">{entry.name}</p><Button type="button" variant="outline" size="sm" onClick={() => toggle(entry)} disabled={pending}><Power className="size-4" />{entry.is_active ? t("deactivate") : t("activate")}</Button></div>)}</div></section>;
}
