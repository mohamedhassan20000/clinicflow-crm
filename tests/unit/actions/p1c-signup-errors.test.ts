import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  provision: vi.fn(),
  deleteUser: vi.fn(),
  findOrphan: vi.fn(),
  setPassword: vi.fn(),
  signUp: vi.fn(),
  serverSignOut: vi.fn(),
  rpc: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  resend: vi.fn(),
  redirect: vi.fn(),
}));

const EXISTS_MESSAGE =
  "An account already exists for this email. Sign in or reset its password.";

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("clinicName", "Branch Matrix Clinic");
  data.set("country", "KW");
  data.set("phone", "50003000");
  data.set("ownerName", "Branch Owner");
  data.set("email", "branch-matrix@example.com");
  data.set("password", "BranchMatrix123");
  data.set("locale", "ar");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

async function loadAction() {
  vi.resetModules();
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("next/navigation", () => ({ redirect: state.redirect }));
  vi.doMock("next/headers", () => ({
    headers: vi.fn(async () => new Headers({ host: "localhost:3000" })),
  }));
  vi.doMock("@/lib/rate-limit", () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0, backendAvailable: true })),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    provisionClinicOwner: state.provision,
    deleteSignupAuthUser: state.deleteUser,
    findResumableSignupUser: state.findOrphan,
    setSignupUserPassword: state.setPassword,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
      auth: { signUp: state.signUp, signOut: state.serverSignOut },
      rpc: state.rpc,
    })),
  }));
  vi.doMock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => ({
      auth: {
        signInWithPassword: state.signInWithPassword,
        signOut: state.signOut,
        resend: state.resend,
      },
    })),
  }));
  return import("@/actions/auth");
}

describe("P1C signup error and resume branch matrix", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.rpc.mockResolvedValue({
      data: [{ allowed: true, invitation_id: null, email: null }],
      error: null,
    });
    state.signUp.mockResolvedValue({
      data: {
        user: {
          id: "fresh-owner-id",
          email: "branch-matrix@example.com",
          identities: [{ id: "identity-id" }],
        },
      },
      error: null,
    });
    state.provision.mockResolvedValue({ data: "clinic-id", error: null });
    state.deleteUser.mockResolvedValue({ data: {}, error: null });
    state.findOrphan.mockResolvedValue({ data: null, error: null });
    state.setPassword.mockResolvedValue({ data: { user: null }, error: null });
    state.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    state.signOut.mockResolvedValue({ error: null });
    state.serverSignOut.mockResolvedValue({ error: null });
    state.resend.mockResolvedValue({ data: {}, error: null });
  });

  it("maps an email-send rate limit to a retry message without claiming the account exists", async () => {
    state.signUp.mockResolvedValue({
      data: { user: null },
      error: { code: "over_email_send_rate_limit", status: 429, message: "rate limited" },
    });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe(
      "Too many signup attempts right now. Please try again in a little while.",
    );
    expect(state.findOrphan).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });

  it("maps an SMTP/unexpected failure to a confirmation-email message and logs the real error", async () => {
    state.signUp.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", status: 500, message: "Error sending confirmation email" },
    });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe(
      "We couldn't send your confirmation email. Please try again shortly.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "clinic_signup_auth_failed",
      expect.objectContaining({ code: "unexpected_failure" }),
    );
    expect(state.findOrphan).not.toHaveBeenCalled();
  });

  it("never leaks the submitted password into the auth-failure log payload", async () => {
    state.signUp.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", status: 500, message: "boom" },
    });
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form({ password: "SuperSecret999" }));

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("SuperSecret999");
  });

  it("returns the exists message only for the duplicate signal with no resumable orphan", async () => {
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe(EXISTS_MESSAGE);
    expect(state.findOrphan).toHaveBeenCalledWith("branch-matrix@example.com");
    expect(state.provision).not.toHaveBeenCalled();
  });

  it("returns a neutral retry message when the orphan lookup itself fails", async () => {
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({ data: null, error: { message: "rpc down" } });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe("Signup failed. Please try again.");
  });

  it("resumes a confirmed orphan when the password proves control", async () => {
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({
      data: { userId: "orphan-id", emailConfirmed: true },
      error: null,
    });
    state.signInWithPassword.mockResolvedValue({
      data: { user: { id: "orphan-id" } },
      error: null,
    });
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form());

    expect(state.provision).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "orphan-id" }),
    );
    expect(state.redirect).toHaveBeenCalledWith("/signup/complete");
  });

  it("resumes an unconfirmed orphan via email_not_confirmed and resends the confirmation", async () => {
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({
      data: { userId: "orphan-id", emailConfirmed: false },
      error: null,
    });
    state.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    });
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form());

    expect(state.setPassword).not.toHaveBeenCalled();
    expect(state.resend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "signup", email: "branch-matrix@example.com" }),
    );
    expect(state.provision).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "orphan-id" }),
    );
    // A resumed orphan must never be compensation-deleted on provision failure.
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it("reclaims an unconfirmed orphan with a wrong password only when an email-bound invitation token authorizes it", async () => {
    state.rpc.mockResolvedValue({
      data: [{
        allowed: true,
        invitation_id: "invitation-id",
        email: "branch-matrix@example.com",
      }],
      error: null,
    });
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({
      data: { userId: "orphan-id", emailConfirmed: false },
      error: null,
    });
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form({ token: "raw-invitation-token" }));

    expect(state.setPassword).toHaveBeenCalledWith("orphan-id", "BranchMatrix123");
    expect(state.resend).toHaveBeenCalled();
    expect(state.provision).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "orphan-id" }),
    );
  });

  it("refuses to reclaim an unconfirmed orphan without a token", async () => {
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({
      data: { userId: "orphan-id", emailConfirmed: false },
      error: null,
    });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe(EXISTS_MESSAGE);
    expect(state.setPassword).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });

  it("never overwrites the password of a confirmed orphan, even with a valid token", async () => {
    state.rpc.mockResolvedValue({
      data: [{
        allowed: true,
        invitation_id: "invitation-id",
        email: "branch-matrix@example.com",
      }],
      error: null,
    });
    state.signUp.mockResolvedValue({
      data: { user: { id: "obfuscated-id", identities: [] } },
      error: null,
    });
    state.findOrphan.mockResolvedValue({
      data: { userId: "orphan-id", emailConfirmed: true },
      error: null,
    });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form({ token: "raw-invitation-token" }));

    expect(result.error).toBe(EXISTS_MESSAGE);
    expect(state.setPassword).not.toHaveBeenCalled();
  });

  it("provisions a genuinely new user and redirects to the completion page", async () => {
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form());

    expect(state.provision).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "fresh-owner-id" }),
    );
    expect(state.findOrphan).not.toHaveBeenCalled();
    expect(state.redirect).toHaveBeenCalledWith("/signup/complete");
  });

  it("clears the browser session after successful provisioning, before the completion redirect", async () => {
    // Regression: a stale operator/tenant session left in the cookies made
    // /signup/complete's "Go to sign in" link bounce to /operator.
    const { signUpClinic } = await loadAction();

    await signUpClinic(null, form());

    expect(state.serverSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(state.serverSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      state.redirect.mock.invocationCallOrder[0],
    );
  });

  it("does not clear the session when provisioning fails and the form must be retried", async () => {
    state.provision.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe("Clinic setup could not be completed. Please retry with the same details.");
    expect(state.serverSignOut).not.toHaveBeenCalled();
  });
});
