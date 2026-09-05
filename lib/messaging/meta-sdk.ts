/**
 * The Graph API version the browser-side Facebook JS SDK is initialised with.
 *
 * `FB.init` sets one version for the whole page, so both Meta onboarding
 * surfaces (the P6C wizard and the P7C "Connect WhatsApp Business" card) must
 * agree — whichever initialises first would otherwise decide for both.
 *
 * v23.0 is the floor for WhatsApp Business App Coexistence: the
 * `whatsapp_business_app_onboarding` feature type, the `is_on_biz_app` phone
 * field, the `smb_app_data` sync endpoint and the `history` /
 * `smb_app_state_sync` / `smb_message_echoes` webhook fields are all absent on
 * older versions, where the flow silently degrades to standard Cloud API signup.
 *
 * Keep this in step with the server-side default in `whatsapp-meta.ts`.
 */
export const META_SDK_VERSION = "v23.0";
