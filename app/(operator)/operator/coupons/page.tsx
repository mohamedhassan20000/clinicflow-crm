import { Gift } from "lucide-react";
import { createCoupon, setCouponActive } from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableEmptyState } from "@/components/shared/data-table";
import { listOperatorClinics } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function OperatorCouponsPage() {
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
        <h1 className="text-3xl font-bold tracking-tight">Coupons</h1>
        <p className="mt-1 text-muted-foreground">Lifetime free, X months free, and percentage promotions (§3.3).</p>
      </header>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Create coupon</h2>
        <OperatorActionForm action={createCoupon} submitLabel="Create coupon">
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="code" placeholder="CODE-2026" required className="rounded-md border bg-background px-2 py-1 text-sm uppercase" />
            <select name="kind" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="months_free">
              <option value="lifetime_free">lifetime free</option>
              <option value="months_free">months free</option>
              <option value="percent_discount">percent discount</option>
            </select>
            <input name="months" type="number" min={1} max={120} placeholder="Months (months_free)" className="rounded-md border bg-background px-2 py-1 text-sm" />
            <input name="percent" type="number" min={1} max={100} placeholder="Percent (discount)" className="rounded-md border bg-background px-2 py-1 text-sm" />
            <input name="expiresAt" type="date" title="Expiry date (inclusive — redeemable through the end of this day, UTC)" className="rounded-md border bg-background px-2 py-1 text-sm" />
            <input name="maxRedemptions" type="number" min={1} placeholder="Max redemptions" className="rounded-md border bg-background px-2 py-1 text-sm" />
            <select name="clinicId" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="">
              <option value="">No clinic assignment</option>
              {(clinics.data ?? []).map((clinic) => (
                <option key={clinic.id} value={clinic.id}>{clinic.name}</option>
              ))}
            </select>
            <select name="invitationId" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="">
              <option value="">No invitation assignment</option>
              {(invitations.data ?? []).map((invitation) => (
                <option key={invitation.id} value={invitation.id}>
                  {invitation.clinic_name} ({invitation.email})
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Expiry dates are inclusive: the coupon stays redeemable through the end of the selected day (UTC).
          </p>
        </OperatorActionForm>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card">
        {(coupons.data ?? []).length === 0 ? (
          <TableEmptyState
            icon={Gift}
            title="No coupons yet"
            description="Coupons you create appear here with their redemption state."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {["Code", "Kind", "Value", "Expires", "Redemptions", "Assignment", "Active", "Actions"].map((heading) => (
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
                      ? `clinic: ${clinicNames.get(coupon.clinic_id) ?? coupon.clinic_id}`
                      : coupon.invitation_id
                        ? "invitation"
                        : "global"}
                  </TableCell>
                  <TableCell>{coupon.is_active ? "yes" : "no"}</TableCell>
                  <TableCell>
                    <OperatorActionForm
                      action={setCouponActive}
                      submitLabel={coupon.is_active ? "Deactivate" : "Activate"}
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
