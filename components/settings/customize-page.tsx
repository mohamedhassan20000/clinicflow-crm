"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  FEATURE_REGISTRY,
  buildCustomizationMap,
  type AccessLevel,
  type CustomizationMap,
} from "@/lib/customizations";
import {
  getCustomizationsForUser,
  upsertCustomization,
  resetUserCustomizations,
} from "@/actions/customizations";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StaffEntry {
  id: string;
  full_name: string;
  role: string;
  department: string | null;
}

interface CustomizePageProps {
  staff: StaffEntry[];
}

// ── Access level pill ─────────────────────────────────────────────────────────

const ACCESS_OPTIONS: { value: AccessLevel; label: string }[] = [
  { value: "hidden", label: "Hidden" },
  { value: "read_only", label: "Read-only" },
  { value: "read_edit", label: "Read & Edit" },
];

function AccessPill({
  value,
  onChange,
  isPending,
}: {
  value: AccessLevel;
  onChange: (v: AccessLevel) => void;
  isPending: boolean;
}) {
  return (
    <div className="flex items-center rounded-lg border border-input bg-muted p-[3px] gap-px">
      {ACCESS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={isPending}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50",
            value === opt.value
              ? cn(
                  "shadow-sm",
                  opt.value === "hidden"
                    ? "bg-destructive/10 text-destructive"
                    : opt.value === "read_only"
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                )
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CustomizePage({ staff }: CustomizePageProps) {
  const [selectedId, setSelectedId] = useState<string>(staff[0]?.id ?? "");
  const [customMap, setCustomMap] = useState<CustomizationMap>({});
  const [loadedFor, setLoadedFor] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [expandedPages, setExpandedPages] = useState<Set<string>>(
    new Set(FEATURE_REGISTRY.map((p) => p.key)),
  );

  const selectedStaff = staff.find((s) => s.id === selectedId);

  async function loadUser(id: string) {
    if (id === loadedFor) return;
    setIsLoading(true);
    setSelectedId(id);
    try {
      const rows = await getCustomizationsForUser(id);
      setCustomMap(buildCustomizationMap(rows));
      setLoadedFor(id);
    } catch {
      toast.error("Failed to load customizations.");
    } finally {
      setIsLoading(false);
    }
  }

  function getAccess(page: string, feature: string): AccessLevel {
    const override = customMap[page]?.[feature];
    if (override) return override;
    const pageDef = FEATURE_REGISTRY.find((p) => p.key === page);
    const featDef = pageDef?.features.find((f) => f.key === feature);
    return featDef?.defaults[selectedStaff?.role ?? ""] ?? "hidden";
  }

  function handleChange(page: string, feature: string, access: AccessLevel) {
    // Optimistic update
    setCustomMap((prev) => ({
      ...prev,
      [page]: { ...(prev[page] ?? {}), [feature]: access },
    }));

    startTransition(async () => {
      const result = await upsertCustomization(selectedId, page, feature, access);
      if (result.error) {
        toast.error(result.error);
      }
    });
  }

  function handleReset() {
    startTransition(async () => {
      const result = await resetUserCustomizations(selectedId);
      if (result.error) {
        toast.error(result.error);
      } else {
        setCustomMap({});
        toast.success("Reset to role defaults.");
      }
    });
  }

  function togglePage(pageKey: string) {
    setExpandedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageKey)) next.delete(pageKey);
      else next.add(pageKey);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* User list */}
        <div className="space-y-1">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">
            Select user
          </p>
          {staff.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">No other staff members yet.</p>
          )}
          {staff.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => loadUser(s.id)}
              className={cn(
                "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                selectedId === s.id
                  ? "bg-primary/10 text-primary"
                  : "text-foreground/70 hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <p className="text-sm font-medium">{s.full_name}</p>
              <p className="text-[10px] text-muted-foreground capitalize">
                {s.role}
                {s.department ? ` · ${s.department}` : ""}
              </p>
            </button>
          ))}
        </div>

        {/* Feature editor */}
        <div className="space-y-4">
          {!selectedStaff ? (
            <div className="rounded-xl border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
              Select a user from the left to manage their dashboard customizations.
            </div>
          ) : isLoading ? (
            <div className="rounded-xl border border-border/50 p-10 text-center text-sm text-muted-foreground animate-pulse">
              Loading customizations…
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{selectedStaff.full_name}</h3>
                  <p className="text-sm text-muted-foreground capitalize">
                    {selectedStaff.role}
                    {selectedStaff.department ? ` · ${selectedStaff.department}` : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={handleReset}
                  disabled={isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset to default
                </Button>
              </div>

              <div className="space-y-3">
                {FEATURE_REGISTRY.map((page) => {
                  const isExpanded = expandedPages.has(page.key);
                  return (
                    <div
                      key={page.key}
                      className="overflow-hidden rounded-xl border border-border/50"
                    >
                      {/* Page header */}
                      <button
                        type="button"
                        onClick={() => togglePage(page.key)}
                        className="flex w-full items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors"
                      >
                        <span className="text-sm font-semibold">{page.label}</span>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>

                      {isExpanded && (
                        <div className="divide-y divide-border/40">
                          {page.features.map((feat) => {
                            const access = getAccess(page.key, feat.key);
                            const isOverridden = !!customMap[page.key]?.[feat.key];
                            const roleDefault =
                              feat.defaults[selectedStaff.role] ?? "hidden";

                            return (
                              <div
                                key={feat.key}
                                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                              >
                                <div className="min-w-0">
                                  <p className="text-sm font-medium">{feat.label}</p>
                                  {isOverridden && (
                                    <p className="text-[10px] text-muted-foreground">
                                      Default for role: <span className="font-medium capitalize">{roleDefault.replace("_", " ")}</span>
                                    </p>
                                  )}
                                </div>
                                <AccessPill
                                  value={access}
                                  onChange={(v) => handleChange(page.key, feat.key, v)}
                                  isPending={isPending}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                Changes are saved automatically. Overrides are applied on top of the
                user&apos;s role-based defaults. &ldquo;Reset to default&rdquo; removes all
                overrides and restores the original role configuration.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
