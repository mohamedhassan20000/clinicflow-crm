import { Manrope } from "next/font/google";
import localFont from "next/font/local";

/**
 * Latin face for the whole application (English UI + marketing). Unchanged by P2A.
 */
export const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
  weight: "variable",
  style: "normal",
});

/**
 * Arabic primary face — thmanyah sans (AI_AGENT_PLAN.md §4.3).
 *
 * Licensed font: the files are supplied by the founder and live in this repository, which is
 * private for that reason. They are never linked, indexed, or offered as a download.
 *
 * Weights are the real `OS/2.usWeightClass` values read from the shipped files, not assumed ones.
 * The family has **no 600 (SemiBold)** and **no italics** — see docs/reviews/P2A_REVIEW.md. Any
 * `font-weight: 600` in Arabic therefore resolves to the 700 face via the browser's weight-matching
 * algorithm rather than synthesizing an intermediate weight.
 */
export const thmanyah = localFont({
  variable: "--font-thmanyah",
  display: "swap",
  // Only the weights below exist. Declaring them all is free: the browser downloads a face only
  // when a rendered node actually resolves to that weight.
  src: [
    { path: "./fonts/thmanyah/thmanyahsans-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Black.woff2", weight: "900", style: "normal" },
  ],
});

export const fontVariables = `${manrope.variable} ${thmanyah.variable}`;
