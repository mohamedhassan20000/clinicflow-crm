import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import {
  getPageSlugFromPath,
  getRolePageSlugs,
  type PageSlug,
} from "@/lib/page-permissions";
import { resolveSubscriptionAccess } from "@/lib/billing/access";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/patients",
  "/appointments",
  "/followups",
  "/revenue",
  "/reports",
  "/settings",
  "/profile",
  "/onboarding",
];

const AUTH_PAGES = ["/login", "/change-password"];
// Session-bound auth recovery pages that must stay reachable for POST but
// still receive the auth-page gates above (redirect-when-settled, forced
// password change). Fully public flows are exempted earlier via
// PUBLIC_FLOW_PREFIXES instead.
const AUTH_MUTATION_EXEMPT_PATHS = new Set([
  "/login",
  "/change-password",
]);

// Public, pre-authentication flows: signup, early access, email confirmation,
// and password recovery. GET and Server Action POST requests must reach these
// routes untouched for anonymous AND authenticated visitors alike — a stale or
// half-provisioned session on a signup POST must never be bounced to /login
// mid-action. Every action hosted on these routes performs its own
// validation and rate limiting.
const PUBLIC_FLOW_PREFIXES = [
  "/signup",
  "/early-access",
  "/auth/confirm",
  "/forgot-password",
  "/reset-password",
];

function isPublicFlowPath(pathname: string) {
  return PUBLIC_FLOW_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// Routes only admins and managers may access.
const ADMIN_MANAGER_PREFIXES = ["/settings"];
const PAGE_VISIBILITY_COOKIE = "cf_page_visibility";

function parseVisibilityCookie(
  value: string | undefined,
  userId: string,
  role: string,
): Set<PageSlug> | null {
  if (!value) return null;
  const [cookieUserId, cookieRole, slugs] = value.split(":");
  if (cookieUserId !== userId || cookieRole !== role) return null;
  return new Set(
    (slugs ?? "")
      .split(",")
      .filter(Boolean) as PageSlug[],
  );
}

function serializeVisibilityCookie(
  userId: string,
  role: string,
  visibleSlugs: Set<PageSlug>,
) {
  return `${userId}:${role}:${Array.from(visibleSlugs).sort().join(",")}`;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // getUser() already ran above, so session cookies stay refreshed; beyond
  // that, public flows bypass every session-derived gate. Protected and
  // operator prefixes never overlap these paths.
  if (isPublicFlowPath(pathname)) {
    return supabaseResponse;
  }

  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isOperatorPath = pathname === "/operator" || pathname.startsWith("/operator/");

  // ── Unauthenticated → /login ─────────────────────────────────────────────
  if (!user && (isProtected || isOperatorPath)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user) {
    // ── Operator trust boundary. Platform admins deliberately hold no clinic
    // profile, so the clinic billing/onboarding gates below cannot apply to
    // them. Access requires platform_admins membership (self-read RLS policy)
    // plus, for dual-role accounts, an active profile with no forced password
    // change. The (operator) layout re-checks with requirePlatformAdmin() as
    // defense in depth. Non-members never reach an operator surface.
    if (isOperatorPath) {
      const { data: platformAdmin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!platformAdmin) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        return NextResponse.redirect(url);
      }
      // Dual-role hardening: platform admins normally hold no clinic profile,
      // but nothing prevents granting platform_admins to a clinic user. If a
      // profile exists it must be active and not pending a forced password
      // change before any operator surface is reachable.
      const { data: operatorProfile } = await supabase
        .from("profiles")
        .select("must_change_password, is_active")
        .eq("id", user.id)
        .maybeSingle();
      if (operatorProfile && !operatorProfile.is_active) {
        await supabase.auth.signOut();
        const url = request.nextUrl.clone();
        url.pathname = "/login";
        return NextResponse.redirect(url);
      }
      if (operatorProfile?.must_change_password) {
        const url = request.nextUrl.clone();
        url.pathname = "/change-password";
        return NextResponse.redirect(url);
      }
      return supabaseResponse;
    }

    // Fetch profile for role + must_change_password (cached by browser/Supabase)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, clinic_id, must_change_password, is_active")
      .eq("id", user.id)
      .single();

    if ((isProtected || isAuthPage) && (profileError || !profile)) {
      const { data: platformAdmin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const url = request.nextUrl.clone();
      if (platformAdmin) {
        url.pathname = "/operator";
        return NextResponse.redirect(url);
      }
      await supabase.auth.signOut();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }

    // Deactivated account → sign out and redirect
    if (profile && !profile.is_active) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }

    // must_change_password gate — force to /change-password for any protected route
    if (profile?.must_change_password && isProtected) {
      const url = request.nextUrl.clone();
      url.pathname = "/change-password";
      return NextResponse.redirect(url);
    }

    // Billing gate is fail-closed. Dashboard GET remains readable so an expired
    // clinic has a safe landing surface. Auth recovery paths are explicit
    // middleware exemptions; every business mutation is guarded again inside
    // its Server Action, so replaying one against an exempt URL still fails.
    const isReadOnlyDashboard = pathname === "/dashboard" && request.method === "GET";
    const isAuthenticatedMutation =
      request.method !== "GET" && !AUTH_MUTATION_EXEMPT_PATHS.has(pathname);
    const requiresBillingGate =
      (isProtected && !isReadOnlyDashboard) || isAuthenticatedMutation;

    if (requiresBillingGate && (profileError || !profile)) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }

    const needsOnboardingCheck =
      Boolean(profile && profile.role === "admin" && isProtected);
    const needsSubscriptionLookup = requiresBillingGate || needsOnboardingCheck;
    let subscriptionAllowsAccess: boolean | null = null;
    if (profile && needsSubscriptionLookup) {
      const { data: subscription, error: subscriptionError } = await supabase
        .from("subscriptions")
        .select("status, trial_ends_at, current_period_end")
        .eq("clinic_id", profile.clinic_id)
        .maybeSingle();
      const access = subscriptionError
        ? { allowed: false as const, reason: "lookup_failed" as const }
        : resolveSubscriptionAccess(subscription);
      subscriptionAllowsAccess = access.allowed;

      if (requiresBillingGate && !access.allowed) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.searchParams.set("billing", "subscription_required");
        return NextResponse.redirect(url);
      }
    }

    // Onboarding follows subscription access and precedes role/page visibility.
    // The onboarding route itself (including its Server Action POSTs) remains
    // reachable and is protected by the active trial created during signup.
    if (profile && needsOnboardingCheck && subscriptionAllowsAccess === true) {
      const { data: clinic, error: clinicError } = await supabase
        .from("clinics")
        .select("onboarding_completed_at")
        .eq("id", profile.clinic_id)
        .maybeSingle();
      // A transient lookup failure is not evidence that onboarding is
      // incomplete. Let the protected RSC handle its own data error.
      const onboardingComplete = clinic
        ? Boolean(clinic.onboarding_completed_at)
        : null;
      if (!clinicError && onboardingComplete === false && pathname !== "/onboarding") {
        const url = request.nextUrl.clone();
        url.pathname = "/onboarding";
        return NextResponse.redirect(url);
      }
      if (!clinicError && onboardingComplete === true && pathname === "/onboarding") {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        return NextResponse.redirect(url);
      }
    }

    // Authenticated user on login page enters onboarding until explicitly complete.
    if (isAuthPage && !profile?.must_change_password) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }

    // Role-based route guard: admin/manager settings routes
    if (
      profile &&
      profile.role !== "admin" &&
      profile.role !== "manager" &&
      ADMIN_MANAGER_PREFIXES.some((p) => pathname.startsWith(p))
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }

    const pageSlug = getPageSlugFromPath(pathname);
    if (profile && pageSlug && pageSlug !== "dashboard") {
      const roleSlugs = new Set(getRolePageSlugs(profile.role));
      if (!roleSlugs.has(pageSlug)) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        return NextResponse.redirect(url);
      }

      let visibleSlugs = parseVisibilityCookie(
        request.cookies.get(PAGE_VISIBILITY_COOKIE)?.value,
        user.id,
        profile.role,
      );

      if (!visibleSlugs) {
        const { data: permissions, error: permissionsError } = await supabase
          .from("user_page_permissions")
          .select("page_slug, is_visible")
          .eq("user_id", user.id)
          .eq("clinic_id", profile.clinic_id);

        visibleSlugs = new Set(roleSlugs);
        if (!permissionsError) {
          for (const permission of permissions ?? []) {
            const slug = permission.page_slug as PageSlug;
            if (!roleSlugs.has(slug) || slug === "dashboard") continue;
            if (permission.is_visible) visibleSlugs.add(slug);
            else visibleSlugs.delete(slug);
          }
        } else if (
          permissionsError.code === "PGRST205" ||
          permissionsError.message?.toLowerCase().includes("user_page_permissions")
        ) {
          const { data: fallback, error: fallbackError } = await supabase
            .from("user_customizations")
            .select("page, access")
            .eq("profile_id", user.id)
            .eq("clinic_id", profile.clinic_id)
            .eq("feature", "_visible");

          if (!fallbackError) {
            for (const permission of fallback ?? []) {
              const slug = permission.page as PageSlug;
              if (!roleSlugs.has(slug) || slug === "dashboard") continue;
              if (permission.access === "hidden") visibleSlugs.delete(slug);
              else visibleSlugs.add(slug);
            }
          }
        }
        visibleSlugs.add("dashboard");

        supabaseResponse.cookies.set(
          PAGE_VISIBILITY_COOKIE,
          serializeVisibilityCookie(user.id, profile.role, visibleSlugs),
          {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60,
          },
        );
      }

      if (!visibleSlugs.has(pageSlug)) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
