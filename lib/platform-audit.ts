import "server-only";
import type { Json } from "@/types/database";
import { createClient } from "@/lib/supabase/server";

export async function logOperatorAction(input: {
  action: string;
  targetType: string;
  targetId?: string | null;
  clinicId?: string | null;
  payload?: Json;
}): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("log_platform_audit_event", {
    p_action: input.action,
    p_target_type: input.targetType,
    p_target_id: input.targetId ?? undefined,
    p_clinic_id: input.clinicId ?? undefined,
    p_payload: input.payload ?? {},
  });
  if (error) throw new Error("Operator action completed but could not be audited.");
}
