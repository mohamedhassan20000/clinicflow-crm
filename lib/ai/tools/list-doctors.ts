import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  departmentDoctorsPayload,
  loadDoctorDirectory,
  type DirectoryDepartment,
} from "@/lib/ai/doctor-directory";
import { establishedDepartmentId } from "@/lib/ai/booking-stage";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import { normalizeHumanText } from "@/lib/ai/human-input";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";

/**
 * "Are there other doctors?" — answered without touching booking state.
 *
 * `prepare_booking` can answer this too, but it also *writes* the conversation's
 * collected department and doctor, which makes it the wrong shape for a question
 * that should change nothing. A read-only roster tool means the assistant has a
 * safe move for the follow-up, so it never has to restart the flow or re-ask for
 * the department in order to name a second doctor.
 *
 * It reads the department already established in this conversation when none is
 * named, which is what preserves booking context across "مين تاني؟".
 */
export function listDoctorsTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List every bookable doctor of one department. Use it for follow-ups such as 'are there " +
      "other doctors?', 'مين تاني؟', 'عايز دكتور تاني', or 'who else is available?'. With no " +
      "department it uses the one this conversation already chose, so the booking context is " +
      "preserved. Set all_departments only when the patient explicitly asks for doctors in every " +
      "department. It changes nothing and never picks a doctor.",
    inputSchema: z.object({
      department: z.string().trim().min(1).max(120).optional(),
      all_departments: z.boolean().optional(),
      /**
       * Set to drop the doctor already offered from the list of alternatives.
       * An id, or nothing — a value that is not one simply excludes no one, which
       * is a harmless answer and, unlike a rejected tool call, a recoverable one.
       */
      exclude_doctor_id: z.string().trim().min(1).max(120).optional(),
    }),
    execute: async ({ department, all_departments, exclude_doctor_id }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
      });
      const directory = await loadDoctorDirectory(identity.clinicId);
      const departments = directory.departments;

      const normalizedDepartment = normalizeHumanText(department ?? "").toLowerCase();
      const latestText = normalizeHumanText(ctx.episodeUtterances?.at(-1) ?? "").toLowerCase();
      const allDepartmentsPattern = /(?:all|every|كل|جميع)[\s\S]{0,24}(?:departments?|الأقسام|الاقسام)|(?:departments?|الأقسام|الاقسام)[\s\S]{0,24}(?:all|every|كل|جميع)/i;
      const wantsAll =
        all_departments === true ||
        /^(?:all|all departments|every department|كلهم|كلها|الكل|كل الاقسام|كل الأقسام|جميع الاقسام|جميع الأقسام)$/.test(normalizedDepartment) ||
        allDepartmentsPattern.test(latestText);
      if (wantsAll) {
        return {
          scope: "all_departments" as const,
          complete: true as const,
          departments: departments.map((item) => {
            const roster = departmentDoctorsPayload(directory, item);
            return {
              id: item.id,
              name: item.name,
              doctors: roster.doctors,
              doctor_count: roster.doctor_count,
              only_one_available: roster.only_one_available,
            };
          }),
          guidance:
            "List every department and every bookable doctor under it. This is informational: " +
            "do not ask which doctor they want and do not change the booking selection.",
        };
      }

      let selected: DirectoryDepartment | null = null;
      if (department) {
        const resolution = resolveNamedEntity(department, departments);
        if (resolution.status !== "resolved") {
          return {
            needs_clarification: true as const,
            field: "department",
            reason: resolution.status,
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
        selected = resolution.entity;
      } else {
        // P9: the same "what has this conversation already chosen?" question
        // `prepare_booking` asks, asked through the same function. Preserving
        // the department across "مين تاني؟" is the whole reason this tool
        // exists, and it must not be able to answer it differently.
        const establishedId = establishedDepartmentId(identity.collectedData);
        selected = departments.find((item) => item.id === establishedId) ?? null;
      }

      if (!selected) {
        return {
          needs_selection: true as const,
          field: "department",
          departments,
          guidance:
            "No department has been chosen in this conversation yet. Offer these active " +
            "departments and ask which one they need.",
        };
      }

      const roster = departmentDoctorsPayload(directory, selected, {
        excludeDoctorId: exclude_doctor_id ?? null,
      });
      // Read-only by design: this records what was *offered*, and nothing else.
      // The department and doctor in `ai_collected_data` are untouched, which is
      // the property that makes "who else?" a follow-up rather than a restart.
      if (!ctx.informationalOnly) {
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "list_doctors",
          outcome: roster.doctor_count === 0 ? "empty_roster" : "roster",
          offeredDoctorIds: roster.doctors.map((item) => item.id),
        });
      }
      return {
        ...roster,
        // Stated explicitly so a follow-up never looks like the start of a new
        // booking: the department is settled and must not be asked for again.
        department_already_selected: true as const,
        guidance:
          roster.doctor_count === 0
            ? "There is no other bookable doctor in this department. Say so plainly and offer to " +
              "continue with the doctor already discussed or to choose another department."
            : roster.doctor_count === 1
              ? "Exactly one other doctor is available. Name them and say they are the only " +
                "alternative in this department."
              : "Name EVERY doctor in `doctors` in one sentence and ask which one they want. Do " +
                "not shorten the list and never name a doctor that is not in it.",
      };
    },
  });
}
