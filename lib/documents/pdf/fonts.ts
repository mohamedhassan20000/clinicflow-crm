import "server-only";
import { cache } from "react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type FontFace = {
  family: "ClinicFlow Document Manrope" | "ClinicFlow Document Thmanyah";
  relativePath: string;
  weight: string;
};

const FONT_FACES: readonly FontFace[] = [
  {
    family: "ClinicFlow Document Manrope",
    relativePath: "app/fonts/manrope/manrope-latin-variable.woff2",
    weight: "200 800",
  },
  ...([300, 400, 500, 700, 900] as const).map((weight) => ({
    family: "ClinicFlow Document Thmanyah" as const,
    relativePath: `app/fonts/thmanyah/thmanyahsans-${
      weight === 300 ? "Light" : weight === 400 ? "Regular" : weight === 500 ? "Medium" : weight === 700 ? "Bold" : "Black"
    }.woff2`,
    weight: String(weight),
  })),
];

async function readFontData(relativePath: string): Promise<string> {
  const bytes = await readFile(join(process.cwd(), relativePath));
  return bytes.toString("base64");
}

/** Inlined local fonts make Chromium rendering offline and deterministic. */
export const getDocumentFontCss = cache(async (): Promise<string> => {
  const rules = await Promise.all(FONT_FACES.map(async (font) => {
    const data = await readFontData(font.relativePath);
    return `@font-face{font-family:"${font.family}";font-style:normal;font-weight:${font.weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  }));
  return `${rules.join("\n")}
:root{--doc-font-latin:"ClinicFlow Document Manrope",sans-serif;--doc-font-arabic:"ClinicFlow Document Thmanyah",sans-serif}`;
});

export const DOCUMENT_FONT_SOURCE_PATHS = FONT_FACES.map((face) => face.relativePath);
