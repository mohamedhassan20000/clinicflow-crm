/**
 * Media types that cross the worker's module boundaries without carrying the
 * WhatsApp stack with them.
 *
 * `media.ts` is the implementation: it decrypts, sniffs and stores blobs, and
 * it imports `baileys` to do so. Its *result* shape, though, is consumed by
 * `store.ts` — a module the web app's test suite reaches directly. Leaving the
 * type in `media.ts` meant a type-only import dragged the whole WhatsApp
 * dependency into the Next.js type program, where `baileys` is neither
 * installed nor wanted. Declaring it here keeps the contract shared and the
 * dependency local to the implementation.
 */

/** The outcome of putting attachment bytes in the clinic's private bucket. */
export type MediaUploadResult =
  | { ok: true }
  | {
      ok: false;
      /** Coarse, privacy-safe failure family. Never an upstream error message. */
      errorCategory: string;
      /** A sanitized HTTP/service code, never an object path or response body. */
      errorCode: string;
    };
