export type FollowupItem = {
  id: string;
  recorded_at: string;
  outcome: "all_fine" | "has_problem" | "no_response";
  notes: string | null;
  appointment_id: string | null;
  recorded_by: { full_name: string } | null;
  appointment: {
    scheduled_at: string;
    departments: { name: string; color: string } | null;
    profiles: { full_name: string } | null;
  } | null;
};

const FOLLOWUP_META: Record<
  "all_fine" | "has_problem" | "no_response",
  { label: string; className: string }
> = {
  all_fine: {
    label: "Everything is fine",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  has_problem: {
    label: "Reported a problem",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  no_response: {
    label: "No response",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

export function FollowupsList({ followups }: { followups: FollowupItem[] }) {
  if (!followups || followups.length === 0) {
    return (
      <div className="px-5 py-6 text-center text-sm text-muted-foreground">
        No follow-up notes yet.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/30">
      {followups.map((f) => {
        const meta = FOLLOWUP_META[f.outcome];
        const dept = f.appointment?.departments;
        return (
          <li key={f.id} className="px-4 py-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
              >
                {meta.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(f.recorded_at).toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              {f.appointment?.scheduled_at && (
                <span className="text-[11px] text-muted-foreground">
                  · session{" "}
                  {new Date(f.appointment.scheduled_at).toLocaleDateString(
                    "en-GB",
                    {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    },
                  )}
                </span>
              )}
              {dept?.name && (
                <span
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${dept.color} 14%, transparent)`,
                    color: dept.color,
                  }}
                >
                  {dept.name}
                </span>
              )}
            </div>
            {f.notes && (
              <p className="text-sm text-foreground">&ldquo;{f.notes}&rdquo;</p>
            )}
            {f.recorded_by?.full_name && (
              <p className="text-[10px] text-muted-foreground">
                Recorded by {f.recorded_by.full_name}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
