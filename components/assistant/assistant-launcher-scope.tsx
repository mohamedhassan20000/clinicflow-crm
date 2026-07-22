"use client";

import { createContext, useContext } from "react";
import { AssistantLauncher } from "@/components/assistant/assistant-launcher";
import type { LaunchableAssistantPageContext } from "@/lib/ai/page-context";
import type { PermissionUserRole } from "@/lib/page-permissions";

type ScopedLauncher = {
  context: LaunchableAssistantPageContext;
  role: PermissionUserRole;
};

const AssistantLauncherContext = createContext<ScopedLauncher | null>(null);

/**
 * Carries a server-authorized launcher through an existing client component
 * tree. A null context is the fail-closed default, including every host rendered
 * outside an authorized source page.
 */
export function AssistantLauncherScope({
  context,
  role,
  children,
}: {
  context: LaunchableAssistantPageContext | null;
  role: PermissionUserRole;
  children: React.ReactNode;
}) {
  return (
    <AssistantLauncherContext.Provider
      value={context ? { context, role } : null}
    >
      {children}
    </AssistantLauncherContext.Provider>
  );
}

/** Renders nothing unless the surrounding server page authorized the context. */
export function ScopedAssistantLauncher() {
  const launcher = useContext(AssistantLauncherContext);
  if (!launcher) return null;
  return <AssistantLauncher context={launcher.context} role={launcher.role} />;
}
