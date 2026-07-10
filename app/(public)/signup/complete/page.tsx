import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function SignupCompletePage() {
  return (
    <section className="rounded-2xl border bg-card p-8 text-center">
      <h1 className="text-2xl font-semibold">Check your email</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Confirm your email address, then sign in to finish clinic setup.
      </p>
      <Button asChild className="mt-6">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </section>
  );
}
