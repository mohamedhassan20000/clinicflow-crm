import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { send, audit, requireAdmin, from } = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn(), requireAdmin: vi.fn(), from: vi.fn() }));
let updateError: { message: string } | null = null;
const invitation = { id: "11111111-1111-4111-8111-111111111111", clinic_name: "Safe Clinic", owner_name: "Owner", email: "owner@example.com", status: "pending", expires_at: "2030-01-01T00:00:00Z" };
const writes: unknown[] = [];

function builder(operation: "select" | "update" = "select") {
  const value = {
    select: vi.fn(() => value), update: vi.fn((payload: unknown) => { writes.push(payload); return builder("update"); }),
    eq: vi.fn(() => value),
    maybeSingle: vi.fn(async () => ({ data: invitation, error: null })),
    then(resolve: (result: unknown) => unknown) { return Promise.resolve(operation === "update" ? { error: updateError } : { data: null, error: null }).then(resolve); },
  };
  return value;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from })) }));
vi.mock("@/lib/rbac", () => ({ requirePlatformAdmin: requireAdmin }));
vi.mock("@/lib/email/resend", () => ({ DEFAULT_FROM: "ClinicFlow <invite@example.com>", getResend: () => ({ emails: { send } }) }));
vi.mock("@/lib/platform-audit", () => ({ logOperatorAction: audit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/actions/early-access", () => ({ issueClinicInvitation: vi.fn(), revokeClinicInvitation: vi.fn() }));
vi.mock("@/lib/billing/manual", () => ({ manualBillingProvider: {} }));

import { sendInvitationEmail } from "@/actions/operator";

const rawToken = "RAW_SECRET_TOKEN_123";
function form(origin = "https://clinicflow.example", path = `/signup/${rawToken}`) {
  const data = new FormData(); data.set("invitationId", invitation.id); data.set("invitationEmail", invitation.email); data.set("invitationLink", `${origin}${path}`); return data;
}

describe("P1.5B invitation email", () => {
  beforeEach(() => { vi.clearAllMocks(); from.mockImplementation(() => builder()); writes.length = 0; updateError = null; process.env.NEXT_PUBLIC_SITE_URL = "https://clinicflow.example"; send.mockResolvedValue({ data: { id: "email-1" }, error: null }); });

  it("sends, audits, and records email_sent_at without persisting the token", async () => {
    await expect(sendInvitationEmail(null, form())).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce(); expect(audit).toHaveBeenCalledWith({ action: "invitation.email_sent", targetType: "clinic_invitation", targetId: invitation.id });
    expect(writes).toHaveLength(1); expect(writes[0]).toHaveProperty("email_sent_at");
    expect(JSON.stringify(writes)).not.toContain(rawToken); expect(JSON.stringify(audit.mock.calls)).not.toContain(rawToken);
  });

  it("surfaces provider failure without updating, auditing, invalidating, or rotating", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); send.mockResolvedValue({ data: null, error: { message: "provider unavailable" } });
    const result = await sendInvitationEmail(null, form());
    expect(result.error).toMatch(/link remains valid/i); expect(writes).toEqual([]); expect(audit).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toContain(rawToken); expect(JSON.stringify(log.mock.calls)).not.toContain(invitation.email); expect(JSON.stringify(log.mock.calls)).not.toContain("<div"); log.mockRestore();
  });

  it("handles transport exceptions with sanitized diagnostics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); send.mockRejectedValue(new Error(`transport failed ${rawToken} ${invitation.email}`));
    const result = await sendInvitationEmail(null, form());
    expect(result.error).toMatch(/link remains valid/i); expect(writes).toEqual([]); expect(audit).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls); expect(logged).not.toContain(rawToken); expect(logged).not.toContain(invitation.email); log.mockRestore();
  });

  it("audits a sent email even when timestamp bookkeeping fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); updateError = { message: "write failed" };
    const result = await sendInvitationEmail(null, form());
    expect(result.error).toMatch(/sent and audited/i); expect(audit).toHaveBeenCalledOnce(); expect(writes).toHaveLength(1); log.mockRestore();
  });

  it("rejects foreign origins and non-signup paths while accepting the configured origin", async () => {
    expect((await sendInvitationEmail(null, form("https://evil.example"))).error).toMatch(/invalid/i);
    expect((await sendInvitationEmail(null, form("https://clinicflow.example", "/not-signup/token"))).error).toMatch(/invalid/i);
    expect(await sendInvitationEmail(null, form())).toEqual({ ok: true });
  });
});
