import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { establishedDepartmentId } from "@/lib/ai/booking-stage";
import { loadDoctorDirectory } from "@/lib/ai/doctor-directory";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import { normalizeHumanText } from "@/lib/ai/human-input";
import { readServiceScope } from "@/lib/ai/service-intent";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import {
  createClinicScopedAdminClient,
  getClinicCurrency,
} from "@/lib/supabase/admin";

/**
 * P10 — "إيه الخدمات اللي عندكم؟" and the price next to it.
 *
 * Services and their prices are configured per department in Settings, and
 * before this the patient assistant could not read them at all. A patient
 * asking what a clinic does and what it costs got an FAQ miss, and the only
 * alternative available to a model that wants to be helpful is to make
 * something up — which for a *price* is the worst possible thing to invent.
 *
 * The shape of the answer follows the shape of the data:
 *
 *   * A service belongs to exactly one department, so the department has to be
 *     known before there is anything to list. When the conversation has already
 *     settled one — because the patient is mid-booking — that is used and the
 *     patient is **not** asked again; that repetition was its own reported bug.
 *     Only a genuinely unknown department produces the question, and the
 *     question comes with the real active department list attached so the model
 *     can ask it and answer it in one turn.
 *
 *   * Prices come back as the stored number plus the clinic's stored currency
 *     code, never pre-formatted. Formatting money is a localization decision the
 *     model makes in the patient's language; inventing the *number* is not a
 *     decision at all.
 *
 * Everything is read live and clinic-scoped: a service added, repriced or
 * deactivated in Settings changes the answer on the next message, with no code
 * change and no prompt change.
 */
const SERVICE_PAGE_SIZE = 500;

/**
 * "Every department", however it is said. One reader, shared with the intent
 * classifier, so the phrase that routes a turn here and the phrase that widens
 * the scope once it arrives can never diverge.
 */
function asksForAllDepartments(value: string | undefined): boolean {
  return readServiceScope(normalizeHumanText(value ?? "")) === "all";
}

async function loadActiveServices(
  db: ReturnType<typeof createClinicScopedAdminClient>,
): Promise<Array<{ id: string; name: string; price: number | null; department_id: string }>> {
  const rows: Array<{ id: string; name: string; price: number | null; department_id: string }> = [];
  for (let from = 0; ; from += SERVICE_PAGE_SIZE) {
    const result = await db
      .from("services")
      .select("id, name, price, department_id")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("department_id")
      .order("name")
      .range(from, from + SERVICE_PAGE_SIZE - 1);
    if (result.error) throw new Error("Could not read clinic services.");
    const page = (result.data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < SERVICE_PAGE_SIZE) return rows;
  }
}

export function listDepartmentServicesTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List the real services and current prices this clinic offers, from its settings. " +
      "settings. Use for 'what services do you offer?', 'إيه الخدمات؟', 'بكام الكشف؟', 'ما هي " +
      "الخدمات والأسعار؟'. Call it with no arguments for a general services/prices question: it " +
      "answers from the department the conversation already settled, and otherwise returns every " +
      "department with its configured services and prices. Never ask the patient which department " +
      "they mean before calling it. Pass `department` only when the patient named one. Never " +
      "invent a service, a description, or a price.",
    inputSchema: z.object({
      department: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "The department in the patient's own words, when they named one and the conversation " +
            "has not already settled it. Leave empty otherwise.",
        ),
      all_departments: z
        .boolean()
        .optional()
        .describe(
          "True only when the patient explicitly asks for every department ('all', 'كلهم').",
        ),
    }),
    execute: async ({ department, all_departments }) => {
      const identity = await authorizePatientConversation(ctx);
      const db = createClinicScopedAdminClient(identity.clinicId);
      const directory = await loadDoctorDirectory(identity.clinicId);
      const departments = directory.departments;

      if (departments.length === 0) {
        return {
          found: false as const,
          departments: [],
          guidance:
            "This clinic has no active departments configured, so there are no services to list. " +
            "Say so plainly and offer to connect the patient with clinic staff.",
        };
      }

      const groupedByDepartment = async (outcome: string) => {
        const [services, currency] = await Promise.all([
          loadActiveServices(db),
          getClinicCurrency(identity.clinicId),
        ]);
        const grouped = departments.map((item) => ({
          id: item.id,
          name: item.name,
          services: services
            .filter((service) => service.department_id === item.id)
            .map((service) => ({
              id: service.id,
              name: service.name,
              department: { id: item.id, name: item.name },
              price: service.price,
              currency,
            })),
        }));
        await logAgentTool({
          clinicId: identity.clinicId,
          actorId: null,
          tool: "list_department_services",
          tableName: "services",
          params: {
            outcome,
            department_count: grouped.length,
            service_count: services.length,
          },
        });
        return {
          found: true as const,
          scope: "all_departments" as const,
          complete: true as const,
          departments: grouped,
          department_count: grouped.length,
          service_count: services.length,
          currency,
          guidance:
            services.length === 0
              ? "This clinic has no services configured yet. Say so plainly — do not name a " +
                "service or a price — and offer to connect the patient with clinic staff."
              : "List every department in `departments` and every configured service under it. " +
                "Always put one service and its price on its own line. Never omit a configured " +
                "department, service, or price, and never invent one.",
        };
      };

      const wantsAll =
        all_departments === true ||
        asksForAllDepartments(department) ||
        asksForAllDepartments(ctx.episodeUtterances?.at(-1));
      if (wantsAll) {
        return groupedByDepartment("success_all_departments");
      }

      // The department the conversation already chose. Asking "which department?"
      // of somebody who is three messages into booking Dermatology is the
      // restart this whole flow is built to avoid.
      let selected = departments.find(
        (item) => item.id === establishedDepartmentId(identity.collectedData),
      ) ?? null;

      if (department) {
        const resolution = resolveNamedEntity(department, departments);
        if (resolution.status === "resolved") {
          selected = resolution.entity;
        } else {
          return {
            found: false as const,
            needs_clarification: true as const,
            field: "department" as const,
            reason: resolution.status,
            requested_department: department,
            candidates: resolution.candidates
              .filter((item) => item.score >= 0.58)
              .map(({ id, name }) => ({ id, name })),
            departments,
            guidance:
              resolution.status === "ambiguous"
                ? "Ask one short question naming only these plausible departments."
                : "Say that department was not found and offer these active departments.",
          };
        }
      }

      // Item #2 — a generic question has its *scope* asked for, once.
      //
      // The history here matters, because this branch has now been both things.
      // Originally it replied `needs_department`, which made the model ask the
      // patient to pick before the clinic would say anything at all — a
      // question answered with a question. P12-QA replaced it with the
      // clinic-wide dump, which fixed that and overshot: a patient who asks
      // "بتقدموا إيه؟" gets every service in every department at once, which is
      // not an answer so much as a directory.
      //
      // The intended shape is neither. One short question — every department,
      // or a particular one — and then the authoritative answer for whichever
      // they choose. Both answers are already implemented above and below this
      // branch; all that was missing was asking.
      //
      // Two cases are deliberately not asked:
      //
      //   * A clinic with a single active department has nothing to choose
      //     between, and asking would be a question with one answer.
      //   * A conversation that has already settled a department answered this
      //     several turns ago (`selected`, above).
      if (!selected) {
        if (departments.length === 1) {
          selected = departments[0]!;
        } else {
          await logAgentTool({
            clinicId: identity.clinicId,
            actorId: null,
            tool: "list_department_services",
            tableName: "services",
            params: { outcome: "needs_scope", department_count: departments.length },
          });
          return {
            found: true as const,
            needs_scope: true as const,
            field: "service_scope" as const,
            departments,
            department_count: departments.length,
            guidance:
              "The patient asked about services or prices without saying which part of the " +
              "clinic they mean. Ask exactly one short question — whether they want every " +
              "department or a particular one — in their own language, for example «أكيد، تحب " +
              "تعرف خدمات قسم معين ولا كل الأقسام؟». You may name the departments in " +
              "`departments` so they can pick one. Do not list any service and do not quote any " +
              "price yet, do not answer with a department of your own choosing, and do not ask " +
              "anything else in the same message.",
          };
        }
      }

      // This is a read-only FAQ tool. Naming a department in a price question
      // must never replace or create the booking target; a later booking turn
      // resolves its own department through the booking workflow.

      const [servicesResult, clinicResult] = await Promise.all([
        db
          .from("services")
          .select("id, name, price")
          .eq("department_id", selected.id)
          .eq("is_active", true)
          .is("deleted_at", null)
          .order("name"),
        db.from("departments").select("id").eq("id", selected.id).maybeSingle(),
      ]);
      if (servicesResult.error || clinicResult.error) {
        throw new Error("Could not read clinic services.");
      }

      const currency = await getClinicCurrency(identity.clinicId);
      const services = (servicesResult.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        department: { id: selected.id, name: selected.name },
        price: row.price,
        currency,
      }));
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "list_department_services",
        tableName: "services",
        params: { outcome: "success", service_count: services.length },
      });

      if (services.length === 0) {
        return {
          found: true as const,
          department: selected,
          services: [],
          service_count: 0,
          departments,
          guidance:
            `No services are currently configured for ${selected.name}. Say so plainly, offer ` +
            "another department, and never quote a price. Do not say the clinic has no services " +
            "at all — only that this department has none listed.",
        };
      }

      return {
        found: true as const,
        scope: "department" as const,
        complete: true as const,
        department: selected,
        services,
        service_count: services.length,
        currency,
        guidance:
          `These are the real configured services and prices for ${selected.name}. Give the name ` +
          "and the price for each, exactly as stored — format the amount naturally in the " +
          "patient's language using the currency code given, but never change, round, estimate " +
          "or convert a number, and never add a service that is not in this list. If they ask " +
          "about something not listed, say it is not among the configured services and offer " +
          "clinic staff.",
      };
    },
  });
}
