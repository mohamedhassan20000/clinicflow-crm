import "server-only";
import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { StaticDocumentRenderBoundary } from "@/components/documents/engine/static-render-boundary";
import type { DocumentRenderContextBoundary } from "@/components/documents/engine/types";
import type { Locale } from "@/lib/i18n/config";
import { localeDirection } from "@/lib/i18n/config";
import { DOCUMENT_ENGINE_CSS } from "@/components/documents/engine/styles";
import { getDocumentFontCss } from "@/lib/documents/pdf/fonts";

export type ServerDocumentRender = (
  renderContextBoundary: DocumentRenderContextBoundary,
) => ReactElement;

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function buildDocumentHtml({
  renderDocument,
  locale,
  title,
}: {
  renderDocument: ServerDocumentRender;
  locale: Locale;
  title: string;
}): Promise<string> {
  const element = renderDocument(StaticDocumentRenderBoundary);
  const rendered = await prerender(element);
  const [fontCss, markup] = await Promise.all([
    getDocumentFontCss(),
    new Response(rendered.prelude).text(),
  ]);
  return `<!doctype html>
<html lang="${locale}" dir="${localeDirection(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtmlAttribute(title)}</title>
<style>${fontCss}\n${DOCUMENT_ENGINE_CSS}</style>
</head>
<body>${markup}</body>
</html>`;
}
