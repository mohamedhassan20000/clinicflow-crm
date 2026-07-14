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
    sizes: "(min-width: 1280px) 720px, (min-width: 768px) 58vw, 100vw",
    priority,
  });
  const mobileImage = getImageProps({
    src: mobile,
    alt,
    width: 390,
    height: 844,
    sizes: "(max-width: 767px) calc(100vw - 40px), 390px",
    priority,
  });

  return (
    <div
      className={cn(
        "marketing-product-frame relative overflow-hidden rounded-[1.4rem] border border-white/80 bg-white/70 p-1.5 shadow-[0_32px_80px_-44px_rgba(4,47,60,.48)]",
        className,
      )}
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-[#0b4654]/10 px-3" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-[#ff8c72]" />
        <span className="size-1.5 rounded-full bg-[#f6c65b]" />
        <span className="size-1.5 rounded-full bg-[#29bfa6]" />
        <span className="ms-2 h-1.5 w-24 rounded-full bg-[#0b4654]/8" />
      </div>
      <picture>
        <source media="(max-width: 767px)" srcSet={mobileImage.props.srcSet} />
        {/* getImageProps preserves next/image optimization while allowing art-directed crops. */}
        <img
          {...desktopImage.props}
          alt={alt}
          className="aspect-[3/2] w-full rounded-[1rem] bg-[#eaf7f6] object-cover object-top md:aspect-[3/2]"
        />
      </picture>
    </div>
  );
}
