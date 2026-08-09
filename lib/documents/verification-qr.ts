import "server-only";
import QRCode from "qrcode";

export const DOCUMENT_VERIFICATION_ORIGIN = "https://clinicflow.fit";

const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function buildDocumentVerificationUrl(token: string): string {
  const normalized = token.trim();
  if (!OPAQUE_TOKEN_PATTERN.test(normalized)) {
    throw new Error("Document verification token must be an opaque base64url-safe value");
  }
  return new URL(`/verify/${normalized}`, DOCUMENT_VERIFICATION_ORIGIN).toString();
}

export async function generateDocumentVerificationQrDataUrl(token: string): Promise<string> {
  const url = buildDocumentVerificationUrl(token);
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 320,
    color: { dark: "#001f35", light: "#ffffff" },
  });
}

export async function generateDocumentPreviewQrDataUrl(): Promise<string> {
  return QRCode.toDataURL(new URL("/verify/preview", DOCUMENT_VERIFICATION_ORIGIN).toString(), {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 320,
    color: { dark: "#001f35", light: "#ffffff" },
  });
}
