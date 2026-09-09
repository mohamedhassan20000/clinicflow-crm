"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole } from "@/lib/rbac";
import { createClinicScopedAdminClient, logMessagingEvent } from "@/lib/supabase/admin";
import { readLinkedDeviceSession } from "@/lib/messaging/linked-device";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import { openNewWhatsAppConversation } from "@/actions/messaging";
import { runBulkSendJob } from "@/lib/messaging/bulk-send";
import {
  BULK_STALE_AFTER_SECONDS,
  MAX_BULK_RECIPIENTS,
  interruptedResendRisk,
  planBulkRecipients,
  type BulkSkipReason,
} from "@/lib/messaging/bulk-send-plan";

/**
 * P11Q — the server half of bulk send.
 *
 * Two actions, split on purpose. `createBulkSend` writes the plan and sends
 * nothing; `runBulkSend` sends. A staff member therefore always gets to look at
 * the exact list — including who will be skipped and why — before anything
 * leaves the clinic, and the confirmation step has something real to confirm.
 *
 * Permissions are not re-invented: this is the same
 * `requireMutationRole(["admin", "receptionist"])` gate a single Inbox reply
 * passes through, because a bulk send is a number of single replies and should
 * not be reachable by anyone who could not send them one at a time.
 */

export type BulkSendActionResult = {
  success?: boolean;
  error?: string;
  jobId?: string;
  counts?: { sent: number; failed: number; skipped: number };
};

const createSchema = z
  .object({
    body: z.string().trim().min(1).max(4096),
    conversationIds: z.array(z.string().uuid()).max(MAX_BULK_RECIPIENTS).default([]),
    /**
     * Recipients chosen from the clinic's contacts or patient files rather than
     * from an Inbox thread. Each one is resolved to a conversation below,
     * through the same server path the New Conversation dialog uses, so the
     * plan, the ceiling, the skip reasons, the runner and the results view are
     * all unchanged — a contact recipient becomes an ordinary conversation
     * recipient before anything about sending is decided.
     */
    addresses: z.array(z.string().trim().min(3).max(40)).max(MAX_BULK_RECIPIENTS).default([]),
  })
  .refine(
    (value) =>
      value.conversationIds.length + value.addresses.length >= 1 &&
      value.conversationIds.length + value.addresses.length <= MAX_BULK_RECIPIENTS,
    { message: "recipient_count" },
  );

async function bulkError(key: Parameters<typeof actionError>[0]): Promise<BulkSendActionResult> {
  return { error: await actionError(key) };
}

/**
 * Whether WhatsApp is actually able to carry this right now.
 *
 * Checked once, up front, rather than discovered fifty times over. A
 * disconnected linked device would fail every recipient individually and leave
 * staff with a wall of red that says nothing more useful than "the phone is
 * offline" — so that sentence is said once, before anything is written.
 */
async function whatsappReady(clinicId: string): Promise<boolean> {
  const provider = await getActiveWhatsAppProvider(clinicId);
  if (!provider) return false;
  if (provider !== "linked_device") return true;
  const session = await readLinkedDeviceSession(clinicId);
  return session.status === "connected";
}

export async function createBulkSend(input: {
  body: string;
  conversationIds?: string[];
  addresses?: string[];
}): Promise<BulkSendActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return bulkError("messaging.invalidBulkSend");

  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return bulkError("messaging.whatsAppIsNotIncludedInYourPlan");
  }
  if (!(await whatsappReady(user.clinicId))) {
    return bulkError("messaging.bulkWhatsAppOffline");
  }

  /**
   * Contact and patient recipients become conversation recipients here, and
   * only here.
   *
   * `openNewWhatsAppConversation` is the clinic's existing, idempotent
   * "start a WhatsApp thread with this number" boundary: it normalizes the
   * address, re-checks the channel and the account, and returns the existing
   * thread when there already is one. Reusing it means a bulk send can never
   * reach a destination a staff member could not have reached one at a time,
   * and it is why nothing below this point knows that contacts exist.
   *
   * An address that cannot be opened is dropped rather than failing the whole
   * send, and the count staff confirmed is reconciled against what was
   * actually planned — the job is written with the number of rows it really
   * has.
   */
  const resolvedIds = [...parsed.data.conversationIds];
  for (const address of parsed.data.addresses) {
    const opened = await openNewWhatsAppConversation({ participant: address });
    if (opened.conversationId) resolvedIds.push(opened.conversationId);
  }
  // The same collapse the planner performs on ids, applied one step earlier:
  // an address whose thread is already in the selection must not become a
  // second recipient row for the same person.
  const conversationIds = [...new Set(resolvedIds)];
  if (conversationIds.length === 0) return bulkError("messaging.invalidBulkSend");

  const client = createClinicScopedAdminClient(user.clinicId);
  const conversationResult = await client
    .from("conversations")
    .select("id, channel, status, participant_address")
    .in("id", conversationIds);
  if (conversationResult.error) return bulkError("messaging.couldNotStartBulkSend");

  const plans = planBulkRecipients(
    (conversationResult.data ?? []).map((row) => ({
      id: row.id,
      channel: row.channel,
      status: row.status,
      participantAddress: row.participant_address,
    })),
  );
  // A conversation the clinic cannot see is not silently dropped either: it
  // simply never reaches the plan, and the count staff confirm is the count of
  // rows actually written below.
  if (plans.length === 0) return bulkError("messaging.invalidBulkSend");

  const job = await client
    .from("bulk_message_jobs")
    .insert({
      clinic_id: user.clinicId,
      created_by: user.id,
      body: parsed.data.body.trim(),
      total_recipients: plans.length,
      status: "pending",
    })
    .select("id")
    .single();
  if (job.error || !job.data) return bulkError("messaging.couldNotStartBulkSend");

  // Skips are written as rows, not omitted. A recipient that will not be
  // contacted must still appear in the result list with its reason — a silently
  // shortened list is indistinguishable from a successful send.
  const recipients = await client.from("bulk_message_recipients").insert(
    plans.map((plan) => ({
      clinic_id: user.clinicId,
      job_id: job.data.id,
      conversation_id: plan.conversationId,
      status: plan.send ? ("pending" as const) : ("skipped" as const),
      failure_code: plan.send ? null : (plan.reason satisfies BulkSkipReason),
    })),
  );
  if (recipients.error) return bulkError("messaging.couldNotStartBulkSend");

  /**
   * The audit trail, on the clinic's existing one.
   *
   * `created_by` records the initiator on the job itself, but a bulk send is
   * exactly the kind of action a clinic admin should be able to find later
   * without knowing this feature exists — so it also lands in `audit_logs`
   * beside connection changes and template approvals, where the activity
   * timeline already looks.
   *
   * PHI-free by construction: counts and ids only. The message body is
   * deliberately absent — it was written to patients, and an audit row is read
   * by a wider audience than the thread is.
   */
  await logMessagingEvent({
    clinicId: user.clinicId,
    event: "bulk_send_created",
    recordId: job.data.id,
    summary: {
      initiatedBy: user.id,
      recipientCount: plans.filter((plan) => plan.send).length,
      skippedCount: plans.filter((plan) => !plan.send).length,
    },
  });

  return { success: true, jobId: job.data.id };
}

/**
 * Sends, resumes, or retries — all the same call.
 *
 * There is no separate retry path because there does not need to be one: the
 * claim inside `runBulkSendJob` only ever yields recipients that are `pending`
 * or `failed`, so running a finished job again retries exactly the failures and
 * touches nothing that succeeded. That makes "Retry failed", "resume after a
 * refresh" and "the button was double-clicked" one code path with one set of
 * guarantees, rather than three with three.
 */
export async function runBulkSend(input: { jobId: string }): Promise<BulkSendActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  if (!z.string().uuid().safeParse(input.jobId).success) {
    return bulkError("messaging.invalidBulkSend");
  }

  const client = createClinicScopedAdminClient(user.clinicId);
  const job = await client
    .from("bulk_message_jobs")
    .select("id, status")
    .eq("id", input.jobId)
    .maybeSingle();
  if (job.error || !job.data) return bulkError("messaging.invalidBulkSend");

  if (!(await whatsappReady(user.clinicId))) {
    return bulkError("messaging.bulkWhatsAppOffline");
  }

  const counts = await runBulkSendJob({ clinicId: user.clinicId, jobId: input.jobId });
  revalidatePath("/inbox");
  return { success: true, jobId: input.jobId, counts };
}

/** One recipient as the results list shows it. No clinical data, no message body. */
export type BulkRecipientView = {
  id: string;
  conversationId: string;
  /**
   * What to call this recipient in the results list, resolved server-side from
   * the conversation itself.
   *
   * It used to be looked up in the browser against the rows the staff member
   * had ticked, which stopped working the moment a recipient could come from
   * the contact directory instead of from a visible thread — those threads are
   * opened during the send and the browser has never seen them. Reading the
   * name from the row the recipient actually points at is both correct for
   * every source and one less thing the client has to keep in step.
   *
   * `null` when the conversation could not be read; the dialog says so rather
   * than inventing a name.
   */
  name: string | null;
  status: "pending" | "sending" | "sent" | "failed" | "skipped" | "review";
  failureCode: string | null;
};

export type BulkJobView = {
  id: string;
  status: "pending" | "running" | "completed" | "completed_with_failures" | "failed";
  totalRecipients: number;
  recipients: BulkRecipientView[];
};

/**
 * The authoritative state of one job, for the progress and results view.
 *
 * Read straight from the recipient rows rather than from anything the browser
 * has been accumulating, so a refresh mid-job shows exactly what is true — which
 * is the whole reason the state is durable in the first place.
 */
export async function readBulkSendJob(input: {
  jobId: string;
}): Promise<{ job?: BulkJobView; error?: string }> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  if (!z.string().uuid().safeParse(input.jobId).success) {
    return { error: await actionError("messaging.invalidBulkSend") };
  }
  const client = createClinicScopedAdminClient(user.clinicId);
  /**
   * Surface interruptions as part of simply looking at the job.
   *
   * A separate "check for stuck sends" button would only ever be pressed by
   * someone who already suspected a problem, which is precisely the person who
   * does not need it. This flags nothing that is merely in progress — the
   * function enforces its own staleness floor — and it sends nothing.
   */
  await client.rpc("flag_stalled_bulk_recipients", {
    p_clinic_id: user.clinicId,
    p_job_id: input.jobId,
    p_stale_seconds: BULK_STALE_AFTER_SECONDS,
  });
  const [job, recipients] = await Promise.all([
    client
      .from("bulk_message_jobs")
      .select("id, status, total_recipients")
      .eq("id", input.jobId)
      .maybeSingle(),
    client
      .from("bulk_message_recipients")
      .select("id, conversation_id, status, failure_code")
      .eq("job_id", input.jobId)
      .order("created_at", { ascending: true }),
  ]);
  if (job.error || !job.data) return { error: await actionError("messaging.invalidBulkSend") };
  const recipientRows = recipients.error ? [] : recipients.data ?? [];
  // One read for the names, over exactly the conversations this job points at.
  // A failure here costs the list its labels, never its results.
  const conversationIds = [...new Set(recipientRows.map((row) => row.conversation_id))];
  const named = conversationIds.length
    ? await client
        .from("conversations")
        .select("id, display_name, participant_address")
        .in("id", conversationIds)
    : { data: [], error: null };
  const nameById = new Map(
    (named.error ? [] : named.data ?? []).map((row) => [
      row.id,
      row.display_name ?? row.participant_address ?? null,
    ]),
  );
  return {
    job: {
      id: job.data.id,
      status: job.data.status as BulkJobView["status"],
      totalRecipients: job.data.total_recipients,
      recipients: recipientRows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        name: nameById.get(row.conversation_id) ?? null,
        status: row.status as BulkRecipientView["status"],
        failureCode: row.failure_code,
      })),
    },
  };
}


/**
 * Resolves one interrupted recipient, by explicit human decision.
 *
 * This is the only way out of `review`, and it is deliberately not automatic.
 * Two decisions are offered and neither of them is taken on the clinic's behalf:
 *
 *   * `dismiss` — accept that the outcome is unknown and stop tracking it.
 *     Nothing is sent.
 *   * `resend` — send it again, but only once the evidence says it is safe.
 *
 * The safety check is not advisory. Before releasing the recipient, the ordinary
 * `outbound_messages` table is consulted for a manual message on this
 * conversation created at or after the claim. If one exists, WhatsApp may
 * already have delivered it, and the resend is refused outright rather than
 * offered with a warning — a duplicate message to a patient cannot be withdrawn,
 * so this is not a risk to delegate to a confirmation dialog.
 */
export async function resolveInterruptedBulkRecipient(input: {
  recipientId: string;
  decision: "resend" | "dismiss";
}): Promise<BulkSendActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  if (!z.string().uuid().safeParse(input.recipientId).success) {
    return bulkError("messaging.invalidBulkSend");
  }
  const client = createClinicScopedAdminClient(user.clinicId);
  const recipient = await client
    .from("bulk_message_recipients")
    .select("id, job_id, conversation_id, status, claimed_at")
    .eq("id", input.recipientId)
    .maybeSingle();
  if (recipient.error || !recipient.data) return bulkError("messaging.invalidBulkSend");
  // Only an interrupted recipient is resolvable this way. Anything else is
  // already in a state the ordinary flow owns.
  if (recipient.data.status !== "review") return bulkError("messaging.bulkRecipientNotInReview");

  if (input.decision === "dismiss") {
    const dismissed = await client
      .from("bulk_message_recipients")
      .update({
        status: "skipped",
        failure_code: "interrupted_dismissed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.recipientId)
      .eq("status", "review");
    if (dismissed.error) return bulkError("messaging.couldNotStartBulkSend");
    return { success: true };
  }

  // The duplicate-risk boundary, checked against the ordinary outbound record.
  const outbound = await client
    .from("outbound_messages")
    .select("created_at")
    .eq("related_type", "manual")
    .eq("related_id", recipient.data.conversation_id);
  if (outbound.error) return bulkError("messaging.couldNotStartBulkSend");
  const risk = interruptedResendRisk({
    claimedAt: recipient.data.claimed_at,
    outboundCreatedAt: (outbound.data ?? []).map((row) => row.created_at),
  });
  if (risk === "duplicate_risk") return bulkError("messaging.bulkResendWouldDuplicate");

  if (!(await whatsappReady(user.clinicId))) {
    return bulkError("messaging.bulkWhatsAppOffline");
  }

  const released = await client.rpc("release_bulk_recipient_for_retry", {
    p_clinic_id: user.clinicId,
    p_recipient_id: input.recipientId,
  });
  // Losing this race means somebody else already resolved the recipient; the
  // send must not proceed on a row this request no longer owns.
  if (released.error || !released.data?.length) {
    return bulkError("messaging.bulkRecipientNotInReview");
  }

  const counts = await runBulkSendJob({
    clinicId: user.clinicId,
    jobId: recipient.data.job_id,
  });
  revalidatePath("/inbox");
  return { success: true, jobId: recipient.data.job_id, counts };
}
