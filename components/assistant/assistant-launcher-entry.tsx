import { AssistantLauncher } from "@/components/assistant/assistant-launcher";
import type { AssistantLauncherResolution } from "@/lib/ai/launchers";
import type { PermissionUserRole } from "@/lib/page-permissions";

/**
 * Server-entry adapter shared by every P4.8A host page. A null resolution emits
 * no launcher client boundary; an available resolution serializes only the
 * small context contract and role. Session history and capability data do not
 * cross the server/client boundary until the Sheet is opened.
 */
export function AssistantLauncherEntry({
  resolution,
  role,
  contextLabel,
}: {
  resolution: AssistantLauncherResolution | null;
  role: PermissionUserRole;
  contextLabel?: string | null;
}) {
  if (!resolution) return null;
  return (
    <AssistantLauncher
      context={resolution.context}
      contextLabel={contextLabel}
      role={role}
    />
  );
}
