import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Manrope } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
  weight: "variable",
  style: "normal",
});

export const metadata: Metadata = {
  title: { default: "ClinicFlow", template: "%s · ClinicFlow" },
  description: "The all-in-one CRM built for modern private clinics.",
  robots: { index: false },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const theme = cookieStore.get("theme")?.value ?? "light";

  return (
    <html
      lang="en"
      className={`${manrope.variable} h-full${theme === "dark" ? " dark" : ""}`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <NuqsAdapter>{children}</NuqsAdapter>
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  );
}
