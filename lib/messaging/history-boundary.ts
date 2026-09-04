/** True when a history event is not allowed to create normal Inbox activity. */
export function isHistoryBeforeBoundary(
  occurredAt: string | null | undefined,
  inboundActiveFrom: string | null | undefined,
): boolean {
  if (!inboundActiveFrom) return false;
  if (!occurredAt) return true;
  const eventAt = new Date(occurredAt).valueOf();
  const boundaryAt = new Date(inboundActiveFrom).valueOf();
  return !Number.isFinite(eventAt) ||
    !Number.isFinite(boundaryAt) ||
    eventAt < boundaryAt;
}

/** A fresh live directory-resolved name may replace a stale history label. */
export function inboundDisplayName(
  _existing: string | null | undefined,
  whatsappName: string | null | undefined,
): string | null {
  return whatsappName?.trim() || null;
}
