"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PackageTemplateActionResult } from "@/actions/package-templates";
import {
  packageItemSubtotal,
  packageItemsTotal,
} from "@/lib/validations/package-template";
import { useTranslations } from "next-intl";

/**
 * An active service a package line may name.
 *
 * `price` is the service's *current* catalogue price and is used for exactly
 * one thing: seeding a line's package price the moment somebody picks the
 * service. It is never written back, and a line's price is never recomputed
 * from it afterwards — a package is a commercial decision the clinic made on a
 * day, and a later price change on the service must not silently reprice every
 * package that contains it.
 */
export interface PackageServiceOption {
  id: string;
  name: string;
  department_id: string;
  price: number | null;
}

export interface PackageTemplateFormItem {
  service_id: string;
  sessions: number;
  price_per_session: number;
}

export interface PackageTemplateFormDefaults {
  id?: string;
  department_id?: string;
  items?: PackageTemplateFormItem[];
  name?: string;
  total_sessions?: number;
  price_per_session?: number | null;
  total_price?: number | null;
  notes?: string | null;
  name_ar?: string | null;
  name_en?: string | null;
}

interface Props {
  action: (
    prev: PackageTemplateActionResult | null,
    fd: FormData,
  ) => Promise<PackageTemplateActionResult>;
  departments: { id: string; name: string; color: string }[];
  /** Active services across the clinic. Filtered to the chosen department here. */
  services?: PackageServiceOption[];
  defaults?: PackageTemplateFormDefaults;
  submitLabel: string;
  onSuccess?: () => void;
}

/** One editable line. `key` is local and exists so removing a middle row does
 *  not renumber the rows below it and reset their inputs. */
interface Row {
  key: string;
  serviceId: string;
  sessions: string;
  price: string;
}

const numberOr = (value: string, fallback: number) => {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * A monotonic source of local row keys.
 *
 * Module scope rather than a ref, because the first keys are needed inside the
 * `useState` initializer — which runs during render, where a ref may not be
 * read. The keys only have to be unique within one mounted list, and a counter
 * that never repeats is unique across every list at once.
 */
let rowKeySeed = 0;
const makeKey = () => `row-${(rowKeySeed += 1)}`;

/** Two decimals, or an em dash when there is nothing to show. */
const money = (value: number | null) =>
  value === null ? "—" : (Math.round(value * 100) / 100).toString();

export function PackageTemplateForm({
  action,
  departments,
  services = [],
  defaults,
  submitLabel,
  onSuccess,
}: Props) {
  const t = useTranslations("settings");
  const [state, formAction, isPending] = useActionState(action, null);
  const [departmentId, setDepartmentId] = useState(defaults?.department_id ?? "");
  const [rows, setRows] = useState<Row[]>(() =>
    (defaults?.items ?? []).map((item) => ({
      key: makeKey(),
      serviceId: item.service_id,
      sessions: String(item.sessions),
      price: String(item.price_per_session),
    })),
  );

  // The legacy, item-less package's own three numbers. They stay exactly as
  // they are today, and are only in play while the package has no lines.
  const [sessions, setSessions] = useState(
    defaults?.total_sessions === undefined ? "" : String(defaults.total_sessions),
  );
  const [pricePerSession, setPricePerSession] = useState(
    defaults?.price_per_session === null || defaults?.price_per_session === undefined
      ? ""
      : String(defaults.price_per_session),
  );
  const [totalPrice, setTotalPrice] = useState(
    defaults?.total_price === null || defaults?.total_price === undefined
      ? ""
      : String(defaults.total_price),
  );
  /**
   * Whether a person has typed in the item-less package's total.
   *
   * The derivation is one-way — sessions x price per session fills the total —
   * and it stops the moment somebody overrides it. Recomputing the price from
   * an edited total as well would make the two fields chase each other, and an
   * intentional package discount typed as a round total would be rewritten on
   * the next keystroke anywhere else on the form.
   */
  const totalEdited = useRef(
    defaults?.total_price !== null && defaults?.total_price !== undefined,
  );

  const departmentServices = useMemo(
    () => services.filter((service) => service.department_id === departmentId),
    [services, departmentId],
  );
  const serviceById = useMemo(
    () => new Map(services.map((service) => [service.id, service])),
    [services],
  );

  /**
   * The lines, as numbers, for the arithmetic below.
   *
   * A row whose service is still unpicked is not a line — it is somebody
   * part-way through adding one — so it contributes nothing to the totals and
   * the action drops it from the payload for the same reason.
   */
  const items = useMemo(
    () =>
      rows
        .filter((row) => row.serviceId !== "")
        .map((row) => ({
          sessions: numberOr(row.sessions, 0),
          price_per_session: numberOr(row.price, 0),
        })),
    [rows],
  );
  const itemsTotal = packageItemsTotal(items);
  const itemsSessions =
    items.length === 0
      ? null
      : items.reduce((sum, item) => sum + item.sessions, 0);
  /** Lines are the input and the roll-up is the output. One direction, no cycle. */
  const hasItems = items.length > 0;

  function addRow() {
    setRows((current) => [
      ...current,
      { key: makeKey(), serviceId: "", sessions: "1", price: "" },
    ]);
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  function patchRow(key: string, patch: Partial<Omit<Row, "key">>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  /** sessions x price per session, when both are real numbers. */
  function derivedTotal(count: string, each: string): string {
    const n = Number(count);
    const price = Number(each);
    if (!Number.isFinite(n) || !Number.isFinite(price) || count === "" || each === "") {
      return "";
    }
    if (n <= 0 || price < 0) return "";
    return String(Math.round(n * price * 100) / 100);
  }

  function applyDerivedTotal(count: string, each: string) {
    if (totalEdited.current) return;
    setTotalPrice(derivedTotal(count, each));
  }

  useEffect(() => {
    if (!state) return;
    if (state.error) toast.error(state.error);
    else if (state.fieldErrors) {
      const first = Object.values(state.fieldErrors).flat()[0];
      if (first) toast.error(first);
    } else if (state.success) {
      toast.success(t("saved"));
      onSuccess?.();
    }
  }, [state, onSuccess]);

  return (
    <form action={formAction} className="space-y-4">
      {defaults?.id ? (
        <input type="hidden" name="template_id" value={defaults.id} />
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-department" className="text-xs">
          {t("department")}</Label>
        <Select
          name="department_id"
          value={departmentId}
          onValueChange={(value) => {
            setDepartmentId(value);
            // A service belongs to exactly one department, so a line carried
            // over from the old one is not merely stale — it is wrong, and the
            // database refuses it: `package_template_items` keys the package's
            // department into both of its foreign keys. Dropping those lines is
            // the only correct answer.
            setRows((current) =>
              current.filter(
                (row) =>
                  row.serviceId === "" ||
                  serviceById.get(row.serviceId)?.department_id === value,
              ),
            );
          }}
          disabled={isPending}
          required
        >
          <SelectTrigger id="pkg-tpl-department">
            <SelectValue placeholder={t("selectDepartment")} />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-name" className="text-xs">
          {t("templateName")}</Label>
        <Input
          id="pkg-tpl-name"
          name="name"
          placeholder={t("eG10SessionPhysioPackage")}
          defaultValue={defaults?.name}
          required
          minLength={1}
          maxLength={120}
          disabled={isPending}
        />
      </div>

      {/* The names patients see, in each language. `name` above stays the
          clinic's canonical record; these are display only, and nothing
          generates them — an empty field means "use the stored name". */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pkg-tpl-name-ar" className="text-xs">
            {t("displayNameArabic")}</Label>
          <Input
            id="pkg-tpl-name-ar"
            name="name_ar"
            dir="rtl"
            maxLength={120}
            defaultValue={defaults?.name_ar ?? ""}
            disabled={isPending}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pkg-tpl-name-en" className="text-xs">
            {t("displayNameEnglish")}</Label>
          <Input
            id="pkg-tpl-name-en"
            name="name_en"
            dir="ltr"
            maxLength={120}
            defaultValue={defaults?.name_en ?? ""}
            disabled={isPending}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("displayNameHint")}</p>

      {/* ------------------------------------------------------------------ */}
      {/* The package's contents: zero, one or many services from the chosen  */}
      {/* department. Zero is the ordinary shape for every package that       */}
      {/* exists today and stays fully supported.                            */}
      {/* ------------------------------------------------------------------ */}
      <fieldset className="space-y-3 rounded-lg border border-border/50 p-3">
        <legend className="px-1 text-xs font-semibold">{t("packageServices")}</legend>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("packageServicesHint")}</p>
        ) : null}

        {rows.map((row) => {
          const picked = row.serviceId === "" ? null : serviceById.get(row.serviceId) ?? null;
          // Already spoken for by another line: one line per service, which is
          // the table's own `package_template_items_service_once` constraint.
          const takenElsewhere = new Set(
            rows.filter((other) => other.key !== row.key).map((other) => other.serviceId),
          );
          const subtotal =
            row.serviceId === ""
              ? null
              : packageItemSubtotal({
                  sessions: numberOr(row.sessions, 0),
                  price_per_session: numberOr(row.price, 0),
                });
          return (
            <div
              key={row.key}
              className="grid grid-cols-1 items-end gap-2 rounded-md bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_auto]"
            >
              <div className="space-y-1">
                <Label className="text-[11px]">{t("serviceOptional")}</Label>
                <Select
                  value={row.serviceId}
                  onValueChange={(value) => {
                    const service = serviceById.get(value) ?? null;
                    // The service's current price seeds this line's package
                    // price. A default, not a link: the field stays editable
                    // and `services.price` is never written.
                    patchRow(row.key, {
                      serviceId: value,
                      price:
                        service && service.price !== null
                          ? String(service.price)
                          : row.price,
                    });
                  }}
                  disabled={isPending || departmentId === ""}
                >
                  <SelectTrigger aria-label={t("serviceOptional")}>
                    <SelectValue placeholder={t("selectServiceFirst")} />
                  </SelectTrigger>
                  <SelectContent>
                    {departmentServices.map((service) => (
                      <SelectItem
                        key={service.id}
                        value={service.id}
                        disabled={takenElsewhere.has(service.id)}
                      >
                        {service.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* The service's own catalogue price, shown for reference and
                    for that only. Nothing derives a discount from it: a saving
                    the clinic did not state is a saving this system invented. */}
                {picked && picked.price !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("serviceRegularPrice")}: {money(picked.price)}
                  </p>
                ) : null}
                {row.serviceId !== "" ? (
                  <input type="hidden" name="item_service_id" value={row.serviceId} />
                ) : null}
              </div>

              <div className="space-y-1">
                <Label className="text-[11px]">{t("sessionsShort")}</Label>
                <Input
                  type="number"
                  aria-label={t("sessionsShort")}
                  min={1}
                  max={10000}
                  step={1}
                  inputMode="numeric"
                  value={row.sessions}
                  onChange={(event) => patchRow(row.key, { sessions: event.target.value })}
                  disabled={isPending}
                />
                {row.serviceId !== "" ? (
                  <input type="hidden" name="item_sessions" value={row.sessions} />
                ) : null}
              </div>

              <div className="space-y-1">
                <Label className="text-[11px]">{t("packagePricePerSession")}</Label>
                <Input
                  type="number"
                  aria-label={t("packagePricePerSession")}
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={row.price}
                  onChange={(event) => patchRow(row.key, { price: event.target.value })}
                  disabled={isPending}
                />
                {row.serviceId !== "" ? (
                  <input
                    type="hidden"
                    name="item_price_per_session"
                    value={row.price}
                  />
                ) : null}
                {subtotal !== null ? (
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {t("itemSubtotal")}: {money(subtotal)}
                  </p>
                ) : null}
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeService")}
                onClick={() => removeRow(row.key)}
                disabled={isPending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={addRow}
            disabled={isPending || departmentId === ""}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addPackageService")}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            {departmentId === ""
              ? t("pickDepartmentFirst")
              : departmentServices.length === 0
                ? t("noActiveServicesInDepartment")
                : null}
          </p>
        </div>
      </fieldset>

      {hasItems ? (
        /* Derived, and read-only because of it. The lines above are the single
           input; these two numbers are computed from them and are recomputed
           server-side by `set_package_template_items`, so there is exactly one
           writer and no way for a typed total to reprice a line. */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("totalSessions")}</Label>
            <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-sm tabular-nums">
              {itemsSessions}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("totalSessionsDerived")}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("packageTotal")}</Label>
            <div
              className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-sm font-medium tabular-nums"
              data-testid="package-total"
            >
              {money(itemsTotal)}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("packageTotalDerived")}
            </p>
          </div>
          {/* The header still has to receive a session count: the column is NOT
              NULL and booking reads it. It is the derived one. */}
          <input type="hidden" name="total_sessions" value={String(itemsSessions ?? "")} />
          <input type="hidden" name="total_price" value={String(itemsTotal ?? "")} />
        </div>
      ) : (
        /* A department-only package, priced exactly the way it is today —
           including a deliberate total that is not sessions x price. */
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="pkg-tpl-sessions" className="text-xs">
              {t("totalSessions")}</Label>
            <Input
              id="pkg-tpl-sessions"
              name="total_sessions"
              type="number"
              min={1}
              max={10000}
              step={1}
              value={sessions}
              onChange={(event) => {
                setSessions(event.target.value);
                applyDerivedTotal(event.target.value, pricePerSession);
              }}
              required
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pkg-tpl-price-each" className="text-xs">
              {t("priceSession")}</Label>
            <Input
              id="pkg-tpl-price-each"
              name="price_per_session"
              type="number"
              min={0}
              step="0.01"
              placeholder="optional"
              value={pricePerSession}
              onChange={(event) => {
                setPricePerSession(event.target.value);
                applyDerivedTotal(sessions, event.target.value);
              }}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pkg-tpl-price-total" className="text-xs">
              {t("totalPrice")}</Label>
            <Input
              id="pkg-tpl-price-total"
              name="total_price"
              type="number"
              min={0}
              step="0.01"
              placeholder="optional"
              value={totalPrice}
              onChange={(event) => {
                // From here on the total is the clinic's number, not a
                // derivation. A blank clears the override, so a staff member
                // who deletes what they typed gets the calculation back.
                totalEdited.current = event.target.value !== "";
                setTotalPrice(event.target.value);
              }}
              disabled={isPending}
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="pkg-tpl-notes" className="text-xs">
          {t("notes")}</Label>
        <Textarea
          id="pkg-tpl-notes"
          name="notes"
          maxLength={500}
          rows={3}
          placeholder={t("optionalInternalNotes")}
          defaultValue={defaults?.notes ?? ""}
          disabled={isPending}
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending} className="gap-2">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? t("saving") : submitLabel}
        </Button>
      </div>
    </form>
  );
}
