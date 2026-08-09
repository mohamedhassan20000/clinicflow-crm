import { toLatinDigits } from "@/lib/documents/format";

export type BidiDirection = "ltr" | "rtl" | "auto";

const LEFT_TO_RIGHT_ISOLATE = "\u2066";
const RIGHT_TO_LEFT_ISOLATE = "\u2067";
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/** Props for an HTML wrapper around a known-direction atom such as a code. */
export function bidiIsolateProps(direction: BidiDirection = "auto") {
  return {
    dir: direction,
    style: { unicodeBidi: "isolate" } as const,
  };
}

/**
 * Isolates plain-text runs used outside React/HTML (email subjects, text export).
 * HTML templates should prefer `<bdi>` with `bidiIsolateProps()`.
 */
export function isolateBidiText(
  value: string | number,
  direction: BidiDirection = "auto",
): string {
  const opener = direction === "ltr"
    ? LEFT_TO_RIGHT_ISOLATE
    : direction === "rtl"
      ? RIGHT_TO_LEFT_ISOLATE
      : FIRST_STRONG_ISOLATE;
  return `${opener}${String(value)}${POP_DIRECTIONAL_ISOLATE}`;
}

/** Known-LTR atoms remain readable inside Arabic text and keep Latin digits. */
export function isolateLtrAtom(value: string | number): string {
  return isolateBidiText(toLatinDigits(value), "ltr");
}

