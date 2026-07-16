import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_DEFAULT_LOCALE,
  MARKETING_LOCALE_COOKIE,
} from "@/lib/i18n/config";

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
}));

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mocks.updateSession,
}));

import middleware from "@/middleware";

function request(
  path: string,
  options: {
    cookie?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);

  return new NextRequest(`http://localhost${path}`, {
    headers,
    method: options.method ?? "GET",
  });
}

beforeEach(() => {
  mocks.updateSession.mockReset();
  mocks.updateSession.mockImplementation(async () => NextResponse.next());
});

describe("Phase 5 homepage crawlability middleware", () => {
  it("serves a cookie-less landing document directly with the Arabic request cookie", async () => {
    const response = await middleware(
      request("/", { headers: { "sec-fetch-dest": "document" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(
      mocks.updateSession.mock.calls[0][0].cookies.get(MARKETING_LOCALE_COOKIE)?.value,
    ).toBe(ANONYMOUS_DEFAULT_LOCALE);
  });

  it("serves a cookie-less root GET without navigation headers normally", async () => {
    const headerlessRequest = request("/");

    expect(headerlessRequest.headers.get("sec-fetch-dest")).toBeNull();
    expect(headerlessRequest.headers.get("rsc")).toBeNull();
    expect(headerlessRequest.headers.has("next-router-state-tree")).toBe(false);

    const response = await middleware(headerlessRequest);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(mocks.updateSession).toHaveBeenCalledWith(headerlessRequest);
    expect(
      mocks.updateSession.mock.calls[0][0].cookies.get(MARKETING_LOCALE_COOKIE)?.value,
    ).toBe(ANONYMOUS_DEFAULT_LOCALE);
  });

  it("keeps the documented one-hop reset for a non-default marketing cookie", async () => {
    const response = await middleware(
      request("/", {
        cookie: `${MARKETING_LOCALE_COOKIE}=en`,
        headers: { "sec-fetch-dest": "document" },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `http://localhost/?landingLocale=${ANONYMOUS_DEFAULT_LOCALE}`,
    );
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)?.value).toBe(
      ANONYMOUS_DEFAULT_LOCALE,
    );
    expect(response.headers.get("set-cookie")).toContain("Path=/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=31536000");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it.each(["ar", "en"])(
    "keeps explicit valid landingLocale=%s handling unchanged",
    async (locale) => {
      const response = await middleware(
        request(`/?landingLocale=${locale}`, {
          cookie: `${MARKETING_LOCALE_COOKIE}=en`,
          headers: { "sec-fetch-dest": "document" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(mocks.updateSession).toHaveBeenCalledOnce();
      expect(
        mocks.updateSession.mock.calls[0][0].cookies.get(MARKETING_LOCALE_COOKIE)?.value,
      ).toBe(locale);
    },
  );

  it.each([
    ["RSC header", { rsc: "1" }],
    ["router state header", { "next-router-state-tree": "%5B%22%22%5D" }],
  ])("keeps %s landing navigations on the existing pass-through path", async (_label, headers) => {
    const response = await middleware(
      request("/", {
        cookie: `${MARKETING_LOCALE_COOKIE}=en`,
        headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(
      mocks.updateSession.mock.calls[0][0].cookies.get(MARKETING_LOCALE_COOKIE)?.value,
    ).toBe("en");
  });

  it("continues delegating protected routes to Supabase session middleware unchanged", async () => {
    const protectedResponse = NextResponse.redirect(
      new URL("http://localhost/login"),
    );
    mocks.updateSession.mockResolvedValueOnce(protectedResponse);
    const protectedRequest = request("/patients");

    const response = await middleware(protectedRequest);

    expect(response).toBe(protectedResponse);
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(mocks.updateSession).toHaveBeenCalledWith(protectedRequest);
  });
});
