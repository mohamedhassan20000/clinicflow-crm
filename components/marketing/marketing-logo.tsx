import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { marketingCopy as copy } from "@/lib/marketing-copy";

export function MarketingLogo({
  className,
  inverse = false,
}: {
  className?: string;
  inverse?: boolean;
}) {
  return (
    <Link
      href="/"
      aria-label="ClinicFlow home"
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-4",
        inverse ? "text-white focus-visible:ring-offset-[#073846]" : "text-[#082f3c] focus-visible:ring-offset-[#f5fbfb]",
        className,
      )}
    >
      <Image
        src="/brand/clinicflow-mark.png"
        alt=""
        width={34}
        height={30}
        className="h-8 w-auto shrink-0 object-contain"
        sizes="34px"
      />
      <span className="text-[1.05rem] font-bold tracking-[-0.035em]">{copy.brand}</span>
    </Link>
  );
}
