import { describe, expect, it } from "vitest";
import {
  auditActionMessageKey,
  auditActionTone,
  auditModuleForAction,
  ADMIN_AUDIT_MODULES,
} from "@/lib/audit/events";
import {
  auditChangeLines,
  auditDetailLines,
  formatAuditMoney,
} from "@/lib/audit/describe";
import {
  compareAuditEvents,
  decodeAuditCursor,
  diffKeys,
  encodeAuditCursor,
  mergeAuditPages,
  normalizeActivityRow,
  normalizeAdminAuditRow,
  normalizeLegacyRow,
  sanitizeAuditPayload,
  type AuditFeedEvent,
} from "@/lib/audit/feed";
import { auditShiftSummary, auditTemplateSummary } from "@/lib/audit/record";

function event(overrides: Partial<AuditFeedEvent> = {}): AuditFeedEvent {
  return {
    id: "e1",
    trail: "admin",
    occurredAt: "2026-09-01T10:00:00.000Z",
    module: "services",
    action: "service.price_changed",
    tone: "warning",
    actorType: "staff",
    actorId: "u1",
    actorName: "Mohamed",
    actorRole: "admin",
    viaAi: false,
    entityType: "service",
    entityId: "s1",
    entityRef: "Consultation",
    before: { price: "25.000", currency: "KWD" },
    after: { price: "30.000", currency: "KWD" },
    changedFields: ["price"],
    surface: "staff_web",
    outcome: "success",
    correlationId: null,
    metadata: { currency: "KWD" },
    ...overrides,
  };
}

describe("taxonomy", () => {
  it("maps every action to the settings area it belongs to", () => {
    expect(auditModuleForAction("service.price_changed")).toBe("services");
    expect(auditModuleForAction("insurance_provider.created")).toBe("insurance");
    expect(auditModuleForAction("page_permission.granted")).toBe("staff");
    expect(auditModuleForAction("clinic_hours.updated")).toBe("scheduling");
    expect(auditModuleForAction("whatsapp_account.connected")).toBe("messaging");
    expect(auditModuleForAction("appointment.confirmed")).toBe("appointments");
    expect(auditModuleForAction("follow_up.recorded")).toBe("appointments");
  });

  it("excludes the read-time-merged operational module from writable modules", () => {
    expect(ADMIN_AUDIT_MODULES).not.toContain("appointments");
  });

  it("converts dotted actions to message keys the way next-intl needs", () => {
    expect(auditActionMessageKey("service.price_changed")).toBe("servicePriceChanged");
    expect(auditActionMessageKey("insurance_provider.created")).toBe("insuranceProviderCreated");
    expect(auditActionMessageKey("ai.patient_replies_changed")).toBe("aiPatientRepliesChanged");
  });

  it("gives destructive and security-relevant actions a distinct tone", () => {
    expect(auditActionTone("staff.role_changed")).toBe("warning");
    expect(auditActionTone("service.price_changed")).toBe("warning");
    expect(auditActionTone("page_permission.revoked")).toBe("negative");
    expect(auditActionTone("whatsapp_account.connected")).toBe("positive");
    expect(auditActionTone("clinic.settings_updated")).toBe("neutral");
    expect(auditActionTone("something.unknown")).toBe("neutral");
  });
});

describe("privacy — the sanitizer applied to the trails this pass does not own", () => {
  it("drops every key that looks like a secret, an identifier or clinical text", () => {
    const cleaned = sanitizeAuditPayload({
      status: "connected",
      api_key: "sk-live-123",
      access_token: "abc",
      qr_payload: "2@PAIRING",
      auth_state: { creds: "x" },
      national_id: "289010112345",
      note: "Patient reports chest pain",
      diagnosis: "angina",
      message_body: "hello",
      email: "a@b.com",
      phone: "+96551231330",
      prescription_id: "p1",
      attachment_url: "https://x/y",
    });
    expect(cleaned).toEqual({ status: "connected" });
  });

  it("redacts identifiers that survive inside an allowed field's text", () => {
    const cleaned = sanitizeAuditPayload({ reason: "contact a@b.com or 96551231330" });
    expect(cleaned!.reason).toBe("contact [redacted-email] or [redacted-number]");
  });

  it("summarizes arrays instead of inlining them", () => {
    const cleaned = sanitizeAuditPayload({ items: [1, 2, 3] });
    expect(cleaned!.items).toEqual({ count: 3 });
  });

  it("returns null for anything that is not a JSON object", () => {
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload("text")).toBeNull();
    expect(sanitizeAuditPayload([1, 2])).toBeNull();
  });
});

describe("normalization", () => {
  it("passes an administrative row through without reshaping it", () => {
    const normalized = normalizeAdminAuditRow({
      id: "a1",
      occurred_at: "2026-09-01T10:00:00.000Z",
      actor_type: "staff",
      actor_user_id: "u1",
      actor_role: "admin",
      actor_display: "Mohamed",
      module: "services",
      action: "service.price_changed",
      entity_type: "service",
      entity_id: "s1",
      entity_ref: "Consultation",
      before: { price: "25.000" },
      after: { price: "30.000" },
      changed_fields: ["price"],
      source: "staff_web",
      outcome: "success",
      correlation_id: null,
      metadata: { currency: "KWD" },
    });
    expect(normalized.trail).toBe("admin");
    expect(normalized.tone).toBe("warning");
    expect(normalized.before).toEqual({ price: "25.000" });
  });

  it("marks an operational event with no session as system-generated", () => {
    const normalized = normalizeActivityRow(
      {
        id: "b1",
        occurred_at: "2026-09-01T09:00:00.000Z",
        action: "appointment.no_show",
        entity_type: "appointment",
        entity_id: "ap1",
        actor_id: null,
        actor_role: null,
        is_system: true,
        previous_state: { status: "confirmed" },
        new_state: { status: "no_show" },
        metadata: {},
      },
      null,
    );
    expect(normalized.actorType).toBe("system");
    expect(normalized.surface).toBe("system");
    expect(normalized.module).toBe("appointments");
    expect(normalized.changedFields).toEqual(["status"]);
  });

  it("reads only the two curated namespaces out of the legacy table", () => {
    const messaging = normalizeLegacyRow(
      {
        id: "c1",
        created_at: "2026-09-01T08:00:00.000Z",
        action: "messaging:channel_disconnected",
        actor_id: null,
        record_id: "ch1",
        new_data: { state: "disconnected" },
        old_data: null,
      },
      null,
      null,
    );
    expect(messaging!.module).toBe("messaging");
    expect(messaging!.actorType).toBe("integration");
    expect(messaging!.metadata).toEqual({ event: "channel_disconnected" });

    const provider = normalizeLegacyRow(
      {
        id: "c2",
        created_at: "2026-09-01T08:00:00.000Z",
        action: "AI_PROVIDER_CONNECTION_ROTATED",
        actor_id: "u1",
        record_id: "conn1",
        new_data: { masked_fingerprint: "sk-…f21a" },
        old_data: null,
      },
      "Mohamed",
      "admin",
    );
    expect(provider!.action).toBe("ai.provider_credential_rotated");
    expect(provider!.module).toBe("ai");

    // The raw table-diff half of `audit_logs` never becomes an audit event.
    for (const action of ["INSERT", "UPDATE", "DELETE", "PATIENT_FILE"]) {
      expect(
        normalizeLegacyRow(
          {
            id: "c3",
            created_at: "2026-09-01T08:00:00.000Z",
            action,
            actor_id: "u1",
            record_id: "p1",
            new_data: { national_id: "289010112345", note: "chest pain" },
            old_data: null,
          },
          "Mohamed",
          "admin",
        ),
      ).toBeNull();
    }
  });
});

describe("cursor and merge", () => {
  const base = { module: "clinic" as const, action: "clinic.settings_updated" };

  it("round-trips a cursor that is total over timestamp and id", () => {
    const cursor = { occurredAt: "2026-09-01T10:00:00.000Z", id: "e1" };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor(null)).toBeNull();
    expect(decodeAuditCursor("nonsense")).toBeNull();
  });

  it("orders newest first and breaks ties by id", () => {
    const a = event({ id: "b", occurredAt: "2026-09-01T10:00:00.000Z" });
    const b = event({ id: "a", occurredAt: "2026-09-01T10:00:00.000Z" });
    expect(compareAuditEvents(a, b)).toBeLessThan(0);
    expect(
      compareAuditEvents(
        event({ occurredAt: "2026-09-02T10:00:00.000Z" }),
        event({ occurredAt: "2026-09-01T10:00:00.000Z" }),
      ),
    ).toBeLessThan(0);
  });

  it("interleaves the trails and reports a cursor only when more remains", () => {
    const admin = [
      event({ ...base, id: "a1", occurredAt: "2026-09-03T10:00:00.000Z" }),
      event({ ...base, id: "a2", occurredAt: "2026-09-01T10:00:00.000Z" }),
    ];
    const activity = [
      event({ ...base, id: "b1", trail: "activity", occurredAt: "2026-09-02T10:00:00.000Z" }),
    ];

    const page = mergeAuditPages([admin, activity], 2, null);
    expect(page.events.map((item) => item.id)).toEqual(["a1", "b1"]);
    expect(page.nextCursor).toBe(encodeAuditCursor({
      occurredAt: "2026-09-02T10:00:00.000Z",
      id: "b1",
    }));

    const rest = mergeAuditPages([admin, activity], 2, decodeAuditCursor(page.nextCursor));
    expect(rest.events.map((item) => item.id)).toEqual(["a2"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("drops a tie on the cursor's own timestamp without losing the other trail", () => {
    const shared = "2026-09-02T10:00:00.000Z";
    const admin = [event({ id: "zz", occurredAt: shared })];
    const activity = [event({ id: "aa", trail: "activity", occurredAt: shared })];

    const first = mergeAuditPages([admin, activity], 1, null);
    expect(first.events.map((item) => item.id)).toEqual(["zz"]);

    const second = mergeAuditPages([admin, activity], 1, decodeAuditCursor(first.nextCursor));
    expect(second.events.map((item) => item.id)).toEqual(["aa"]);
  });
});

describe("human-readable diffs", () => {
  it("shows a price change as money in the currency the event recorded", () => {
    const [line] = auditChangeLines(event());
    expect(line.field).toBe("price");
    expect(line.before).toEqual({ kind: "money", amount: "25.000", currency: "KWD" });
    expect(line.after).toEqual({ kind: "money", amount: "30.000", currency: "KWD" });
  });

  it("never lists the currency or the archive marker as a change of its own", () => {
    const lines = auditChangeLines(
      event({ changedFields: ["price", "currency", "deleted_at"] }),
    );
    expect(lines.map((line) => line.field)).toEqual(["price"]);
  });

  it("classifies toggles, absent values and summarized lists", () => {
    const lines = auditChangeLines(
      event({
        module: "clinic",
        action: "clinic.reminders_changed",
        before: { reminders_enabled: false, description: null },
        after: { reminders_enabled: true, description: "New" },
        changedFields: ["reminders_enabled", "description"],
      }),
    );
    expect(lines[0].before).toEqual({ kind: "boolean", value: false });
    expect(lines[1].before).toEqual({ kind: "empty" });
    expect(lines[1].after).toEqual({ kind: "text", value: "New" });

    const schedule = auditChangeLines(
      event({
        module: "scheduling",
        action: "clinic_hours.updated",
        before: { shifts: { shift_count: 0, shifts: [] } },
        after: { shifts: { shift_count: 2, shifts: ["1:09:00-13:00", "1:16:00-20:00"] } },
        changedFields: ["shifts"],
      }),
    );
    expect(schedule[0].after).toMatchObject({ kind: "list", count: 2 });
  });

  it("shows every recorded field in the detail view, changed or not", () => {
    const detail = auditDetailLines(event());
    expect(detail.map((line) => line.field).sort()).toEqual(["currency", "price"]);
  });

  it("keeps the recorded currency and decimal places instead of converting", () => {
    expect(formatAuditMoney("25.000", "KWD", "en", 3)).toContain("25.000");
    expect(formatAuditMoney("30", "KWD", "en", 3)).toContain("30.000");
    expect(formatAuditMoney("30", null, "en")).toBe("30");
    expect(formatAuditMoney("not-a-number", "KWD", "en")).toBe("not-a-number");
  });
});

describe("schedule summaries", () => {
  it("renders shifts as sorted, stable strings", () => {
    expect(
      auditShiftSummary([
        { day: 2, start: "16:00:00", end: "20:00:00" },
        { day: 1, start: "09:00:00", end: "13:00:00" },
      ]),
    ).toEqual({ shift_count: 2, shifts: ["1:09:00-13:00", "2:16:00-20:00"] });
  });

  it("orders templates independently of how they were saved, so a reorder is not a change", () => {
    const a = auditTemplateSummary([
      { name: "Morning", start_time: "09:00:00", end_time: "17:00:00", is_enabled: true },
      { name: "Evening", start_time: "15:00:00", end_time: "22:00:00", is_enabled: false },
    ]);
    const b = auditTemplateSummary([
      { name: "Evening", start_time: "15:00:00", end_time: "22:00:00", is_enabled: false },
      { name: "Morning", start_time: "09:00:00", end_time: "17:00:00", is_enabled: true },
    ]);
    expect(a).toEqual(b);
    expect(a.templates).toEqual(["Evening 15:00-22:00 (disabled)", "Morning 09:00-17:00"]);
  });
});

describe("diffKeys", () => {
  it("reports only the keys whose value actually differs", () => {
    expect(diffKeys({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
    expect(diffKeys(null, { a: 1 })).toEqual([]);
  });
});
