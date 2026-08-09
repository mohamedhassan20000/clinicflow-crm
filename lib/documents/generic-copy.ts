import type { Locale } from "@/lib/i18n/config";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

export type GenericDocumentCopy = {
  title: string;
  labels: { documentNumber: string; issueDate: string; issueTime: string; period: string };
  documentLabel: string;
  authorizedSignature: string;
  recipientSignature: string;
  stamp: string;
  verificationTitle: string;
  verificationCaption: string;
  footerAttribution: string;
  copyright: string;
  page: string;
  of: string;
};

const sharedEn = getSharedDocumentSectionCopy("en");
const sharedAr = getSharedDocumentSectionCopy("ar");

const englishCopy: GenericDocumentCopy = {
  title: "Document",
  labels: { documentNumber: "Document no.", issueDate: "Issued", issueTime: "Time", period: "Reference" },
  documentLabel: "Clinic document",
  authorizedSignature: sharedEn.signatures.authorized,
  recipientSignature: sharedEn.signatures.recipient,
  stamp: sharedEn.stamps.clinic,
  verificationTitle: sharedEn.verification.genericTitle,
  verificationCaption: sharedEn.verification.genericCaption,
  footerAttribution: sharedEn.footer.documentSystem,
  copyright: sharedEn.footer.allRights,
  page: "Page",
  of: "of",
};

const arabicCopy: GenericDocumentCopy = {
  title: "مستند",
  labels: { documentNumber: "رقم المستند", issueDate: "تاريخ الإصدار", issueTime: "الوقت", period: "المرجع" },
  documentLabel: "مستند العيادة",
  authorizedSignature: sharedAr.signatures.authorized,
  recipientSignature: sharedAr.signatures.recipient,
  stamp: sharedAr.stamps.clinic,
  verificationTitle: sharedAr.verification.genericTitle,
  verificationCaption: sharedAr.verification.genericCaption,
  footerAttribution: sharedAr.footer.documentSystem,
  copyright: sharedAr.footer.allRights,
  page: "صفحة",
  of: "من",
};

export function getGenericDocumentCopy(locale: Locale): GenericDocumentCopy {
  return locale === "ar" ? arabicCopy : englishCopy;
}
