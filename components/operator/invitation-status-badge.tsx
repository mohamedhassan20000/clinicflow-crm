import { Badge } from "@/components/ui/badge";
import { useTranslations } from "next-intl";

/**
 * Display state of a `clinic_invitations` row. `requested` is the sub-state of
 * a `pending` row that has not been issued a token yet (no `token_hash`); the
 * DB status enum itself is `pending | accepted | revoked | expired`.
 */
export type InvitationDisplayStatus =
  | "requested"
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

// Semantic status colours, consistent with components/appointments/status-badge.tsx:
// pending → warning (amber), accepted → success (emerald), revoked → destructive.
const STATUS_CONFIG: Record<
  InvitationDisplayStatus,
  { labelKey: string; className: string }
> = {
  requested: {
    labelKey: "requested",
    className: "bg-muted text-foreground/80 border-border",
  },
  pending: {
    labelKey: "pending",
    className:
      "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  },
  accepted: {
    labelKey: "accepted",
    className:
      "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700",
  },
  revoked: {
    labelKey: "revoked",
    className: "bg-destructive/10 text-destructive border-destructive/40",
  },
  expired: {
    labelKey: "expired",
    className: "bg-muted text-muted-foreground border-border",
  },
};

/** Resolves the display status from the raw DB status + token presence. */
export function invitationDisplayStatus(
  status: string,
  hasToken: boolean,
): InvitationDisplayStatus {
  if (status === "pending" && !hasToken) return "requested";
  if (status === "pending" || status === "accepted" || status === "revoked" || status === "expired") {
    return status;
  }
  return "pending";
}

export function InvitationStatusBadge({
  status,
  hasToken,
}: {
  status: string;
  hasToken: boolean;
}) {
  const t = useTranslations("operator");
  const display = invitationDisplayStatus(status, hasToken);
  const config = STATUS_CONFIG[display];
  return (
    <Badge variant="outline" className={config.className}>
      {t(config.labelKey)}
    </Badge>
  );
}
