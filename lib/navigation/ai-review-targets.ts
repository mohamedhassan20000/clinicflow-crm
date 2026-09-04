/**
 * P10 — the deterministic deep-link contract for the two AI review queues.
 *
 * Both the dashboard card that produces a link and the page that consumes it
 * need the same anchor id and the same query key, and having them agree by
 * coincidence in two files is how `/patients#ai-intakes` came to point at an
 * element whose id nobody was checking.
 *
 * The anchor stays because it is the correct thing for a same-page link and for
 * a copied URL. The query parameter exists because a fragment alone is not
 * reliable across an App Router route change into a streamed server page: the
 * review table renders after the router has already decided where to scroll.
 * The parameter is read on the client, after mount, so the scroll happens when
 * the element genuinely exists.
 */

/** The `id` on the AI intake review card, and the URL fragment that targets it. */
export const AI_INTAKE_REVIEW_ANCHOR = "ai-intakes";

/** `?review=1` — "scroll to and focus the AI intake review table". */
export const AI_INTAKE_REVIEW_PARAM = "review";

/** `?intake=<uuid>` — focus and open this exact review record. */
export const AI_INTAKE_ID_PARAM = "intake";

/** `?appointment=<uuid>` — "open this appointment's details in the calendar". */
export const CALENDAR_APPOINTMENT_PARAM = "appointment";

/** `?ai=1` — restrict the calendar to appointments the assistant created. */
export const CALENDAR_AI_ONLY_PARAM = "ai";
