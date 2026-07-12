import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ request: vi.fn(), rate: vi.fn(), platformAdmin: vi.fn(), from: vi.fn() }));

async function loadEarlyAccess() {
  vi.resetModules();
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));
  vi.doMock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
  vi.doMock("@/lib/rate-limit", () => ({ checkRateLimit: state.rate }));
  vi.doMock("@/lib/rbac", () => ({ requireMutationRole: vi.fn(), requirePlatformAdmin: state.platformAdmin }));
  vi.doMock("@/lib/supabase/admin", () => ({ requestClinicInvitation: state.request }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: state.from, rpc: vi.fn() })) }));
  vi.doMock("@/lib/platform-audit", () => ({ logOperatorAction: vi.fn() }));
  return import("@/actions/early-access");
}

function requestForm(phone: string, country: string) {
  const data = new FormData();
  data.set("clinicName", "International Clinic"); data.set("ownerName", "Owner");
  data.set("phone", phone); data.set("phoneCountry", country); data.set("email", "owner@example.com");
  return data;
}

describe("P1.5D public phone actions", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.rate.mockResolvedValue({ allowed: true }); state.request.mockResolvedValue({ error: null });
  });

  it("returns a normal phone field error for unparseable input", async () => {
    const { requestEarlyAccess } = await loadEarlyAccess();
    await expect(requestEarlyAccess(null, requestForm("abc", "KW"))).resolves.toEqual({ fieldErrors: { phone: ["Enter a valid international phone number"] } });
    expect(state.request).not.toHaveBeenCalled();
    await expect(requestEarlyAccess(null, requestForm("50003000", "ZZ"))).resolves.toEqual({ fieldErrors: { phone: ["Enter a valid international phone number"] } });
  });

  it("uses the submitted non-Kuwaiti country and persists E.164", async () => {
    const { requestEarlyAccess } = await loadEarlyAccess();
    await expect(requestEarlyAccess(null, requestForm("0501234567", "SA"))).resolves.toEqual({ ok: true });
    expect(state.request).toHaveBeenCalledWith(expect.objectContaining({ phone: "+966501234567" }));
  });
});
