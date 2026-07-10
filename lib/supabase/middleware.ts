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
];

const AUTH_PAGES = ["/login", "/change-password"];
const AUTH_MUTATION_EXEMPT_PATHS = new Set([
  "/login",
  "/change-password",
  "/forgot-password",
  "/reset-password",
  "/auth/confirm",
]);

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

  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  // ── Unauthenticated → /login ─────────────────────────────────────────────
  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user) {
    // Fetch profile for role + must_change_password (cached by browser/Supabase)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, clinic_id, must_change_password, is_active")
      .eq("id", user.id)
      .single();

    if (isProtected && (profileError || !profile)) {
      const url = request.nextUrl.clone();
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

    // Authenticated user on login page → /dashboard
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

    if (requiresBillingGate && profile) {
      const { data: subscription, error: subscriptionError } = await supabase
        .from("subscriptions")
        .select("status, trial_ends_at, current_period_end")
        .eq("clinic_id", profile.clinic_id)
        .maybeSingle();
      const access = subscriptionError
        ? { allowed: false as const, reason: "lookup_failed" as const }
        : resolveSubscriptionAccess(subscription);

      if (!access.allowed) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.searchParams.set("billing", "subscription_required");
        return NextResponse.redirect(url);
      }
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
