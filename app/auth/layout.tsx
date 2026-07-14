export default function AuthCallbackLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="dark forced-dark-scope min-h-dvh bg-background px-5 py-10 text-foreground">
      <div className="mx-auto max-w-xl">{children}</div>
    </main>
  );
}
