import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { NetworkStatusToast } from "@/components/shared/network-status-toast";
import { Toaster } from "@/components/ui/sonner";
import { fontVariables } from "@/app/fonts";
import { localeDirection, type Locale } from "@/lib/i18n/config";
import { MARKETING_SITE_URL } from "@/lib/marketing-copy";
import { resolveTheme } from "@/lib/preferences/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return {
    metadataBase: new URL(MARKETING_SITE_URL),
    title: { default: "ClinicFlow", template: "%s · ClinicFlow" },
    description: t("metadataDescription"),
    robots: { index: false },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Locale comes from the next-intl request config, so `lang`/`dir` and the messages handed to the
  // client can never disagree — both resolve through the same call (§4.1).
  const [locale, messages, theme] = await Promise.all([
    getLocale() as Promise<Locale>,
    getMessages(),
    resolveTheme(),
  ]);

  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      className={`${fontVariables} h-full${theme === "dark" ? " dark" : ""}`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <NuqsAdapter>{children}</NuqsAdapter>
          <NetworkStatusToast />
          <Toaster richColors closeButton position="top-right" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
