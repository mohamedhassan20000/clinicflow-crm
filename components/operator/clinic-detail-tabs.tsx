"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type ClinicDetailTab = {
  value: string;
  label: string;
  content: ReactNode;
};

/**
 * The owner clinic record, split into panels instead of one very long scroll.
 *
 * The panels themselves are rendered on the server and handed in as children,
 * so nothing about the clinic's data — or the server actions the panels host —
 * moves to the client. This component only decides which panel is visible.
 *
 * The active tab is mirrored into the `tab` search param with
 * `history.replaceState` rather than a router navigation: the usage-history
 * pager already links back to this page with `?tab=…`, so a link that lands on
 * the AI panel opens on the AI panel, while switching tabs by hand costs no
 * server round trip and does not reset the pager.
 */
export function ClinicDetailTabs({
  tabs,
  defaultValue,
  label,
}: {
  tabs: readonly ClinicDetailTab[];
  defaultValue: string;
  /** Accessible name for the tab list. */
  label: string;
}) {
  const [value, setValue] = useState(defaultValue);

  const onValueChange = useCallback((next: string) => {
    setValue(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  return (
    <Tabs value={value} onValueChange={onValueChange} className="gap-6">
      <TabsList aria-label={label} className="h-auto flex-wrap justify-start">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} className="space-y-6">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
