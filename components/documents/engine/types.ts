import type { ComponentType, ReactNode } from "react";
import type { Locale } from "@/lib/i18n/config";

export type DocumentOrientation = "portrait" | "landscape";
export type DocumentLifecycle = "preview" | "issued" | "cancelled";

export type DocumentBranding = {
  name: string;
  logoSrc?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  licenseNo?: string | null;
  taxId?: string | null;
  footerText?: string | null;
};

export type DocumentIdentity = {
  title: string;
  documentNumber?: string | null;
  issueDate: string;
  issueTime?: string | null;
  period?: string | null;
  labels: {
    documentNumber: string;
    issueDate: string;
    issueTime?: string;
    period?: string;
  };
};

export type DocumentWatermarkSettings = {
  enabled: boolean;
  text?: string | null;
  draftText?: string;
};

export type DocumentFooterContent = {
  attribution?: string | null;
  copyright?: string | null;
  links?: readonly { label: string; href?: string }[];
  verificationSlot?: ReactNode;
};

export type DocumentRenderContextValue = {
  locale: Locale;
  direction: "ltr" | "rtl";
  digits: "latn";
  lifecycle: DocumentLifecycle;
  orientation: DocumentOrientation;
  branding: DocumentBranding;
  identity: DocumentIdentity;
};

export type DocumentRenderContextBoundaryProps = {
  value: DocumentRenderContextValue;
  children: ReactNode;
};

export type DocumentRenderContextBoundary = ComponentType<DocumentRenderContextBoundaryProps>;
