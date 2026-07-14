"use client";

import Link from "next/link";
import { useRef } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePublicTheme } from "@/components/marketing/public-theme";
import { useTranslations } from "next-intl";
import { getMarketingCopy } from "@/lib/marketing-copy";
import type { MessageTranslator } from "@/lib/i18n/translator";

export function MobileMarketingMenu() {
  const copy = getMarketingCopy(useTranslations("marketing") as unknown as MessageTranslator);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { theme } = usePublicTheme();

  const mobileNavigation = [
    ["#product", copy.nav.product],
    ["#features", copy.nav.features],
    ["#security", copy.nav.security],
    ["#pricing", copy.nav.pricing],
    ["#faq", copy.nav.faq],
  ] as const;

  function closeMenu() {
    dialogRef.current?.close();
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 rounded-full text-[var(--m-ink)] xl:hidden"
        aria-label={copy.nav.menu}
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
      >
        <Menu className="size-5" />
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby="marketing-menu-title"
        aria-describedby="marketing-menu-description"
        data-public-theme={theme}
        className="fixed inset-y-0 end-0 start-auto m-0 h-dvh max-h-none w-[min(88vw,23rem)] max-w-none border-s border-[var(--m-line)] bg-[var(--m-paper)] p-0 text-[var(--m-ink)] shadow-2xl backdrop:bg-[#061f28]/35 backdrop:backdrop-blur-xs"
      >
        <div className="flex min-h-full flex-col">
          <div className="relative border-b border-[var(--m-line)] px-5 py-5 text-start">
            <h2 id="marketing-menu-title" className="text-lg font-semibold text-[var(--m-ink)]">
              {copy.nav.menuTitle}
            </h2>
            <p id="marketing-menu-description" className="mt-1 text-sm text-[var(--m-muted)]">
              {copy.footer.tagline}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-block-start-3 inset-inline-end-3 size-10 rounded-full"
              aria-label={copy.nav.closeMenu}
              onClick={closeMenu}
            >
              <span className="text-2xl leading-none" aria-hidden="true">×</span>
            </Button>
          </div>
        <nav aria-label={copy.nav.label} className="flex flex-col px-3">
          {mobileNavigation.map(([href, label]) => (
            <Link
              key={href}
              className="flex min-h-12 items-center rounded-xl px-4 text-base font-semibold hover:bg-[var(--m-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]"
              href={href}
              onClick={closeMenu}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-3 border-t border-[var(--m-line)] p-5">
          <Button asChild variant="outline" className="h-11 border-[var(--m-line-strong)] bg-[var(--m-panel)] text-[var(--m-ink)] hover:bg-[var(--m-soft)]">
            <Link href="/login" onClick={closeMenu}>{copy.nav.login}</Link>
          </Button>
          <Button asChild className="h-11 bg-[#087f7b] text-white hover:bg-[#076e6b]">
            <Link href="#early-access" onClick={closeMenu}>{copy.nav.earlyAccess}</Link>
          </Button>
        </div>
        </div>
      </dialog>
    </>
  );
}
