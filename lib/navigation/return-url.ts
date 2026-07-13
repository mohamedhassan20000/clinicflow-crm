export const RETURN_TO_PARAM = "returnTo";

const LOCAL_ORIGIN = "https://clinicflow.local";
const MAX_RETURN_URL_LENGTH = 2_048;

function localUrl(value: string): URL | null {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > MAX_RETURN_URL_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value, LOCAL_ORIGIN);
    return url.origin === LOCAL_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

/**
 * Accept a return destination only when it is a local URL for an explicitly
 * allowed parent route. This keeps stateful Back links useful without turning
 * `returnTo` into an open redirect or exposing a different role's parent page.
 */
export function resolveReturnTo(
  value: string | null | undefined,
  fallback: string,
  allowedPathnames: readonly string[],
): string {
  const fallbackUrl = localUrl(fallback);
  if (!fallbackUrl || !allowedPathnames.includes(fallbackUrl.pathname)) {
    throw new Error("Return URL fallback must be an allowed local route.");
  }

  if (!value) return `${fallbackUrl.pathname}${fallbackUrl.search}`;
  const candidate = localUrl(value);
  if (!candidate || !allowedPathnames.includes(candidate.pathname)) {
    return `${fallbackUrl.pathname}${fallbackUrl.search}`;
  }

  return `${candidate.pathname}${candidate.search}`;
}

/** Add a validated-by-the-destination return URL to a local destination. */
export function withReturnTo(destination: string, returnTo: string): string {
  const destinationUrl = localUrl(destination);
  const returnUrl = localUrl(returnTo);
  if (!destinationUrl || !returnUrl) return destination;

  destinationUrl.searchParams.set(
    RETURN_TO_PARAM,
    `${returnUrl.pathname}${returnUrl.search}`,
  );
  return `${destinationUrl.pathname}${destinationUrl.search}`;
}

/** Compose the current list URL from its pathname and live URL state. */
export function pathWithSearch(
  pathname: string,
  searchParams: URLSearchParams | ReadonlyURLSearchParams,
): string {
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

type ReadonlyURLSearchParams = Pick<URLSearchParams, "toString">;
