"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
export default function GlobalError({ error, reset }: {
  error: Error & { digest?: string }; reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#f8fafc",
          color: "#172033",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", // i18n-allow: system font stack, not user-facing copy
        }}
      >
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: "24px",
            boxSizing: "border-box",
          }}
        >
          <div style={{ maxWidth: "520px", textAlign: "center" }}>
            {/* i18n-allow: invariant product name in the static global fallback */}
            <p style={{ color: "#087f7b", fontWeight: 700 }}>ClinicFlow</p>
            <h1 style={{ margin: "12px 0", fontSize: "28px" }}>
              {/* i18n-allow: static English is paired with Arabic because no provider is available */}
              Something went wrong
              <br />
              <span lang="ar" dir="rtl">حدث خطأ ما</span>
            </h1>
            <p style={{ margin: "0 0 8px", lineHeight: 1.6 }}>
              {/* i18n-allow: static English is paired with Arabic because no provider is available */}
              We couldn&apos;t load this page. Please try again.
            </p>
            <p lang="ar" dir="rtl" style={{ margin: "0 0 24px", lineHeight: 1.8 }}>
              تعذّر تحميل هذه الصفحة. يرجى المحاولة مرة أخرى.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{ padding: "10px 18px", border: 0, borderRadius: "8px", background: "#087f7b", color: "white", cursor: "pointer", fontWeight: 700 }}
            >
              {/* i18n-allow: static bilingual recovery action because no provider is available */}
              Try again / حاول مرة أخرى
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
