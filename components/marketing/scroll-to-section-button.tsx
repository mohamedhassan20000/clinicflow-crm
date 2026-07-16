"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

type Props = Omit<ComponentProps<typeof Button>, "asChild" | "onClick"> & {
  targetId: string;
};

export function ScrollToSectionButton({ targetId, type = "button", ...props }: Props) {
  function scrollToTarget() {
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    document.getElementById(targetId)?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }

  return <Button type={type} onClick={scrollToTarget} {...props} />;
}
