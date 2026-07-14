"use client";

import { useEffect, useRef, useState } from "react";
import { STAT_COUNT_DURATION_MS } from "@/lib/marketing-stats";

/**
 * P2C — a single statistic that counts up from zero when it first enters the viewport.
 *
 * Three properties the brief asks for, and how each is actually enforced:
 *
 *   • **Runs once.** The observer disconnects on first intersection, so scrolling back up does not
 *     replay it. A number that re-animates on every pass reads as a gimmick.
 *   • **Smooth easing.** `easeOutCubic` — quick out of the gate, settling gently onto the value. A
 *     linear count is the tell of an animation nobody thought about.
 *   • **`prefers-reduced-motion: reduce` is honoured for real** — not "a faster count", *no* count.
 *     The final value renders immediately. This has to be asked in JS: the `@media (prefers-reduced-
 *     motion)` block in `globals.css` governs CSS animation, and cannot reach a number being driven
 *     by `requestAnimationFrame`.
 *
 * Accessibility: the true value is always in the accessible tree (`sr-only`), and the counting digits
 * are `aria-hidden`. A screen-reader user is never read a stream of intermediate numbers, and never
 * hears a value that is briefly wrong.
 *
 * The final value is server-rendered, so it is correct with JavaScript disabled and to a crawler.
 * The animation only ever *starts below* a number that is already right — it never invents one.
 */

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function AnimatedStat({
  value,
  suffix,
  formattedValue,
  className,
}: {
  value: number;
  suffix: string;
  /**
   * The final value, already digit-shaped by the locale formatter. Rendered verbatim at rest, so the
   * number a user actually reads always came from the formatter and never from `String(n)` inside an
   * animation frame.
   */
  formattedValue: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [counting, setCounting] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();

        const start = performance.now();
        const step = (now: number) => {
          const progress = Math.min((now - start) / STAT_COUNT_DURATION_MS, 1);
          setCounting(progress >= 1 ? null : Math.round(easeOutCubic(progress) * value));
          if (progress < 1) frame = requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);

  // `null` is the resting state — the count has not started, has finished, or was never allowed to
  // run. All three render the real formatted value.
  const display = counting === null ? formattedValue : String(counting);

  return (
    <span ref={ref} className={className} data-testid="marketing-stat-value">
      <span className="sr-only">
        {formattedValue}
        {suffix}
      </span>
      <span aria-hidden="true">
        {display}
        {suffix}
      </span>
    </span>
  );
}
