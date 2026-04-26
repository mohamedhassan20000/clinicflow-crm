import { redirect } from "next/navigation";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Supabase password-reset / magic-link emails sometimes deliver users to the
// site root with auth params attached (e.g. `?code=…`, `?token_hash=…&type=…`,
// or `?error=…`). In that case we must NOT swallow the params by redirecting
// to /login — we forward to /auth/confirm so the proper handler can run.
// Additionally, an `#access_token=…` hash fragment can never be seen on the
// server, so we hand off to a tiny client shim that re-runs detection.
export default async function Home({ searchParams }: PageProps) {
  const sp = await searchParams;
  const passthroughKeys = [
    "code",
    "token_hash",
    "type",
    "next",
    "error",
    "error_description",
  ];
  const params = new URLSearchParams();
  for (const key of passthroughKeys) {
    const v = sp[key];
    if (typeof v === "string" && v.length > 0) params.set(key, v);
  }

  if (params.size > 0) {
    if (!params.has("next")) params.set("next", "/reset-password");
    redirect(`/auth/confirm?${params.toString()}`);
  }

  // No auth params on the URL — render a tiny client-side hop that checks for
  // implicit-flow tokens in the URL fragment before falling through to /login.
  return <RootRedirect />;
}

// Inline client component — checks for `#access_token=…` (implicit flow) and
// hands off to /auth/confirm; otherwise redirects to /login.
function RootRedirect() {
  return (
    <>
      <noscript>
        <meta httpEquiv="refresh" content="0;url=/login" />
      </noscript>
      <script
        // The script is static and not injected via user data — safe.
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              try {
                var hash = window.location.hash || "";
                if (hash.indexOf("access_token=") !== -1 || hash.indexOf("token_hash=") !== -1) {
                  window.location.replace("/auth/confirm" + hash);
                  return;
                }
              } catch (e) {}
              window.location.replace("/login");
            })();
          `,
        }}
      />
    </>
  );
}
