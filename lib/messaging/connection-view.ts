import type { MetaChannelState } from "@/lib/messaging/channel-management";

/**
 * P7C — the client-visible projection of a WhatsApp connection.
 *
 * The internal MetaChannelState carries Meta's own status strings, provider
 * identifiers and review metadata. None of that belongs in the simple
 * "Connect WhatsApp Business" surface, so this collapses it to the four states
 * the clinic is actually shown, plus the display number. Nothing else crosses
 * the boundary: no WABA id, phone number id, token, webhook detail, or raw
 * provider error.
 *
 * Deliberately not `server-only`: the settings page renders the initial value
 * and the server action returns updates, so both must produce the *same*
 * projection from the same rule.
 */
export type WhatsAppConnectionStatus =
  | "not_connected"
  | "verifying"
  | "connected"
  | "failed";

/**
 * Which of the two connection methods owns the clinic's single WhatsApp
 * channel, so each card can tell "connected here" from "connected by the other
 * method". `embedded_signup` is the pre-existing platform-brokered flow, kept
 * as a secondary option. Null when nothing is connected.
 *
 * This is the clinic's own choice, not a platform secret — no identifier,
 * credential or Meta-side detail travels with it.
 */
export type WhatsAppConnectionMode =
  /** P7E: the clinic paired ClinicFlow as a linked device by scanning a QR. */
  | "linked_device"
  | "manual_api"
  | "coexistence"
  | "embedded_signup";

export type WhatsAppBusinessConnectionView = {
  status: WhatsAppConnectionStatus;
  displayPhoneNumber: string | null;
  connectedAt: string | null;
  mode: WhatsAppConnectionMode | null;
};

/**
 * Everything between "the popup finished" and "Meta confirmed it" reads as
 * `verifying` — the connection is never presented as usable before the server
 * has verified it and the channel has actually reached `connected`.
 */
export function toWhatsAppBusinessConnectionView(
  state: MetaChannelState,
): WhatsAppBusinessConnectionView {
  const status: WhatsAppConnectionStatus = !state.configured
    ? "not_connected"
    : state.connectionState === "connected"
      ? "connected"
      : state.connectionState === "verification_failed" || state.status === "error"
        ? "failed"
        : "verifying";
  return {
    status,
    displayPhoneNumber: state.displayPhoneNumber,
    connectedAt: state.connectedAt,
    // A configured channel that predates the flow column reads as the
    // platform-brokered signup it must have been.
    mode: state.configured ? state.onboardingFlow ?? "embedded_signup" : null,
  };
}
