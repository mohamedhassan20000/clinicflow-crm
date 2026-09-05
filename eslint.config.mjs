import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "actions/**/*.{ts,tsx}",
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "hooks/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
    ],
    ignores: ["lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/admin",
              importNames: ["createAdminClient"],
              message:
                "Use createClinicScopedAdminClient(clinicId) so service-role data access stays tenant-scoped.",
            },
          ],
          patterns: [
            {
              group: [
                "@/lib/supabase/admin",
                "**/lib/supabase/admin",
                "**/supabase/admin",
              ],
              importNames: ["createAdminClient"],
              message:
                "Use createClinicScopedAdminClient(clinicId) for tenant data access. Raw createAdminClient is restricted to lib/supabase/admin.ts.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // services/ holds separately deployed Node services with their own
    // toolchains (see services/whatsapp-worker); they are not part of the
    // Next.js app's lint or type graph.
    "services/**",
  ]),
]);

export default eslintConfig;
