import Link from "next/link";
import { Building2 } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableEmptyState } from "@/components/shared/data-table";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { pathWithSearch, withReturnTo } from "@/lib/navigation/return-url";
import { listOperatorClinics, OPERATOR_CLINIC_LIST_LIMIT } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Keeps the .in() filter URLs bounded when the clinic list grows.
const SUBSCRIPTION_CHUNK = 150;

export default async function OperatorClinicsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; country?: string }>;
}) {
  const rawFilters = await searchParams;
  const q = rawFilters.q?.trim().slice(0, 80) ?? "";
  const countryCandidate = rawFilters.country?.trim().toUpperCase() ?? "";
  const country = /^[A-Z]{2}$/.test(countryCandidate) ? countryCandidate : "";
  const listParams = new URLSearchParams();
  if (q) listParams.set("q", q);
  if (country) listParams.set("country", country);
  const currentListUrl = pathWithSearch("/operator/clinics", listParams);

  const supabase = await createClient();
  const clinics = await listOperatorClinics({ search: q || undefined, country: country || undefined });
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
          {q || country ? `${totalClinics} matching` : `${totalClinics} total`} · tenant metadata and subscription state only — no clinical data.
        </p>
        {totalClinics > clinicRows.length ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
            Showing the newest {OPERATOR_CLINIC_LIST_LIMIT} of {totalClinics} clinics.
          </p>
        ) : null}
      </header>
      <form method="get" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium">
          Search clinics
          <Input name="q" defaultValue={q} placeholder="Clinic name" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Country code
          <Input name="country" defaultValue={country} placeholder="TR" maxLength={2} className="uppercase" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Filter</Button>
          {(q || country) ? <Button asChild type="button" variant="outline"><Link href="/operator/clinics">Clear</Link></Button> : null}
        </div>
      </form>
      <div className="overflow-hidden rounded-xl border bg-card">
        {clinicRows.length === 0 ? (
          <TableEmptyState
            icon={Building2}
            title="No clinics yet"
            description="Clinics appear here once the first invitation is accepted."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {["Clinic", "Country", "Created", "Onboarding", "Plan", "Access", "Period / trial end"].map((heading) => (
                  <TableHead key={heading}>{heading}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {clinicRows.map((clinic) => {
                const subscription = byClinic.get(clinic.id);
                const access = resolveSubscriptionAccess(subscription ?? null);
                const end = subscription?.status === "trialing"
                  ? subscription.trial_ends_at
                  : subscription?.current_period_end;
                return (
                  <TableRow key={clinic.id}>
                    <TableCell>
                      <Link href={withReturnTo(`/operator/clinics/${clinic.id}`, currentListUrl)} className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        {clinic.name}
                      </Link>
                    </TableCell>
                    <TableCell>{clinic.country}</TableCell>
                    <TableCell>{clinic.created_at.slice(0, 10)}</TableCell>
                    <TableCell>{clinic.onboarding_completed_at ? "complete" : "incomplete"}</TableCell>
                    <TableCell>{subscription?.plans?.slug ?? "—"}</TableCell>
                    <TableCell>{access.reason.replaceAll("_", " ")}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {end ? end.slice(0, 10) : subscription?.status === "active" ? "unbounded" : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
