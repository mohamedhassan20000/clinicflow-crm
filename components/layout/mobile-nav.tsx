"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar } from "@/components/layout/sidebar";

interface MobileNavProps {
  role: string;
  fullName: string;
  theme: "light" | "dark";
}

export function MobileNav({ role, fullName, theme }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 p-0">
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <div onClick={() => setOpen(false)}>
            <Sidebar role={role} fullName={fullName} theme={theme} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
