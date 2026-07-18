import "server-only";
import * as Sentry from "@sentry/nextjs";
import { logAgentToolCall as logViaAdmin } from "@/lib/supabase/admin";
import { toolAuditSummary } from "@/lib/ai/redact";

/**
 * Audit every agent tool invocation (§6.6). The summary is redacted here before
 * it crosses the service-role boundary, so the audit trail never contains raw
 * identifiers or note bodies. Auditing must never break a tool: a logging
 * failure is captured to Sentry, not thrown back into the model loop.
 */
export async function logAgentTool(input: {
  clinicId: string;
  actorId: string | null;
  tool: string;
  tableName?: string | null;
  recordId?: string | null;
  params?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await logViaAdmin({
      clinicId: input.clinicId,
      actorId: input.actorId,
      tool: input.tool,
      tableName: input.tableName ?? null,
      recordId: input.recordId ?? null,
      summary: toolAuditSummary(input.params ?? {}),
    });
    if (error) {
      Sentry.captureMessage("log_agent_tool_call failed", {
        level: "warning",
        extra: { tool: input.tool, clinicId: input.clinicId, error: error.message },
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: "ai-audit" },
      extra: { tool: input.tool, clinicId: input.clinicId },
    });
  }
}
