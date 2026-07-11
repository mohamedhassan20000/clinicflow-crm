import Link from "next/link";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { listOperatorClinics, OPERATOR_CLINIC_LIST_LIMIT } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Keeps the .in() filter URLs bounded when the clinic list grows.
const SUBSCRIPTION_CHUNK = 150;

export default async function OperatorClinicsPage() {
  const supabase = await createClient();
  const clinics = await listOperatorClinics();
  const clinicRows = clinics.data ?? [];
  const totalClinics = clinics.count ?? clinicRows.length;

  // Fetch subscriptions for exactly the listed clinics (chunked): a broad
  // unfiltered select is capped by PostgREST max_rows and could miss rows.
  const clinicIds = clinicRows.map((clinic) => clinic.id);
  const chunks: string[][] = [];
  for (let i = 0; i < clinicIds.length; i += SUBSCRIPTION_CHUNK) {
    chunks.push(clinicIds.slice(i, i + SUBSCRIPTION_CHUNK));
  }
  const subscriptionPages = await Promise.all(
    chunks.map((ids) =>
      supabase
        .from("subscriptions")
        .select("clinic_id, status, trial_ends_at, current_period_end, plans(slug)")
        .in("clinic_id", ids),
    ),
  );
  const byClinic = new Map(
    subscriptionPages.flatMap((page) => page.data ?? []).map((row) => [row.clinic_id, row]),
  );

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Clinics</h1>
        <p className="mt-1 text-muted-foreground">
          {totalClinics} total · tenant metadata and subscription state only — no clinical data.
        </p>
        {totalClinics > clinicRows.length ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
            Showing the newest {OPERATOR_CLINIC_LIST_LIMIT} of {totalClinics} clinics.
          </p>
        ) : null}
      </header>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-start text-muted-foreground">
            <tr>
              {["Clinic", "Country", "Created", "Onboarding", "Plan", "Access", "Period / trial end"].map((heading) => (
                <th key={heading} className="px-4 py-3 text-start font-medium">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clinicRows.map((clinic) => {
              const subscription = byClinic.get(clinic.id);
              const access = resolveSubscriptionAccess(subscription ?? null);
              const end = subscription?.status === "trialing"
                ? subscription.trial_ends_at
                : subscription?.current_period_end;
              return (
                <tr key={clinic.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/operator/clinics/${clinic.id}`} className="font-medium underline-offset-2 hover:underline">
                      {clinic.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{clinic.country}</td>
                  <td className="px-4 py-3">{clinic.created_at.slice(0, 10)}</td>
                  <td className="px-4 py-3">{clinic.onboarding_completed_at ? "complete" : "incomplete"}</td>
                  <td className="px-4 py-3">{subscription?.plans?.slug ?? "—"}</td>
                  <td className="px-4 py-3">{access.reason.replaceAll("_", " ")}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {end ? end.slice(0, 10) : subscription?.status === "active" ? "unbounded" : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
