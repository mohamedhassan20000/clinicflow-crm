import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function OperatorNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">Operator page not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The operator page you&apos;re looking for doesn&apos;t exist.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/operator">Go to Mission Control</Link>
      </Button>
    </div>
  );
}
