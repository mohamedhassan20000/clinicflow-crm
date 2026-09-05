"use client";

import { useCallback, useEffect, useRef } from "react";
import { Download, FileAudio, FileText, ImageOff, Mic } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { InboxAttachment } from "@/lib/messaging/inbox";
import { cn } from "@/lib/utils";

/**
 * P8 — what a patient sent, inside the message bubble that carried it.
 *
 * Three states, and each one is shown rather than hidden:
 *
 *   * **A stored image** renders inline, capped so a portrait photo cannot push
 *     the reply box off the screen, and links out to the full size.
 *   * **A stored document** renders as a row a staff member can recognise at a
 *     glance — kind, name, size — and download.
 *   * **Anything refused or failed** renders as a short, specific sentence.
 *     Staff are told that a file arrived and why ClinicFlow cannot open it,
 *     because "nothing here" and "a photo of a rash we could not fetch" are very
 *     different things to a receptionist.
 *
 * Direction: the surrounding bubble already follows the page direction, and file
 * names are user content in an unknown script, so they carry `dir="auto"` and let
 * the browser decide. Sizes are formatted through `next-intl`, so Arabic reads
 * Arabic numerals.
 */

/** Maps the worker's machine reason onto the sentence staff read. */
function reasonKey(attachment: InboxAttachment): string {
  switch (attachment.failureReason) {
    // P11P: an imported-history row. The worker recorded what the message *was*
    // — kind, mime, filename, duration — but WhatsApp's media URLs had long
    // expired by import time, so no bytes were ever claimed and none can be.
    // This is a permanent, explainable absence rather than a failure to retry,
    // and it is by far the most common one in an inbox with imported history,
    // so it gets its own sentence per kind instead of the generic "unavailable".
    case "historical_media_unavailable":
      switch (attachment.mediaKind) {
        case "image":
          return "historicalImage";
        case "video":
          return "historicalVideo";
        case "audio":
          return "historicalAudio";
        case "document":
          return "historicalDocument";
        default:
          return "historicalUnavailable";
      }
    case "too_large":
      return "tooLarge";
    case "kind_not_stored":
      return "kindNotStored";
    case "unsupported_type":
      return "unsupportedType";
    case "download_failed":
      return "downloadFailed";
    case "storage_failed":
    case "foreign_storage_path":
      return "storageFailed";
    default:
      return attachment.status === "rejected" ? "rejected" : "unavailable";
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function playbackErrorCategory(error: MediaError | null): string | null {
  switch (error?.code) {
    case 1: // MEDIA_ERR_ABORTED
      return "aborted";
    case 2: // MEDIA_ERR_NETWORK
      return "network";
    case 3: // MEDIA_ERR_DECODE
      return "decode";
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return "source_not_supported";
    default:
      return error ? "unknown" : null;
  }
}

function AudioAttachmentPlayer({
  attachment,
  label,
}: {
  attachment: InboxAttachment;
  label: string;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const httpProbe = useRef<{
    status: number | null;
    mimeType: string | null;
    byteCount: number | null;
    acceptRanges: string | null;
  }>(
    { status: null, mimeType: null, byteCount: null, acceptRanges: null },
  );

  const diagnose = useCallback((
    stage: string,
    element: HTMLAudioElement | null,
    errorCategory?: string | null,
  ) => {
    // Safe aggregate playback state only. Do not add the source URL,
    // attachment id/name, conversation, phone number or provider address.
    console.info("voice_playback_load", {
      stage,
      httpStatus: httpProbe.current.status,
      responseMime: httpProbe.current.mimeType,
      responseByteCount: httpProbe.current.byteCount,
      acceptRanges: httpProbe.current.acceptRanges,
      expectedMimeFamily: attachment.mimeType.split("/", 1)[0]?.toLowerCase() || "unknown",
      expectedByteCount: attachment.byteSize,
      readyState: element?.readyState ?? 0,
      networkState: element?.networkState ?? 0,
      durationSeconds:
        element && Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : null,
      errorCategory: errorCategory ?? playbackErrorCategory(element?.error ?? null),
    });
  }, [attachment.byteSize, attachment.mimeType]);

  useEffect(() => {
    // The stable same-origin endpoint is deliberately probed without reading
    // its body. This makes HTTP/MIME/length failures visible separately from a
    // browser decoder failure and never exposes a signed URL to diagnostics.
    if (!attachment.url?.startsWith("/api/inbox/voice/")) return;
    let disposed = false;
    void fetch(attachment.url, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((response) => {
        if (disposed) return;
        const byteCount = Number(response.headers.get("content-length"));
        httpProbe.current = {
          status: response.status,
          mimeType: response.headers.get("content-type"),
          byteCount: Number.isSafeInteger(byteCount) && byteCount >= 0 ? byteCount : null,
          acceptRanges: response.headers.get("accept-ranges"),
        };
        let errorCategory: string | null = null;
        if (!response.ok) errorCategory = "http_failure";
        else if (httpProbe.current.mimeType?.startsWith("audio/") !== true) {
          errorCategory = "wrong_mime";
        } else if (httpProbe.current.acceptRanges !== "bytes") {
          errorCategory = "range_unsupported";
        } else if (httpProbe.current.byteCount !== attachment.byteSize) {
          errorCategory = "byte_count_mismatch";
        }
        diagnose("http_probe", player.current, errorCategory);
      })
      .catch(() => {
        if (!disposed) diagnose("http_probe", player.current, "fetch_failed");
      });
    return () => {
      disposed = true;
    };
  }, [attachment.byteSize, attachment.mimeType, attachment.url, diagnose]);

  return (
    <audio
      ref={player}
      controls
      preload="metadata"
      src={attachment.url!}
      className="h-9 max-w-full"
      aria-label={label}
      data-testid={attachment.voiceNote ? "voice-note-player" : "audio-player"}
      onLoadStart={(event) => diagnose("loadstart", event.currentTarget)}
      onLoadedMetadata={(event) => diagnose("loadedmetadata", event.currentTarget)}
      onCanPlay={(event) => diagnose("canplay", event.currentTarget)}
      onError={(event) => diagnose("error", event.currentTarget)}
    />
  );
}

export function MessageAttachments({
  attachments,
  tone,
}: {
  attachments: readonly InboxAttachment[];
  /** Matches the bubble it sits in, so contrast holds in both directions. */
  tone: "inbound" | "outbound";
}) {
  const t = useTranslations("inbox.attachments");
  const format = useFormatter();
  if (attachments.length === 0) return null;

  return (
    <ul className="mt-2 space-y-2" data-testid="message-attachments">
      {attachments.map((attachment) => {
        const readable = attachment.status === "stored" && attachment.url;
        const label = attachment.fileName ?? t("label");
        const size = format.number(Math.max(1, Math.round(attachment.byteSize / 1024)));

        if (!readable) {
          return (
            <li
              key={attachment.id}
              className={cn(
                "flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-xs",
                tone === "outbound"
                  ? "border-primary-foreground/40 text-primary-foreground/85"
                  : "border-muted-foreground/40 text-muted-foreground",
              )}
              data-testid="attachment-unavailable"
            >
              <ImageOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">{t(reasonKey(attachment))}</span>
            </li>
          );
        }

        if (attachment.mediaKind === "image") {
          return (
            <li key={attachment.id}>
              <a
                href={attachment.url!}
                target="_blank"
                rel="noopener noreferrer"
                className="block overflow-hidden rounded-lg border border-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={t("openImage")}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a plain img on purpose: the src is a short-lived signed URL on a private bucket, which the image optimiser can neither cache nor re-fetch once it expires */}
                <img
                  src={attachment.url!}
                  alt={attachment.fileName ?? t("imageAlt")}
                  loading="lazy"
                  className="max-h-72 w-full max-w-full object-contain"
                />
              </a>
            </li>
          );
        }

        if (attachment.mediaKind === "video") {
          return (
            <li key={attachment.id} className="space-y-1">
              {/* Metadata only: a thread can hold many of these, and a clinic
                  laptop should not pull every clip in the history the moment a
                  conversation is opened. The poster frame and the bytes arrive
                  when a staff member presses play. */}
              <video
                controls
                preload="metadata"
                src={attachment.url!}
                className="max-h-72 w-full max-w-full rounded-lg border border-black/5 bg-black/5"
                aria-label={attachment.fileName ?? t("videoLabel")}
                data-testid="video-player"
              />
              {attachment.durationSeconds !== null ? (
                <span className="block text-[10px] opacity-70" dir="ltr">
                  {formatDuration(attachment.durationSeconds)}
                </span>
              ) : null}
            </li>
          );
        }

        if (attachment.mediaKind === "audio") {
          const audioLabel = attachment.voiceNote
            ? t("voiceNote")
            : attachment.fileName ?? t("audioFile");
          return (
            <li key={attachment.id} className="min-w-52 space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                {attachment.voiceNote ? (
                  <Mic className="size-3.5" aria-hidden />
                ) : (
                  <FileAudio className="size-3.5" aria-hidden />
                )}
                <span className="truncate" dir="auto">{audioLabel}</span>
                {attachment.durationSeconds !== null ? (
                  <span className="shrink-0 opacity-70" dir="ltr">
                    · {formatDuration(attachment.durationSeconds)}
                  </span>
                ) : null}
              </span>
              <AudioAttachmentPlayer
                attachment={attachment}
                label={attachment.voiceNote ? t("playVoiceNote") : t("playAudio")}
              />
            </li>
          );
        }

        return (
          <li key={attachment.id}>
            <a
              href={attachment.url!}
              target="_blank"
              rel="noopener noreferrer"
              download={attachment.fileName ?? undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                tone === "outbound"
                  ? "border-primary-foreground/30 hover:bg-primary-foreground/10"
                  : "border-border hover:bg-muted",
              )}
            >
              <FileText className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" dir="auto">
                  {label}
                </span>
                <span className="block opacity-75">{`${size} KB`}</span>
              </span>
              <Download className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{t("download")}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
