"use server";

import { createHash, randomUUID } from "node:crypto";
import { clearBookingStageEscalation } from "@/lib/ai/booking-stage-store";
import { resetConversationAssistantState } from "@/lib/ai/conversation-reset";
import { scrubInternalFieldNames } from "@/lib/ai/patient-intake-contract";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  connectDialog360Channel,
  getCurrentLinkedWhatsAppAccount,
  getActiveWhatsAppProvider,
  getWhatsAppChannelStatus,
  type WhatsAppChannelStatus,
} from "@/lib/messaging/channel-management";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  EMPTY_CONTACT_DIRECTORY,
  loadInboxContactDirectory,
  type InboxContactDirectory,
} from "@/lib/messaging/inbox-contacts";
import {
  deleteDialog360Template,
  submitDialog360Template,
} from "@/lib/messaging/whatsapp-dialog360";
import { submitMetaTemplate } from "@/lib/messaging/whatsapp-meta";
import { sendMessage } from "@/lib/messaging/send";
import { logOutboundMediaDiagnostic } from "@/lib/messaging/outbound-media-diagnostics";
import {
  extensionForOutboundMime,
  isAllowedOutboundDocumentMime,
  MAX_OUTBOUND_MEDIA_BYTES,
  outboundMediaKind,
  safeOutboundFilename,
  sniffOutboundMimeType,
} from "@/lib/messaging/outbound-media";
import { normalizePhone } from "@/lib/phone/registry";
import {
  claimOutboundMedia,
  createClinicScopedAdminClient,
  finalizeOutboundMedia,
  holdOutboundMedia,
  isSendableStoragePath,
  logMessagingEvent,
  openWhatsAppConversation,
  openLinkedDeviceConversation,
  removeOutboundMedia,
  releaseOutboundMedia,
  setConversationAiOverride,
  setConversationAiPause,
  setInboxConversationPatient,
  uploadOutboundMedia,
  WHATSAPP_OUTBOUND_BUCKET,
} from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  dialog360ConnectionSchema,
  conversationAiOverrideSchema,
  conversationAiPauseSchema,
  conversationAssignmentSchema,
  conversationPatientSchema,
  conversationStatusSchema,
  inboxReplySchema,
  inboxExistingDocumentSchema,
  inboxMediaIdSchema,
  messageTemplateDeleteSchema,
  messageTemplateSchema,
  newWhatsappConversationSchema,
  templateSubmissionSchema,
} from "@/lib/validations/messaging";

export type MessagingActionResult = {
  success?: boolean;
  error?: string;
  providerTemplateId?: string;
  outboundMessageId?: string;
  conversationId?: string;
  media?: {
    id: string;
    fileName: string | null;
    mimeType: string;
    kind: "image" | "document" | "audio";
    byteSize: number;
  };
  /** The same claimed object is back in draft and may be sent again. */
  mediaRetryable?: boolean;
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
  const metaChannel = await client
    .from("clinic_channels")
    .select("credentials_encrypted, provider_account_id")
    .eq("channel", "whatsapp")
    .eq("provider", "meta")
    .in("status", ["pending", "active", "error"])
    .maybeSingle();
  if (metaChannel.error) {
    return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
  }
  if (
    metaChannel.data?.credentials_encrypted &&
    metaChannel.data.provider_account_id
  ) {
    let credentials;
    try {
      credentials = decryptChannelCredentials(metaChannel.data.credentials_encrypted);
    } catch {
      return { error: await actionError("messaging.whatsAppChannelCredentialsUnavailable") };
    }
    const template = await client
      .from("message_templates")
      .select("id, name, language, body")
      .eq("id", parsed.data.templateId)
      .eq("channel", "whatsapp")
      .maybeSingle();
    if (template.error || !template.data) {
      return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
    }
    const existing = await client
      .from("message_template_provider_bindings")
      .select("approval_status")
      .eq("template_id", template.data.id)
      .eq("provider", "meta")
      .maybeSingle();
    if (
      existing.error ||
      existing.data?.approval_status === "submitted" ||
      existing.data?.approval_status === "approved"
    ) {
      return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
    }
    const claimPayload = {
      clinic_id: user.clinicId,
      template_id: template.data.id,
      provider: "meta" as const,
      provider_account_id: metaChannel.data.provider_account_id,
      provider_template_id: null,
      approval_status: "submitted" as const,
    };
    const claimed = existing.data
      ? await client
          .from("message_template_provider_bindings")
          .update(claimPayload)
          .eq("template_id", template.data.id)
          .eq("provider", "meta")
          .in("approval_status", ["draft", "rejected"])
          .select("id")
          .maybeSingle()
      : await client
          .from("message_template_provider_bindings")
          .insert(claimPayload)
          .select("id")
          .maybeSingle();
    if (claimed.error || !claimed.data) {
      return { error: await actionError("messaging.whatsAppTemplateOrChannelNotFound") };
    }
    const submitted = await submitMetaTemplate(
      {
        name: template.data.name,
        language: template.data.language,
        body: template.data.body,
        category: parsed.data.category,
      },
      credentials,
    );
    if (!submitted.ok) {
      await client
        .from("message_template_provider_bindings")
        .update({ approval_status: "draft", provider_template_id: null })
        .eq("template_id", template.data.id)
        .eq("provider", "meta")
        .eq("approval_status", "submitted");
      return { error: await actionError("messaging.couldNotSubmitWhatsAppTemplate") };
    }
    const saved = await client
      .from("message_template_provider_bindings")
      .update({
        provider_template_id: submitted.providerTemplateId,
        approval_status: submitted.status,
      })
      .eq("template_id", template.data.id)
      .eq("provider", "meta")
      .eq("approval_status", "submitted");
    if (saved.error) {
      return { error: await actionError("messaging.couldNotSaveTemplateSubmission") };
    }
    const audited = await logMessagingEvent({
      clinicId: user.clinicId,
      event: "template_status",
      recordId: template.data.id,
      summary: {
        provider: "meta",
        status: submitted.status,
      },
    });
    if (audited.error) {
      return { error: await actionError("messaging.couldNotSaveTemplateSubmission") };
    }
    revalidatePath("/settings/templates");
    return {
      success: true,
      providerTemplateId: submitted.providerTemplateId,
    };
  }

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
  const binding = await client
    .from("message_template_provider_bindings")
    .upsert(
      {
        clinic_id: user.clinicId,
        template_id: claimed.data.id,
        provider: "dialog360",
        provider_account_id: null,
        provider_template_id: submitted.providerTemplateId,
        approval_status: submitted.status,
      },
      { onConflict: "template_id,provider" },
    );
  if (binding.error) {
    return { error: await actionError("messaging.couldNotSaveTemplateSubmission") };
  }
  const audited = await logMessagingEvent({
    clinicId: user.clinicId,
    event: "template_status",
    recordId: claimed.data.id,
    summary: {
      provider: "dialog360",
      status: submitted.status,
    },
  });
  if (audited.error) {
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

/** Opens one thread by number/contact and never creates a patient. */
export async function openNewWhatsAppConversation(input: {
  participant: string;
  displayName?: string | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = newWhatsappConversationSchema.safeParse(input);
  const participant = parsed.success ? normalizePhone(parsed.data.participant) : null;
  if (!parsed.success || !participant) {
    return messagingError("messaging.invalidWhatsAppRecipient");
  }
  const provider = await getActiveWhatsAppProvider(user.clinicId);
  if (!(await whatsappAllowed(user.clinicId)) || !provider) {
    return messagingError("messaging.whatsAppChannelUnavailable");
  }
  const linkedAccount = provider === "linked_device"
    ? await getCurrentLinkedWhatsAppAccount(user.clinicId)
    : null;
  if (provider === "linked_device" && !linkedAccount) {
    return messagingError("messaging.whatsAppChannelUnavailable");
  }
  const openInput = {
    clinicId: user.clinicId,
    participantAddress: participant,
    displayName: parsed.data.displayName ?? null,
    actorId: user.id,
  };
  const opened = linkedAccount
    ? await openLinkedDeviceConversation({ ...openInput, authenticatedAccountId: linkedAccount })
    : await openWhatsAppConversation(openInput);
  const row = opened.data?.[0];
  if (opened.error || !row?.conversation_id) {
    return messagingError("messaging.couldNotOpenConversation");
  }
  revalidatePath("/inbox");
  return { success: true, conversationId: row.conversation_id };
}

/**
 * Re-reads the New Conversation directory for the caller's own clinic.
 *
 * Contacts are imported asynchronously: the worker persists them minutes after
 * a pairing, long after the Inbox page has rendered its RSC payload with zero
 * of them. Without this, the only way to see them was a full page reload.
 *
 * Deliberately the lightest thing that works — one read-only server action the
 * dialog calls when it opens — rather than a realtime subscription. It creates
 * nothing: no conversation, no patient, no contact→patient link.
 */
export async function refreshInboxContacts(): Promise<InboxContactDirectory> {
  const user = await requireRole(["admin", "receptionist"]);
  if (!(await whatsappAllowed(user.clinicId))) return EMPTY_CONTACT_DIRECTORY;
  return loadInboxContactDirectory(user.clinicId);
}

async function requireOpenLinkedDeviceConversation(clinicId: string, conversationId: string) {
  const client = createClinicScopedAdminClient(clinicId);
  const [conversation, provider, linkedAccount] = await Promise.all([
    client
      .from("conversations")
      .select("id, patient_id, channel, status, whatsapp_account_id")
      .eq("id", conversationId)
      .maybeSingle(),
    getActiveWhatsAppProvider(clinicId),
    getCurrentLinkedWhatsAppAccount(clinicId),
  ]);
  if (
    conversation.error ||
    !conversation.data ||
    conversation.data.channel !== "whatsapp" ||
    conversation.data.status !== "open" ||
    provider !== "linked_device" ||
    !linkedAccount ||
    conversation.data.whatsapp_account_id !== linkedAccount
  ) {
    return null;
  }
  return conversation.data;
}

/**
 * Sniffs and stores one browser upload/recording, returning only an opaque draft
 * id to the client. Media bytes never travel through the worker request body.
 */
export async function prepareInboxMediaUpload(
  formData: FormData,
): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const conversationId = String(formData.get("conversationId") ?? "");
  const parsedConversation = z.string().uuid().safeParse(conversationId);
  const source = formData.get("source") === "voice_note" ? "voice_note" : "upload";
  const file = formData.get("file");
  if (!parsedConversation.success || !(file instanceof File) || file.size <= 0) {
    return messagingError("messaging.invalidMediaUpload");
  }
  if (file.size > MAX_OUTBOUND_MEDIA_BYTES) {
    return messagingError("messaging.mediaTooLarge");
  }
  const conversation = await requireOpenLinkedDeviceConversation(
    user.clinicId,
    parsedConversation.data,
  );
  if (!conversation) return messagingError("messaging.linkedDeviceMediaUnavailable");

  logOutboundMediaDiagnostic({
    stage: "upload_started",
    clinicId: user.clinicId,
    source,
    byteSize: file.size,
    outcome: "started",
  });

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_OUTBOUND_MEDIA_BYTES) {
    return messagingError(bytes.length === 0 ? "messaging.invalidMediaUpload" : "messaging.mediaTooLarge");
  }
  const mimeType = sniffOutboundMimeType(bytes, file.type);
  const kind = mimeType ? outboundMediaKind(mimeType, source === "voice_note") : null;
  if (!mimeType || !kind) return messagingError("messaging.unsupportedMediaType");

  const mediaId = randomUUID();
  const storagePath = `${user.clinicId}/${new Date().toISOString().slice(0, 7)}/${mediaId}.${extensionForOutboundMime(mimeType)}`;
  const uploaded = await uploadOutboundMedia({
    clinicId: user.clinicId,
    path: storagePath,
    bytes,
    contentType: mimeType,
  });
  logOutboundMediaDiagnostic({
    stage: "upload_completed",
    clinicId: user.clinicId,
    source,
    mediaKind: kind,
    bucket: WHATSAPP_OUTBOUND_BUCKET,
    byteSize: bytes.length,
    outcome: uploaded.error ? "failed" : "completed",
    reasonCode: uploaded.error ? "storage_upload_failed" : null,
  });
  if (uploaded.error) return messagingError("messaging.couldNotUploadMedia");

  const fileName = safeOutboundFilename(file.name) ?? (source === "voice_note" ? "voice-note" : null);
  const inserted = await createClinicScopedAdminClient(user.clinicId)
    .from("outbound_message_media")
    .insert({
      id: mediaId,
      clinic_id: user.clinicId,
      conversation_id: conversation.id,
      created_by: user.id,
      source,
      media_kind: kind,
      mime_type: mimeType,
      file_name: fileName,
      byte_size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bucket: WHATSAPP_OUTBOUND_BUCKET,
      storage_path: storagePath,
    });
  if (inserted.error) {
    await removeOutboundMedia({ clinicId: user.clinicId, paths: [storagePath] });
    return messagingError("messaging.couldNotPrepareMedia");
  }
  return {
    success: true,
    media: { id: mediaId, fileName, mimeType, kind, byteSize: bytes.length },
  };
}

/** References one patient-linked ClinicFlow document without copying it. */
export async function prepareInboxExistingDocument(input: {
  conversationId: string;
  source: "patient_document" | "clinic_document";
  recordId: string;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = inboxExistingDocumentSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.documentUnavailable");
  const conversation = await requireOpenLinkedDeviceConversation(
    user.clinicId,
    parsed.data.conversationId,
  );
  if (!conversation?.patient_id) return messagingError("messaging.documentRequiresLinkedPatient");

  // Authenticated reads deliberately retain the document tables' own RLS in
  // addition to the explicit same-patient/same-clinic predicates below.
  const supabase = await createClient();
  let document: {
    storagePath: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    bucket: "patient-assets" | "clinic-documents";
  } | null = null;
  if (parsed.data.source === "patient_document") {
    const result = await supabase
      .from("patient_documents")
      .select("id, file_name, mime_type, size_bytes, storage_path")
      .eq("id", parsed.data.recordId)
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", conversation.patient_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!result.error && result.data && isAllowedOutboundDocumentMime(result.data.mime_type)) {
      document = {
        storagePath: result.data.storage_path,
        fileName: result.data.file_name,
        mimeType: result.data.mime_type,
        byteSize: Number(result.data.size_bytes),
        bucket: "patient-assets",
      };
    }
  } else {
    const result = await supabase
      .from("documents")
      .select("id, document_number, pdf_storage_path")
      .eq("id", parsed.data.recordId)
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", conversation.patient_id)
      .eq("status", "issued")
      .not("pdf_storage_path", "is", null)
      .maybeSingle();
    if (!result.error && result.data?.pdf_storage_path) {
      const downloaded = await supabase.storage
        .from("clinic-documents")
        .download(result.data.pdf_storage_path);
      if (!downloaded.error && downloaded.data.size > 0) {
        document = {
          storagePath: result.data.pdf_storage_path,
          fileName: `${result.data.document_number}.pdf`,
          mimeType: "application/pdf",
          byteSize: downloaded.data.size,
          bucket: "clinic-documents",
        };
      }
    }
  }
  if (
    !document ||
    document.byteSize <= 0 ||
    document.byteSize > MAX_OUTBOUND_MEDIA_BYTES ||
    !isSendableStoragePath(document.bucket, document.storagePath, user.clinicId)
  ) {
    return messagingError("messaging.documentUnavailable");
  }

  const mediaId = randomUUID();
  const inserted = await createClinicScopedAdminClient(user.clinicId)
    .from("outbound_message_media")
    .insert({
      id: mediaId,
      clinic_id: user.clinicId,
      conversation_id: conversation.id,
      created_by: user.id,
      source: parsed.data.source,
      media_kind: document.mimeType.startsWith("image/") ? "image" : "document",
      mime_type: document.mimeType,
      file_name: safeOutboundFilename(document.fileName),
      byte_size: document.byteSize,
      bucket: document.bucket,
      storage_path: document.storagePath,
      source_record_id: parsed.data.recordId,
    });
  if (inserted.error) return messagingError("messaging.couldNotPrepareMedia");
  return {
    success: true,
    media: {
      id: mediaId,
      fileName: safeOutboundFilename(document.fileName),
      mimeType: document.mimeType,
      kind: document.mimeType.startsWith("image/") ? "image" : "document",
      byteSize: document.byteSize,
    },
  };
}

/** Removes an unsent draft and its private upload, if it owns bytes. */
export async function discardInboxMedia(input: {
  conversationId: string;
  mediaId: string;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = inboxMediaIdSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.mediaUnavailable");
  const client = createClinicScopedAdminClient(user.clinicId);
  const media = await client
    .from("outbound_message_media")
    .select("id, source, bucket, storage_path")
    .eq("id", parsed.data.mediaId)
    .eq("conversation_id", parsed.data.conversationId)
    .eq("status", "draft")
    .maybeSingle();
  if (media.error || !media.data) return messagingError("messaging.mediaUnavailable");
  if (media.data.bucket === WHATSAPP_OUTBOUND_BUCKET) {
    await removeOutboundMedia({ clinicId: user.clinicId, paths: [media.data.storage_path] });
  }
  const deleted = await client
    .from("outbound_message_media")
    .delete()
    .eq("id", media.data.id)
    .eq("status", "draft");
  return deleted.error ? messagingError("messaging.mediaUnavailable") : { success: true };
}

export async function sendInboxReply(input: {
  conversationId: string;
  body?: string;
  templateId?: string | null;
  templateParameters?: string[];
  mediaId?: string | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = inboxReplySchema.safeParse({
    conversationId: input.conversationId,
    body: input.body ?? "",
    templateId: input.templateId ?? null,
    templateParameters: input.templateParameters ?? [],
    mediaId: input.mediaId ?? null,
  });
  if (!parsed.success) return messagingError("messaging.invalidInboxReply");

  const client = createClinicScopedAdminClient(user.clinicId);
  const [conversation, latestInbound] = await Promise.all([
    client
      .from("conversations")
      .select("id, patient_id, channel, status, assigned_to, participant_address, whatsapp_account_id")
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
  const activeProvider = await getActiveWhatsAppProvider(user.clinicId);
  const activeLinkedAccount = activeProvider === "linked_device"
    ? await getCurrentLinkedWhatsAppAccount(user.clinicId)
    : null;
  if (
    (activeProvider === "linked_device" &&
      (!activeLinkedAccount || conversation.data.whatsapp_account_id !== activeLinkedAccount)) ||
    (activeProvider !== "linked_device" &&
      (conversation.data.whatsapp_account_id ?? null) !== null)
  ) {
    return messagingError("messaging.conversationNotFound");
  }

  let media:
    | {
        mediaId: string;
        kind: "image" | "document" | "audio";
        mimeType: string;
        bucket: "whatsapp-outbound" | "patient-assets" | "clinic-documents";
        storagePath: string;
        fileName: string | null;
        voiceNote: boolean;
      }
    | undefined;
  if (parsed.data.mediaId) {
    const claimed = await claimOutboundMedia({
      clinicId: user.clinicId,
      mediaId: parsed.data.mediaId,
      conversationId: conversation.data.id,
    });
    const row = claimed.data?.[0];
    if (claimed.error || !row) {
      logOutboundMediaDiagnostic({
        stage: "media_claim_created",
        clinicId: user.clinicId,
        outcome: "failed",
        reasonCode: "claim_unavailable",
      });
      return messagingError("messaging.mediaUnavailable");
    }

    logOutboundMediaDiagnostic({
      stage: "media_claim_created",
      clinicId: user.clinicId,
      source: row.source as "upload" | "voice_note" | "patient_document" | "clinic_document",
      mediaKind: row.media_kind as "image" | "document" | "audio",
      bucket: row.bucket as "whatsapp-outbound" | "patient-assets" | "clinic-documents",
      byteSize: row.byte_size,
      outcome: "completed",
    });

    let authorized = isSendableStoragePath(row.bucket, row.storage_path, user.clinicId);
    if (authorized && row.source === "patient_document" && row.source_record_id) {
      const source = await client
        .from("patient_documents")
        .select("id")
        .eq("id", row.source_record_id)
        .eq("patient_id", conversation.data.patient_id ?? "")
        .eq("storage_path", row.storage_path)
        .is("deleted_at", null)
        .maybeSingle();
      authorized = !source.error && Boolean(source.data) && Boolean(conversation.data.patient_id);
    } else if (authorized && row.source === "clinic_document" && row.source_record_id) {
      const source = await client
        .from("documents")
        .select("id")
        .eq("id", row.source_record_id)
        .eq("patient_id", conversation.data.patient_id ?? "")
        .eq("pdf_storage_path", row.storage_path)
        .eq("status", "issued")
        .maybeSingle();
      authorized = !source.error && Boolean(source.data) && Boolean(conversation.data.patient_id);
    } else if (
      authorized &&
      row.source !== "upload" &&
      row.source !== "voice_note"
    ) {
      authorized = false;
    }
    if (
      !authorized ||
      !["image", "document", "audio"].includes(row.media_kind) ||
      !["whatsapp-outbound", "patient-assets", "clinic-documents"].includes(row.bucket)
    ) {
      const finalized = await finalizeOutboundMedia({
        clinicId: user.clinicId,
        mediaId: row.media_id,
        failureReason: "authorization_failed",
      });
      logOutboundMediaDiagnostic({
        stage: finalized.error || finalized.data !== true ? "finalize_failure" : "finalize_success",
        clinicId: user.clinicId,
        mediaKind: row.media_kind as "image" | "document" | "audio",
        outcome: "failed",
        reasonCode: "authorization_failed",
        hasOutboundMessageId: false,
      });
      return messagingError("messaging.mediaUnavailable");
    }

    await client
      .from("outbound_message_media")
      .update({ caption: parsed.data.body || null })
      .eq("id", row.media_id)
      .eq("status", "sending");
    media = {
      mediaId: row.media_id,
      kind: row.media_kind as "image" | "document" | "audio",
      mimeType: row.mime_type,
      bucket: row.bucket as "whatsapp-outbound" | "patient-assets" | "clinic-documents",
      storagePath: row.storage_path,
      fileName: row.file_name,
      voiceNote: row.source === "voice_note",
    };
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
    media,
  });
  if (!sent.ok) {
    let mediaRetryable = false;
    if (media) {
      const mayHaveSent = Boolean(
        sent.outboundMessageId &&
        (
          sent.code === "PROVIDER_SEND_AMBIGUOUS" ||
          sent.code === "MEDIA_BAILEYS_SEND_FAILED" ||
          sent.code === "RECORD_FAILED"
        )
      );
      const finalized = mayHaveSent
        ? await holdOutboundMedia({
            clinicId: user.clinicId,
            mediaId: media.mediaId,
            outboundMessageId: sent.outboundMessageId!,
            failureReason: sent.code.toLowerCase(),
          })
        : await releaseOutboundMedia({
            clinicId: user.clinicId,
            mediaId: media.mediaId,
            failureReason: sent.code.toLowerCase(),
          });
      mediaRetryable = !mayHaveSent && !finalized.error && Boolean(finalized.data);
      logOutboundMediaDiagnostic({
        stage: finalized.error || !finalized.data ? "finalize_failure" : "finalize_success",
        clinicId: user.clinicId,
        mediaKind: media.kind,
        bucket: media.bucket,
        outcome: mayHaveSent ? "held" : mediaRetryable ? "released" : "failed",
        reasonCode: sent.code.toLowerCase(),
        hasOutboundMessageId: Boolean(sent.outboundMessageId),
      });
    }
    const key =
      sent.code === "SERVICE_WINDOW_CLOSED"
        ? "messaging.serviceWindowClosed"
        : sent.code === "CONVERSATION_CLOSED"
          ? "messaging.conversationClosed"
          : sent.code === "TEMPLATE_NOT_APPROVED" ||
              sent.code === "TEMPLATE_PARAMETERS_INVALID"
            ? "messaging.templateUnavailable"
            : sent.code === "MEDIA_UNSUPPORTED"
              ? "messaging.linkedDeviceMediaUnavailable"
            : sent.code === "MEDIA_UNAVAILABLE"
                ? "messaging.mediaUnavailable"
              : sent.code === "MEDIA_REQUEST_REJECTED"
                ? "messaging.mediaRequestRejected"
              : sent.code === "MEDIA_STORAGE_FETCH_FAILED"
                ? "messaging.mediaStorageFetchFailed"
              : sent.code === "MEDIA_TRANSCODE_FAILED"
                ? "messaging.mediaTranscodeFailed"
              : sent.code === "MEDIA_BAILEYS_SEND_FAILED"
                ? "messaging.mediaBaileysSendFailed"
            : sent.code === "USAGE_LIMIT_REACHED"
              ? "messaging.messagingLimitReached"
              : "messaging.couldNotSendReply";
    return { ...(await messagingError(key)), ...(mediaRetryable ? { mediaRetryable: true } : {}) };
  }

  if (media) {
    let finalized = false;
    for (let attempt = 0; attempt < 3 && !finalized; attempt += 1) {
      const result = await finalizeOutboundMedia({
        clinicId: user.clinicId,
        mediaId: media.mediaId,
        outboundMessageId: sent.outboundMessageId,
      });
      finalized = !result.error && result.data === true;
    }
    logOutboundMediaDiagnostic({
      stage: finalized ? "finalize_success" : "finalize_failure",
      clinicId: user.clinicId,
      mediaKind: media.kind,
      bucket: media.bucket,
      outcome: finalized ? "completed" : "failed",
      reasonCode: finalized ? null : "media_finalize_failed",
      hasOutboundMessageId: true,
    });
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

const aiSuggestionSchema = z.object({
  suggestionId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000).optional(),
});

/**
 * P5B (§6.2): approve an AI-drafted patient reply from the inbox. Staff may
 * edit the body before sending. The suggestion is authorization only for the
 * *send*; the message itself still goes through the single `sendMessage`
 * boundary (window rules, usage caps, outbound record), exactly like a manual
 * reply. Never sends more than once (the pending guard is the claim).
 */
export async function approveAiSuggestion(input: {
  suggestionId: string;
  body?: string;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = aiSuggestionSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidInboxReply");

  const client = createClinicScopedAdminClient(user.clinicId);
  // Claim the pending suggestion first so two staff cannot both send it.
  const claimed = await client
    .from("ai_suggested_replies")
    .update({ status: "sent", decided_by: user.id, decided_at: new Date().toISOString() })
    .eq("id", parsed.data.suggestionId)
    .eq("status", "pending")
    .select("id, conversation_id, body")
    .maybeSingle();
  if (claimed.error || !claimed.data) {
    return messagingError("messaging.suggestionUnavailable");
  }

  const conversation = await client
    .from("conversations")
    .select("id, channel, status, assigned_to, participant_address, whatsapp_account_id")
    .eq("id", claimed.data.conversation_id)
    .maybeSingle();
  if (
    conversation.error ||
    !conversation.data ||
    conversation.data.channel !== "whatsapp" ||
    !conversation.data.participant_address
  ) {
    // Release the claim so the draft can be retried once the thread is usable.
    await client
      .from("ai_suggested_replies")
      .update({ status: "pending", decided_by: null, decided_at: null })
      .eq("id", claimed.data.id)
      .eq("status", "sent");
    return messagingError("messaging.conversationNotFound");
  }
  const activeProvider = await getActiveWhatsAppProvider(user.clinicId);
  const activeLinkedAccount = activeProvider === "linked_device"
    ? await getCurrentLinkedWhatsAppAccount(user.clinicId)
    : null;
  if (
    (activeProvider === "linked_device" &&
      (!activeLinkedAccount || conversation.data.whatsapp_account_id !== activeLinkedAccount)) ||
    (activeProvider !== "linked_device" &&
      (conversation.data.whatsapp_account_id ?? null) !== null)
  ) {
    await client.from("ai_suggested_replies")
      .update({ status: "pending", decided_by: null, decided_at: null })
      .eq("id", claimed.data.id).eq("status", "sent");
    return messagingError("messaging.conversationNotFound");
  }

  // P11N — the second path a schema identifier could reach a patient on.
  //
  // P11J-2 put the field-language gate in `patient-reply.ts`, which covers
  // everything the agent *sends*. It does not cover what the agent *stored*:
  // an `ai_suggested_replies` row drafted before that fix — or drafted by any
  // future path that forgets the gate — is sent verbatim from here, which is
  // how "(national_id, date_of_birth)" was still reaching threads after the
  // leak was supposedly fixed. Staff edits pass through untouched unless they
  // themselves carry an identifier.
  const draftBody = parsed.data.body?.trim() || claimed.data.body;
  // The locale of the *message*, not the clinic: the gate substitutes localized
  // labels, and an Arabic label in an English sentence is its own bug.
  const draftLocale = /[\u0600-\u06FF]/.test(draftBody) ? "ar" : "en";
  const scrubbedBody = scrubInternalFieldNames(draftBody, draftLocale);
  const body = scrubbedBody.text.trim() || draftBody;
  const sent = await sendMessage({
    clinicId: user.clinicId,
    recipient: conversation.data.participant_address,
    body,
    relatedType: "manual",
    conversationId: conversation.data.id,
    channelPreference: ["whatsapp"],
  });
  if (!sent.ok) {
    await client
      .from("ai_suggested_replies")
      .update({ status: "pending", decided_by: null, decided_at: null })
      .eq("id", claimed.data.id)
      .eq("status", "sent");
    const key =
      sent.code === "SERVICE_WINDOW_CLOSED"
        ? "messaging.serviceWindowClosed"
        : sent.code === "USAGE_LIMIT_REACHED"
          ? "messaging.messagingLimitReached"
          : "messaging.couldNotSendReply";
    return messagingError(key);
  }

  await client
    .from("ai_suggested_replies")
    .update({ body, outbound_message_id: sent.outboundMessageId })
    .eq("id", claimed.data.id);
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

/** P5B: discard an AI-drafted reply without sending. */
export async function dismissAiSuggestion(input: {
  suggestionId: string;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = aiSuggestionSchema.safeParse({ suggestionId: input.suggestionId });
  if (!parsed.success) return messagingError("messaging.invalidInboxReply");
  const client = createClinicScopedAdminClient(user.clinicId);
  const dismissed = await client
    .from("ai_suggested_replies")
    .update({ status: "dismissed", decided_by: user.id, decided_at: new Date().toISOString() })
    .eq("id", parsed.data.suggestionId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (dismissed.error || !dismissed.data) {
    return messagingError("messaging.suggestionUnavailable");
  }
  revalidatePath("/inbox");
  return { success: true };
}

/**
 * P5B (§6.2): return an escalated conversation to the AI. Staff decide when a
 * handoff is resolved; clearing the escalation lets the agent draft again on
 * the next inbound turn.
 */
export async function clearConversationEscalation(input: {
  conversationId: string;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");
  const client = createClinicScopedAdminClient(user.clinicId);
  const updated = await client
    .from("conversations")
    .update({ ai_escalated_at: null, ai_escalation_reason: null })
    .eq("id", parsed.data.conversationId)
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data) {
    return messagingError("messaging.conversationNotFound");
  }
  // P11B — the booking stage carries its own `escalated` latch, and clearing
  // only the column left the two disagreeing: the assistant resumed replying
  // while the stage machine still reported `escalated`, whose workflow tool
  // mount is empty. A conversation handed back that way answered every booking
  // question — including "who are the available doctors?" — with no booking
  // tool mounted at all.
  await clearBookingStageEscalation({
    clinicId: user.clinicId,
    conversationId: parsed.data.conversationId,
  });
  revalidatePath("/inbox");
  return { success: true };
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

/**
 * P8 (§6): human takeover. Stops every automatic agent reply on one
 * conversation, and gives it back when staff are done.
 *
 * This is an *additional* gate, not a replacement for the clinic-level reply
 * mode: a clinic with AI off stays off whatever this says, and a clinic with AI
 * on still cannot auto-reply into a paused thread. The transition itself is
 * decided inside the reviewed RPC under a row lock, so two staff members
 * clicking at the same moment produce one change and one log line.
 */
export async function setConversationHumanTakeover(input: {
  conversationId: string;
  paused: boolean;
  reason?: string | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = conversationAiPauseSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");

  let result;
  try {
    result = await setConversationAiPause({
      clinicId: user.clinicId,
      conversationId: parsed.data.conversationId,
      paused: parsed.data.paused,
      actorId: user.id,
      reason: parsed.data.reason ?? null,
    });
  } catch {
    return messagingError("messaging.conversationNotFound");
  }
  if (result.error || !result.data?.[0]) {
    return messagingError("messaging.conversationNotFound");
  }

  // Only a real transition is logged; a no-op click is not an event.
  if (result.data[0].changed) {
    await logMessagingEvent({
      clinicId: user.clinicId,
      event: parsed.data.paused ? "conversation_ai_paused" : "conversation_ai_resumed",
      recordId: parsed.data.conversationId,
      // Who and whether, never the staff member's note or any message content.
      summary: { actorId: user.id, paused: parsed.data.paused },
    }).catch(() => undefined);
  }

  revalidatePath("/inbox");
  return { success: true };
}

/**
 * P15 (§3) — the per-conversation exception to the clinic-wide AI setting.
 *
 * Same authorization as every other Inbox mutation: the roles that can read the
 * thread are the roles that can decide whether the assistant answers it. The
 * clinic-wide switch stays where it is — behind primary-admin only, in
 * `setPatientAiReplyMode` — because turning the assistant off for the whole
 * clinic is a different-sized decision from excluding one conversation.
 *
 * `override: null` puts the thread back under the clinic setting. That is a
 * distinct decision from "never here" and the API says so rather than
 * collapsing the two.
 */
export async function setConversationAiEnabled(input: {
  conversationId: string;
  override: boolean | null;
}): Promise<MessagingActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const parsed = conversationAiOverrideSchema.safeParse(input);
  if (!parsed.success) return messagingError("messaging.invalidConversationUpdate");

  let result;
  try {
    result = await setConversationAiOverride({
      clinicId: user.clinicId,
      conversationId: parsed.data.conversationId,
      override: parsed.data.override,
      actorId: user.id,
    });
  } catch {
    return messagingError("messaging.conversationNotFound");
  }
  if (result.error || !result.data?.[0]) {
    return messagingError("messaging.conversationNotFound");
  }

  // Only a real transition is logged; a no-op click is not an event.
  if (result.data[0].changed) {
    await logMessagingEvent({
      clinicId: user.clinicId,
      event: "conversation_ai_override_set",
      recordId: parsed.data.conversationId,
      // Who and what, never any message content.
      summary: { actorId: user.id, override: parsed.data.override },
    }).catch(() => undefined);
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
  // P11N — closing a thread ends the *conversation*, not just its row.
  //
  // Flipping `status` on its own left `ai_collected_data`, the pending
  // clarification, the booking stage and any pending AI draft exactly where
  // they were, and the inbound RPC reopens a closed thread on the next message
  // — so the assistant resumed a half-finished intake days later, which is the
  // stale "I still need these details" loop staff kept closing the thread to
  // escape. Messages, the patient link and the verified identity are untouched;
  // see `conversation-reset.ts` for the full boundary.
  if (parsed.data.status === "closed") {
    await resetConversationAssistantState({
      clinicId: user.clinicId,
      conversationId: parsed.data.conversationId,
      reason: "manual_close",
    });
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
