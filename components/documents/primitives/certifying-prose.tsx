import type { ReactNode } from "react";

export function CertifyingProse({ children }: { children: ReactNode }) {
  // i18n-allow: document CSS class tokens, not user-facing copy
  return <div className="cf-doc-certifying-prose cf-doc-section" data-testid="certifying-prose">{children}</div>;
}
