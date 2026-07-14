import "server-only";

import { getTranslations } from "next-intl/server";
import type { z } from "zod";
import { translateFieldErrors } from "@/lib/validations/error-map";

/** Localizes server-action zod failures before they cross the RSC boundary. */
export async function localizeZodFieldErrors(error: z.ZodError) {
  const t = await getTranslations("validation");
  return translateFieldErrors(error.flatten().fieldErrors, t);
}
