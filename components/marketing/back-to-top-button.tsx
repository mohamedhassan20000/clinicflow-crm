"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

const MINIMUM_REVEAL_DISTANCE = 480;

export function BackToTopButton({ label }: { label: string }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    function updateVisibility() {
      const revealDistance = Math.max(MINIMUM_REVEAL_DISTANCE, window.innerHeight * 0.65);
      setIsVisible(window.scrollY > revealDistance);
    }

    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("resize", updateVisibility);
    return () => {
      window.removeEventListener("scroll", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
    };
  }, []);

  function scrollToTop() {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={isVisible ? 0 : -1}
      onClick={scrollToTop}
      className={cn(
        "marketing-back-to-top fixed end-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 inline-flex size-12 items-center justify-center rounded-full bg-[#087f7b] text-white shadow-[0_12px_30px_-12px_rgba(6,95,91,.65)] transition-[opacity,transform,visibility,background-color] duration-200 ease-out hover:bg-[#076e6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488] focus-visible:ring-offset-3 focus-visible:ring-offset-[var(--m-paper)] sm:end-[max(1.5rem,env(safe-area-inset-right))] sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))]",
        isVisible
          ? "visible translate-y-0 opacity-100"
          : "invisible pointer-events-none translate-y-3 opacity-0",
      )}
    >
      <ArrowUp className="size-5" aria-hidden="true" />
    </button>
  );
}
