import "server-only";

import { getTranslations } from "next-intl/server";

type ActionErrorValues = Record<string, string | number | Date>;

/**
 * Resolves a stable Server Action failure key before the result crosses the RSC boundary.
 *
 * Action result contracts intentionally remain plain `{ error, fieldErrors }` strings because
 * existing forms, alerts, and toasts render those fields directly. Keeping translation here makes
 * every existing rendering boundary safe without ever sending a raw catalog key to the browser.
 */
export async function actionError(key: string, values?: ActionErrorValues): Promise<string> {
  const t = await getTranslations("actionErrors");
  return t(key as never, values as never);
}

/** Formats weekday values used inside validation failures in the active UI locale. */
export async function actionWeekday(day: number): Promise<string> {
  const weekdayT = await getTranslations("shared");
  return [
    weekdayT("weekday0"),
    weekdayT("weekday1"),
    weekdayT("weekday2"),
    weekdayT("weekday3"),
    weekdayT("weekday4"),
    weekdayT("weekday5"),
    weekdayT("weekday6"),
  ][day] ?? weekdayT("weekday0");
}

/** Converts appointment status API values to localized display labels. */
export async function actionAppointmentStatus(status: string): Promise<string> {
  const statusT = await getTranslations("appointments");
  const keys: Record<string, string> = {
    pending: "statusPending",
    confirmed: "statusConfirmed",
    arrived: "statusArrived",
    in_session: "statusInSession",
    completed: "statusCompleted",
    cancelled: "statusCancelled",
    no_show: "statusNoShow",
    replaced: "statusReplaced",
  };
  return keys[status] ? statusT(keys[status] as never) : status;
}
