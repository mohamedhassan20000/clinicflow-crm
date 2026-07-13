"use client";

import Link from "next/link";
import { useRef } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { marketingCopy as copy } from "@/lib/marketing-copy";

const mobileNavigation = [
  ["#product", copy.nav.product],
  ["#features", copy.nav.features],
  ["#security", copy.nav.security],
  ["#pricing", copy.nav.pricing],
  ["#faq", copy.nav.faq],
] as const;

export function MobileMarketingMenu() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  function closeMenu() {
    dialogRef.current?.close();
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 rounded-full text-[#0b4654] md:hidden"
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
        className="fixed inset-y-0 end-0 start-auto m-0 h-dvh max-h-none w-[min(88vw,23rem)] max-w-none border-s border-[#0c5261]/10 bg-[#f5fbfb] p-0 text-[#082f3c] shadow-2xl backdrop:bg-[#061f28]/35 backdrop:backdrop-blur-xs"
      >
        <div className="flex min-h-full flex-col">
          <div className="relative border-b border-[#0c5261]/10 px-5 py-5 text-start">
            <h2 id="marketing-menu-title" className="text-lg font-semibold text-[#082f3c]">
              {copy.nav.menuTitle}
            </h2>
            <p id="marketing-menu-description" className="mt-1 text-sm text-[#436873]">
              {copy.footer.tagline}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-block-start-3 inset-inline-end-3 size-10 rounded-full"
              aria-label="Close navigation menu"
              onClick={closeMenu}
            >
              <span className="text-2xl leading-none" aria-hidden="true">×</span>
            </Button>
          </div>
        <nav aria-label={copy.nav.label} className="flex flex-col px-3">
          {mobileNavigation.map(([href, label]) => (
            <Link
              key={href}
              className="flex min-h-12 items-center rounded-xl px-4 text-base font-semibold hover:bg-[#dff4f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]"
              href={href}
              onClick={closeMenu}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-3 border-t border-[#0c5261]/10 p-5">
          <Button asChild variant="outline" className="h-11 border-[#0c5261]/20 bg-white">
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
