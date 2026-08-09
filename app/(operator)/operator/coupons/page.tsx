import { Gift } from "lucide-react";
import { createCoupon, setCouponActive } from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SingleDatePicker } from "@/components/ui/clinic-date-picker";
import { TableEmptyState } from "@/components/shared/data-table";
import { listOperatorClinics } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

export default async function OperatorCouponsPage() {
  const t = await getTranslations("operator");
  const supabase = await createClient();
  const [coupons, clinics, invitations] = await Promise.all([
    supabase
      .from("coupons")
      .select("id, code, kind, months, percent, expires_at, max_redemptions, redemption_count, clinic_id, invitation_id, is_active")
      .order("created_at", { ascending: false })
      .limit(200),
    listOperatorClinics(),
    supabase
      .from("clinic_invitations")
      .select("id, clinic_name, email, status")
      .in("status", ["pending"])
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const clinicNames = new Map((clinics.data ?? []).map((clinic) => [clinic.id, clinic.name]));

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">{t("coupons")}</h1>
        <p className="mt-1 text-muted-foreground">{t("lifetimeFreeXMonthsFreeAnd")}</p>
      </header>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">{t("createCoupon")}</h2>
        <OperatorActionForm action={createCoupon} submitLabel={t("createCoupon")}>
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="code" placeholder={t("code2026")} required className="rounded-md border bg-background px-2 py-1 text-sm uppercase" />
            <select name="kind" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="months_free">
              <option value="lifetime_free">{t("lifetimeFree")}</option>
              <option value="months_free">{t("monthsFree")}</option>
              <option value="percent_discount">{t("percentDiscount")}</option>
            </select>
            <input name="months" type="number" min={1} max={120} placeholder={t("monthsMonthsFree")} className="rounded-md border bg-background px-2 py-1 text-sm" />
            <input name="percent" type="number" min={1} max={100} placeholder={t("percentDiscount2")} className="rounded-md border bg-background px-2 py-1 text-sm" />
            <SingleDatePicker name="expiresAt" label={t("expires")} title={t("expiryDateInclusiveRedeemableThroughThe")} className="rounded-md" />
            <input name="maxRedemptions" type="number" min={1} placeholder={t("maxRedemptions")} className="rounded-md border bg-background px-2 py-1 text-sm" />
            <select name="clinicId" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="">
              <option value="">{t("noClinicAssignment")}</option>
              {(clinics.data ?? []).map((clinic) => (
                <option key={clinic.id} value={clinic.id}>{clinic.name}</option>
              ))}
            </select>
            <select name="invitationId" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="">
              <option value="">{t("noInvitationAssignment")}</option>
              {(invitations.data ?? []).map((invitation) => (
                <option key={invitation.id} value={invitation.id}>
                  {invitation.clinic_name} ({invitation.email})
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("expiryDatesAreInclusiveTheCoupon")}</p>
        </OperatorActionForm>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card">
        {(coupons.data ?? []).length === 0 ? (
          <TableEmptyState
            icon={Gift}
            title={t("noCouponsYet")}
            description={t("couponsYouCreateAppearHereWith")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {[t("code"), t("kind"), t("value"), t("expires"), t("redemptions"), t("assignment"), t("active"), t("actions")].map((heading) => (
                  <TableHead key={heading}>{heading}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(coupons.data ?? []).map((coupon) => (
                <TableRow key={coupon.id}>
                  <TableCell className="font-mono text-xs">{coupon.code}</TableCell>
                  <TableCell>{coupon.kind.replaceAll("_", " ")}</TableCell>
                  <TableCell>
                    {coupon.kind === "months_free" ? `${coupon.months} months` : coupon.kind === "percent_discount" ? `${coupon.percent}%` : "∞"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{coupon.expires_at?.slice(0, 10) ?? "never"}</TableCell>
                  <TableCell className="tabular-nums">
                    {coupon.redemption_count}{coupon.max_redemptions ? ` / ${coupon.max_redemptions}` : ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {coupon.clinic_id
                      ? t("clinicNamed", { clinic: clinicNames.get(coupon.clinic_id) ?? coupon.clinic_id })
                      : coupon.invitation_id
                        ? "invitation"
                        : "global"}
                  </TableCell>
                  <TableCell>{coupon.is_active ? "yes" : "no"}</TableCell>
                  <TableCell>
                    <OperatorActionForm
                      action={setCouponActive}
                      submitLabel={coupon.is_active ? t("deactivate") : t("activate")}
                      submitVariant="outline"
                      className="space-y-1"
                    >
                      <input type="hidden" name="couponId" value={coupon.id} />
                      <input type="hidden" name="isActive" value={coupon.is_active ? "false" : "true"} />
                    </OperatorActionForm>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}
