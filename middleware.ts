import { updateSession } from "@/lib/supabase/middleware";
import { NextResponse, type NextRequest } from "next/server";
import {
  ANONYMOUS_DEFAULT_LOCALE,
  MARKETING_LOCALE_COOKIE,
  isLocale,
} from "@/lib/i18n/config";

export default async function middleware(request: NextRequest) {
  const isLandingGet =
    request.method === "GET" && request.nextUrl.pathname === "/";
  const requestedLandingLocale = request.nextUrl.searchParams.get("landingLocale");
  const fetchDestination = request.headers.get("sec-fetch-dest");
  const isLandingDocumentReload =
    isLandingGet &&
    (fetchDestination === "document" ||
      (fetchDestination === null &&
        request.headers.get("rsc") !== "1" &&
        !request.headers.has("next-router-state-tree")));

  if (isLandingGet && isLocale(requestedLandingLocale)) {
    request.cookies.set(MARKETING_LOCALE_COOKIE, requestedLandingLocale);
  } else if (isLandingDocumentReload) {
    // A full landing-page load always starts in Arabic. When the browser still carries English
    // from the login flow, make that reset explicit with a one-hop redirect; mutating the incoming
    // request cookie alone is not sufficient for Next.js' already-created intl request store.
    if (request.cookies.get(MARKETING_LOCALE_COOKIE)?.value !== ANONYMOUS_DEFAULT_LOCALE) {
      const url = request.nextUrl.clone();
      url.searchParams.set("landingLocale", ANONYMOUS_DEFAULT_LOCALE);
      const response = NextResponse.redirect(url);
      response.cookies.set(MARKETING_LOCALE_COOKIE, ANONYMOUS_DEFAULT_LOCALE, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
      });
      return response;
    }
    request.cookies.set(MARKETING_LOCALE_COOKIE, ANONYMOUS_DEFAULT_LOCALE);
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     * - public assets with file extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
