import Link from "next/link";
import { useTranslations } from "next-intl";

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("public");
  return (
    <main className="dark forced-dark-scope min-h-dvh bg-background px-5 py-10 text-foreground">
      <div className="mx-auto max-w-xl">
        <Link
          href="/early-access"
          className="mb-8 block text-center text-2xl font-bold tracking-tight text-primary"
        >
          {t("clinicflow")}</Link>
        {children}
      </div>
    </main>
  );
}
