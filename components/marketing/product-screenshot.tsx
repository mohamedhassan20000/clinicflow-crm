import { getImageProps } from "next/image";
import { cn } from "@/lib/utils";

export function ProductScreenshot({
  desktop,
  mobile,
  alt,
  priority = false,
  className,
}: {
  desktop: string;
  mobile: string;
  alt: string;
  priority?: boolean;
  className?: string;
}) {
  const desktopImage = getImageProps({
    src: desktop,
    alt,
    width: 1440,
    height: 960,
    sizes: "(min-width: 1920px) 1080px, (min-width: 1280px) 58vw, (min-width: 768px) 58vw, calc(100vw - 2.5rem)",
    priority,
  });
  return (
    <div
      className={cn(
        "marketing-product-frame relative w-full min-w-0 overflow-hidden rounded-[1.4rem] border border-white/80 bg-white/70 p-1.5 shadow-[0_32px_80px_-44px_rgba(4,47,60,.48)]",
        className,
      )}
    >
      <div
        data-testid="marketing-window-chrome"
        className="flex h-10 items-start gap-1.5 px-4 pt-3"
        aria-hidden="true"
      >
        <span className="size-1.5 rounded-full bg-[#ff8c72]" />
        <span className="size-1.5 rounded-full bg-[#f6c65b]" />
        <span className="size-1.5 rounded-full bg-[#29bfa6]" />
      </div>
      <picture className="block">
        {/* Mobile AVIFs are already capture-budget optimized; serve them directly to avoid a second lossy pass. */}
        <source media="(max-width: 767px)" srcSet={mobile} type="image/avif" />
        {/* getImageProps preserves responsive Next.js optimization for the larger desktop source. */}
        <img
          {...desktopImage.props}
          alt={alt}
          className="block aspect-[390/844] w-full rounded-[1rem] bg-[#eaf7f6] object-contain object-top md:aspect-[3/2]"
        />
      </picture>
    </div>
  );
}
