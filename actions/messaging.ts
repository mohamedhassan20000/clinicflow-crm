"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  connectDialog360Channel,
  getWhatsAppChannelStatus,
  type WhatsAppChannelStatus,
} from "@/lib/messaging/channel-management";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  deleteDialog360Template,
  submitDialog360Template,
} from "@/lib/messaging/whatsapp-dialog360";
import { sendMessage } from "@/lib/messaging/send";
import {
  createClinicScopedAdminClient,
  setInboxConversationPatient,
} from "@/lib/supabase/admin";
import {
  dialog360ConnectionSchema,
  conversationAssignmentSchema,
  conversationPatientSchema,
  conversationStatusSchema,
  inboxReplySchema,
  messageTemplateDeleteSchema,
  messageTemplateSchema,
  templateSubmissionSchema,
} from "@/lib/validations/messaging";

export type MessagingActionResult = {
  success?: boolean;
  error?: string;
  providerTemplateId?: string;
  outboundMessageId?: string;
};

async function messagingError(key: Parameters<typeof actionError>[0]) {
  return { error: await actionError(key) };
}

async function whatsappAllowed(clinicId: string): Promise<boolean> {
  return hasFeature(await getEntitlements(clinicId), "whatsapp");
}

export async function readOwnWhatsAppChannelStatus(): Promise<WhatsAppChannelStatus> {
  const user = await requireRole(["admin", "manager"]);
  return getWhatsAppChannelStatus(user.clinicId);
}

export async function connectWhatsAppChannel(
  _previous: MessagingActionResult | null,
  formData: FormData,
): Promise<MessagingActionResult> {
  const user = await requireMutationRole("admin");
  if (!(await whatsappAllowed(user.clinicId))) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const parsed = dialog360ConnectionSchema.safeParse({
    apiKey: formData.get("apiKey"),
    phoneNumberId: formData.get("phoneNumberId"),
    displayPhoneNumber: formData.get("displayPhoneNumber"),
  });
  if (!parsed.success) {
    return { error: await actionError("messaging.enterValid360dialogConnectionDetails") };
  }

  const result = await connectDialog360Channel({
    clinicId: user.clinicId,
    ...parsed.data,
  });
  if (!result.ok) {
    const key =
      result.code === "CONFIGURATION"
        ? "messaging.messagingEnvironmentIsNotConfigured"
        : result.code === "PROVIDER"
          ? "messaging.couldNotVerify360dialogCredentials"
          : "messaging.couldNotSaveWhatsAppConnection";
    return { error: await actionError(key) };
  }
  revalidatePath("/settings/messaging");
  return { success: true };
}

/** Backend submission boundary consumed by P3D's future template CRUD UI. */
export async function submitWhatsAppTemplate(
  templateId: string,
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION",
): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  if (!(await whatsappAllowed(user.clinicId))) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const parsed = templateSubmissionSchema.safeParse({ templateId, category });
  if (!parsed.success) {
    return { error: await actionError("messaging.invalidTemplateSubmission") };
  }

  const client = createClinicScopedAdminClient(user.clinicId);
  const channel = await client
    .from("clinic_channels")
    .select("credentials_encrypted")
    .eq("channel", "whatsapp")
    .eq("provider", "dialog360")
    .eq("status", "active")
    .maybeSingle();
  if (channel.error || !channel.data?.credentials_encrypted) {
    return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
  }
  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.data.credentials_encrypted);
  } catch {
    return { error: await actionError("messaging.whatsAppChannelCredentialsUnavailable") };
  }

  // Claim the submission first (P3-M3): one conditional UPDATE both guards
  // the legal transitions (only draft/rejected may be submitted) and blocks a
  // concurrent submit, edit, delete, or webhook write from racing this one.
  const claimed = await client
    .from("message_templates")
    .update({ approval_status: "submitted" })
    .eq("id", parsed.data.templateId)
    .eq("channel", "whatsapp")
    .in("approval_status", ["draft", "rejected"])
    .select("id, name, language, body")
    .maybeSingle();
  if (claimed.error || !claimed.data) {
    return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
  }

  const submitted = await submitDialog360Template(
    {
      name: claimed.data.name,
      language: claimed.data.language,
      body: claimed.data.body,
      category: parsed.data.category,
    },
    credentials,
  );
  if (!submitted.ok) {
    // Nothing new exists at the provider: revert the claim to an editable
    // draft (detaching any stale provider id from a prior rejection). The
    // status guard keeps this from clobbering a concurrent webhook write.
    await client
      .from("message_templates")
      .update({ approval_status: "draft", provider_template_id: null })
      .eq("id", claimed.data.id)
      .eq("approval_status", "submitted");
    return { error: await actionError("messaging.couldNotSubmitWhatsAppTemplate") };
  }

  // The provider now tracks this template; persist the id with retries so a
  // transient write failure does not strand an untracked provider template.
  let update: { error: unknown } = { error: new Error("unattempted") };
  for (let attempt = 0; attempt < 3 && update.error; attempt += 1) {
    update = await client
      .from("message_templates")
      .update({
        provider_template_id: submitted.providerTemplateId,
        approval_status: submitted.status,
      })
      .eq("id", claimed.data.id)
      .eq("approval_status", "submitted");
  }
  if (update.error) {
    return { error: await actionError("messaging.couldNotSaveTemplateSubmission") };
  }
  revalidatePath("/settings/templates");
  return {
    success: true,
    providerTemplateId: submitted.providerTemplateId,
  };
}

/**
 * P3D §7.4 — template CRUD for the settings surface. Templates are clinic
 * content; writes stay on reviewed service-role paths (the tables carry no
 * authenticated write policies). Submitted/approved WhatsApp templates are
 * locked: editing would desynchronize the provider-registered body.
 */
export async function saveMessageTemplate(
  _previous: MessagingActionResult | null,
  formData: FormData,
): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const parsed = messageTemplateSchema.safeParse({
    id: (formData.get("id") as string) || null,
    channel: formData.get("channel"),
    name: formData.get("name"),
    language: formData.get("language"),
    body: formData.get("body"),
    variables: formData.getAll("variables"),
  });
  if (!parsed.success) {
    return messagingError("messaging.invalidTemplateDetails");
  }

  const client = createClinicScopedAdminClient(user.clinicId);
  if (parsed.data.id) {
    // One conditional UPDATE (P3-M3): the lock check and the write are the
    // same statement, so a concurrent submit or webhook approval cannot slip
    // between a read and a write. Submitted/approved templates never match.
    const updated = await client
      .from("message_templates")
      .update({
        channel: parsed.data.channel,
        name: parsed.data.name,
        language: parsed.data.language,
        body: parsed.data.body,
        variables: parsed.data.variables,
        // Any edit returns the template to draft and detaches the provider id.
        approval_status: "draft",
        provider_template_id: null,
      })
      .eq("id", parsed.data.id)
      .in("approval_status", ["draft", "rejected"])
      .select("id")
      .maybeSingle();
    if (updated.error) {
      return messagingError("messaging.couldNotSaveTemplate");
    }
    if (!updated.data) {
      // Distinguish "does not exist" from "locked" for the error message only;
      // the guarded write above is what enforces the rule.
      const existing = await client
        .from("message_templates")
        .select("id")
        .eq("id", parsed.data.id)
        .maybeSingle();
      return messagingError(
        existing.data ? "messaging.templateIsLocked" : "messaging.templateNotFound",
      );
    }
  } else {
    const inserted = await client.from("message_templates").insert({
      clinic_id: user.clinicId,
      channel: parsed.data.channel,
      name: parsed.data.name,
      language: parsed.data.language,
      body: parsed.data.body,
      variables: parsed.data.variables,
      approval_status: "draft",
    });
    if (inserted.error) {
      return messagingError(
        inserted.error.code === "23505"
          ? "messaging.templateNameAlreadyExists"
          : "messaging.couldNotSaveTemplate",
      );
    }
  }
  revalidatePath("/settings/templates");
  return { success: true };
}

export async function deleteMessageTemplate(
  id: string,
): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const parsed = messageTemplateDeleteSchema.safeParse({ id });
  if (!parsed.success) return messagingError("messaging.invalidTemplateDetails");

  const client = createClinicScopedAdminClient(user.clinicId);
  const existing = await client
    .from("message_templates")
    .select("id, name, channel, approval_status, provider_template_id")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (existing.error || !existing.data) {
    return messagingError("messaging.templateNotFound");
  }
  if (existing.data.approval_status === "submitted") {
    return messagingError("messaging.templateCannotBeDeletedWhileSubmitted");
  }

  // Provider-registered templates (approved, or rejected with a provider id)
  // are deleted at 360dialog first so a local delete cannot strand an
  // orphaned provider template (P3-M3). When the WhatsApp channel is gone,
  // the provider registration is unreachable and the local delete proceeds.
  if (existing.data.channel === "whatsapp" && existing.data.provider_template_id) {
    const channel = await client
      .from("clinic_channels")
      .select("credentials_encrypted")
      .eq("channel", "whatsapp")
      .eq("provider", "dialog360")
      .eq("status", "active")
      .maybeSingle();
    if (channel.error) return messagingError("messaging.couldNotDeleteTemplate");
    if (channel.data?.credentials_encrypted) {
      let credentials;
      try {
        credentials = decryptChannelCredentials(channel.data.credentials_encrypted);
      } catch {
        return messagingError("messaging.couldNotDeleteTemplate");
      }
      const removed = await deleteDialog360Template(existing.data.name, credentials);
      if (!removed.ok) {
        return messagingError("messaging.couldNotDeleteTemplate");
      }
    }
  }

  // Guarded delete: a submit that claimed the template concurrently makes
  // this match nothing instead of deleting a submitted template.
  const deleted = await client
    .from("message_templates")
    .delete()
    .eq("id", parsed.data.id)
    .neq("approval_status", "submitted")
    .select("id")
    .maybeSingle();
  if (deleted.error || !deleted.data) {
    return messagingError("messaging.couldNotDeleteTemplate");
  }
  revalidatePath("/settings/templates");
  return { success: true };
}

export async function sendInboxReply(input: {
  conversationId: string;
  body?: string;
  templateId?: string | null;
  templateParameters?: string[];
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = inboxReplySchema.safeParse({
    conversationId: input.conversationId,
    body: input.body ?? "",
    templateId: input.templateId ?? null,
    templateParameters: input.templateParameters ?? [],
  });
  if (!parsed.success) return messagingError("messaging.invalidInboxReply");

  const client = createClinicScopedAdminClient(user.clinicId);
  const [conversation, latestInbound] = await Promise.all([
    client
      .from("conversations")
      .select("id, channel, status, assigned_to, participant_address")
      .eq("id", parsed.data.conversationId)
      .maybeSingle(),
    client
      .from("inbound_messages")
      .select("sender")
      .eq("conversation_id", parsed.data.conversationId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (
    conversation.error ||
    !conversation.data ||
    conversation.data.channel !== "whatsapp" ||
    latestInbound.error ||
    !(conversation.data.participant_address ?? latestInbound.data?.sender)
  ) {
    return messagingError("messaging.conversationNotFound");
  }

  const sent = await sendMessage({
    clinicId: user.clinicId,
    recipient: conversation.data.participant_address ?? latestInbound.data!.sender,
    body: parsed.data.body,
    relatedType: "manual",
    conversationId: conversation.data.id,
    templateId: parsed.data.templateId,
    templateParameters: parsed.data.templateParameters,
    channelPreference: ["whatsapp"],
  });
  if (!sent.ok) {
    const key =
      sent.code === "SERVICE_WINDOW_CLOSED"
        ? "messaging.serviceWindowClosed"
        : sent.code === "CONVERSATION_CLOSED"
          ? "messaging.conversationClosed"
          : sent.code === "TEMPLATE_NOT_APPROVED" ||
              sent.code === "TEMPLATE_PARAMETERS_INVALID"
            ? "messaging.templateUnavailable"
            : sent.code === "USAGE_LIMIT_REACHED"
              ? "messaging.messagingLimitReached"
              : "messaging.couldNotSendReply";
    return messagingError(key);
  }

  // Replying claims an unassigned thread without overriding explicit ownership.
  if (!conversation.data.assigned_to) {
    await client
      .from("conversations")
      .update({ assigned_to: user.id })
      .eq("id", conversation.data.id)
      .is("assigned_to", null);
  }
  revalidatePath("/inbox");
  return { success: true, outboundMessageId: sent.outboundMessageId };
}

export async function updateConversationAssignment(input: {
  conversationId: string;
  assignedTo: string | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = conversationAssignmentSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");
  const client = createClinicScopedAdminClient(user.clinicId);

  if (parsed.data.assignedTo) {
    const owner = await client
      .from("profiles")
      .select("id, role")
      .eq("id", parsed.data.assignedTo)
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .maybeSingle();
    if (
      owner.error ||
      !owner.data ||
      (owner.data.role !== "admin" && owner.data.role !== "receptionist")
    ) {
      return messagingError("messaging.inboxOwnerNotFound");
    }
  }

  const updated = await client
    .from("conversations")
    .update({ assigned_to: parsed.data.assignedTo })
    .eq("id", parsed.data.conversationId)
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data) {
    return messagingError("messaging.conversationNotFound");
  }
  revalidatePath("/inbox");
  return { success: true };
}

export async function updateConversationStatus(input: {
  conversationId: string;
  status: "open" | "closed";
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = conversationStatusSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");
  const client = createClinicScopedAdminClient(user.clinicId);
  const updated = await client
    .from("conversations")
    .update({
      status: parsed.data.status,
      status_updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.conversationId)
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data) {
    return messagingError("messaging.conversationNotFound");
  }
  revalidatePath("/inbox");
  return { success: true };
}

export async function linkConversationPatient(input: {
  conversationId: string;
  patientId: string | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = conversationPatientSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");
  const updated = await setInboxConversationPatient({
    clinicId: user.clinicId,
    conversationId: parsed.data.conversationId,
    patientId: parsed.data.patientId,
  });
  if (updated.error || updated.data !== true) {
    return messagingError(
      parsed.data.patientId ? "messaging.patientNotFound" : "messaging.conversationNotFound",
    );
  }

  revalidatePath("/inbox");
  return { success: true };
}
