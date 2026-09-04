import "server-only";

import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { sendMessage } from "@/lib/messaging/send";
import {
  BULK_SEND_CONCURRENCY,
  BULK_SEND_DELAY_MS,
  isRetryableSendFailure,
  planBulkRecipients,
  bulkJobOutcome,
} from "@/lib/messaging/bulk-send-plan";

export * from "@/lib/messaging/bulk-send-plan";

/**
 * P11Q — sending one message to several existing conversations, safely.
 *
 * This is a queue *above* the ordinary send path, never a replacement for it.
 * Every recipient message is produced by the same `sendMessage()` that a single
 * reply uses, so the service window, entitlements, usage caps, provider
 * selection, `outbound_messages` persistence and delivery tracking all behave
 * exactly as they do for a one-off reply. Nothing here talks to a provider, and
 * nothing here writes a message record.
 *
 * What this module adds is only the three things a single send does not need:
 *
 *   * **a durable list**, so a refresh, a crash or a restart cannot lose track
 *     of who has been written to and who has not;
 *   * **a claim**, so the same recipient cannot be sent to twice;
 *   * **backpressure**, so selecting fifty conversations does not become fifty
 *     simultaneous sends against one WhatsApp socket.
 *
 * ### The honesty rule
 *
 * A partial send is never reported as a success. The job status distinguishes
 * `completed` from `completed_with_failures`, every recipient carries its own
 * state, and a recipient that was never attempted carries the reason it was
 * skipped. "It worked" and "it worked for nine of eleven" are different
 * sentences and staff get the right one.
 */

/**
 * Runs (or resumes, or retries) one job.
 *
 * Safe to call repeatedly and concurrently. Every recipient is taken through the
 * `claim_bulk_message_recipient` compare-and-swap, which only ever yields a row
 * that was `pending` or `failed`; anything already `sent` matches nothing and is
 * returned to no one. That single property is what makes a double-clicked
 * button, a second browser tab, a page refresh and an app restart all
 * indistinguishable from one another — and none of them able to send twice.
 */
export async function runBulkSendJob(input: {
  clinicId: string;
  jobId: string;
  /** Injected in tests; defaults to the real send path. */
  send?: typeof sendMessage;
  /** Injected in tests so the pacing delay costs nothing. */
  delay?: (ms: number) => Promise<void>;
}): Promise<{ sent: number; failed: number; skipped: number }> {
  const client = createClinicScopedAdminClient(input.clinicId);
  const send = input.send ?? sendMessage;
  const delay =
    input.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const jobResult = await client
    .from("bulk_message_jobs")
    .select("id, body, status")
    .eq("id", input.jobId)
    .maybeSingle();
  if (jobResult.error || !jobResult.data) {
    return { sent: 0, failed: 0, skipped: 0 };
  }
  const body = jobResult.data.body;

  await client
    .from("bulk_message_jobs")
    .update({ status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", input.jobId)
    .in("status", ["pending", "running", "completed_with_failures", "failed"]);

  // Only rows that could still be worked on. A `sent` row is never listed, so it
  // is never even offered to the claim.
  const pendingResult = await client
    .from("bulk_message_recipients")
    .select("id, conversation_id")
    .eq("job_id", input.jobId)
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true });
  const queue = pendingResult.error ? [] : pendingResult.data ?? [];

  let cursor = 0;
  const takeNext = () => (cursor < queue.length ? queue[cursor++] : null);

  async function worker() {
    for (let row = takeNext(); row; row = takeNext()) {
      // The claim. Losing it means another caller already has this recipient,
      // or it has since been sent — either way this worker must not send.
      const claim = await client.rpc("claim_bulk_message_recipient", {
        p_clinic_id: input.clinicId,
        p_recipient_id: row.id,
      });
      const claimed = claim.error ? null : claim.data?.[0];
      if (!claimed) continue;

      const conversation = await client
        .from("conversations")
        .select("id, channel, status, participant_address")
        .eq("id", row.conversation_id)
        .maybeSingle();
      const [plan] = planBulkRecipients(
        conversation.error || !conversation.data
          ? []
          : [{
              id: conversation.data.id,
              channel: conversation.data.channel,
              status: conversation.data.status,
              participantAddress: conversation.data.participant_address,
            }],
      );
      // Re-checked at send time, not only at selection time: a thread can be
      // closed, or a patient unlinked, between choosing recipients and sending.
      if (!plan || plan.send === false) {
        await client
          .from("bulk_message_recipients")
          .update({
            status: "skipped",
            failure_code: plan && plan.send === false ? plan.reason : "no_address",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        continue;
      }

      const result = await send({
        clinicId: input.clinicId,
        recipient: plan.recipient,
        body,
        relatedType: "manual",
        conversationId: plan.conversationId,
        channelPreference: ["whatsapp"],
      });

      if (result.ok) {
        await client
          .from("bulk_message_recipients")
          .update({
            status: "sent",
            outbound_message_id: result.outboundMessageId,
            failure_code: null,
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      } else if (!isRetryableSendFailure(result.code) && result.outboundMessageId) {
        // Ambiguous: the provider may have accepted it. Recorded as sent so it
        // is never retried, and pointed at the outbound row whose delivery
        // callback remains the authority on what actually happened.
        await client
          .from("bulk_message_recipients")
          .update({
            status: "sent",
            outbound_message_id: result.outboundMessageId,
            failure_code: result.code,
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      } else {
        await client
          .from("bulk_message_recipients")
          .update({
            status: "failed",
            outbound_message_id: result.outboundMessageId ?? null,
            failure_code: result.code,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }

      if (BULK_SEND_DELAY_MS > 0) await delay(BULK_SEND_DELAY_MS);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BULK_SEND_CONCURRENCY, Math.max(queue.length, 1)) }, worker),
  );

  const finalResult = await client
    .from("bulk_message_recipients")
    .select("status")
    .eq("job_id", input.jobId);
  const rows = finalResult.error ? [] : finalResult.data ?? [];
  const counts = {
    sent: rows.filter((row) => row.status === "sent").length,
    failed: rows.filter((row) => row.status === "failed" || row.status === "sending").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
  };

  await client
    .from("bulk_message_jobs")
    .update({
      status: bulkJobOutcome(counts),
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.jobId);

  return counts;
}
