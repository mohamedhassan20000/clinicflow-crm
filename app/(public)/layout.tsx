import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-dvh bg-background px-5 py-10"><div className="mx-auto max-w-xl"><Link href="/early-access" className="mb-8 block text-center text-2xl font-bold tracking-tight text-primary">ClinicFlow</Link>{children}</div></main>;
}

