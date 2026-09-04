import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  dateOrderForCountry,
  parseHumanEmail,
  parseHumanName,
  parseNationalId,
} from "@/lib/ai/human-input";
import {
  checkIntakeProvenance,
  collectIntakeEvidence,
  INTAKE_PROVENANCE_GUIDANCE,
} from "@/lib/ai/intake-provenance";
import { proposeLatinName } from "@/lib/ai/name-transliteration";
import {
  buildBloodTypeQuestion,
  buildBloodTypeRetry,
  isBloodTypeDeclined,
  buildNameConfirmationQuestion,
  buildNameSpellingRequest,
} from "@/lib/ai/intake-answers";
import { MAX_BLOOD_TYPE_ASKS } from "@/lib/ai/booking-stage";
import { logAgentTool } from "@/lib/ai/audit";
import {
  describeExistingBeneficiary,
  findExistingBeneficiary,
} from "@/lib/ai/existing-patient-discovery";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import {
  resolvePatientDate,
  resolvePatientInput,
  resolveThirdPartyDate,
  resolveThirdPartyInput,
} from "@/lib/ai/patient-input";
import {
  readPatientPhone,
  readStatedPhoneCountry,
} from "@/lib/ai/patient-phone-intake";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import {
  buildIntakeQuestion,
  patientFacingFieldList,
} from "@/lib/ai/patient-intake-contract";
import {
  stageMatchedThirdPartyIntake,
  stagePatientIntakeFromConversation,
} from "@/lib/supabase/admin";

/**
 * P8 — registering the person writing in, when the clinic has no record of them.
 *
 * Before this, a message from an unknown number hit `patient_unlinked` on every
 * tool and the assistant's only honest move was "I cannot help you, please call
 * the clinic" — for someone who was trying to become a patient. The whole point
 * of a booking assistant is that this person can finish what they started.
 *
 * What this tool is *not* is a general patient-creation API with a model on the
 * end of it. Four things are structurally out of the model's reach:
 *
 *   * **The phone number.** For the sender it is never an argument: the reviewed
 *     RPC takes it from the conversation participant. For a third party it is
 *     required explicitly and is kept in that person's isolated intake draft;
 *     the sender's number is never used as a fallback for somebody else.
 *   * **The patient id.** Nothing here accepts or returns one. An existing
 *     patient is *found* by the duplicate check, never named.
 *   * **The clinic.** It comes from the verified channel routing, as every other
 *     patient tool's does.
 *   * **Duplicate handling.** An existing record is only ever linked when the
 *     WhatsApp-proved phone selects it *and* every stored field the sender was
 *     asked for confirms it. Anything else — a national id that names somebody
 *     whose number this is not, two records on one number, a date of birth that
 *     does not agree — stops and hands the decision to staff.
 *
 * The identity rules themselves live in `stage_patient_intake_from_conversation`,
 * where they are enforced in one transaction alongside the write. Nothing here
 * re-implements them; this function's job is to normalize what the patient typed
 * and to translate the outcome into something the assistant can say out loud
 * without leaking whether a given national id exists in the clinic's records.
 *
 * Everything the patient typed is normalized deterministically first (see
 * `human-input.ts`), so "١٢/٩/٢٠٠٠" and "Ahmed  Ali " are accepted as written and
 * a field that genuinely cannot be read is named back to the model precisely
 * enough for it to ask one short question about that field alone.
 */
/** Three identical asks is a loop, not a conversation. */
const INTAKE_ASK_REPEAT_LIMIT = 3;

export function registerPatientTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Register a new patient of this clinic: either the person writing in, when the conversation " +
      "is not yet linked to a record, or somebody they are booking on behalf of. Set " +
      "`for_someone_else` whenever the patient says the appointment is for another person — " +
      "'لصاحبي', 'لأخي', 'لوالدتي', 'for my friend' — and collect that person's details, not the " +
      "sender's. Pass everything through exactly as it was written: everyday formats, Arabic " +
      "digits and Arabic month names are all accepted. Never invent details. For the sender, never " +
      "ask for a phone number — the clinic already knows which number is writing.",
    inputSchema: z.object({
      /**
       * P9C — the subject of the registration. Without it the assistant had no
       * way to say "this is not the sender", and a booking made for a friend
       * would have been filed under whoever happened to be holding the phone.
       */
      for_someone_else: z
        .boolean()
        .optional()
        .describe(
          "True when these details belong to somebody other than the person writing in.",
        ),
      phone: z
        .string()
        .trim()
        .min(4)
        .max(40)
        .optional()
        .describe(
          "Required for `for_someone_else`: that person's own contact number. Ignored otherwise " +
            "— the sender's number is channel-owned and never an argument.",
        ),
      /**
       * P12-QA — the country the patient named when asked «الرقم تابع لأي
       * دولة؟». Only ever a country, never a number: it replaces the clinic's
       * default assumption for `phone` and nothing else.
       */
      phone_country: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe(
          "The country the phone number belongs to, in the patient's own words ('الكويت', " +
            "'Kuwait', '+965'), when they have just said. Leave empty otherwise.",
        ),
      // P11H — optional at the model boundary so a forced intake write can
      // report exactly what is missing instead of pressuring the model to
      // fabricate schema-required values. The server write remains impossible
      // until every required field validates below.
      full_name: z.string().trim().max(120).optional().describe("The patient's full name as they wrote it."),
      national_id: z
        .string()
        .trim()
        .max(40)
        .optional()
        .describe("The patient's national or civil id, spacing and dashes included."),
      date_of_birth: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe("Date of birth in the patient's own words. Do not reformat it."),
      email: z.string().trim().max(320).optional().describe("The patient's email address."),
      blood_type: z
        .string()
        .trim()
        .min(1)
        .max(24)
        .optional()
        .describe(
          "The patient's blood type in their own words — 'O+', 'o positive', 'بي سالب'. " +
            "Optional: omit it if they do not know it or would rather not say. Never a reason " +
            "to delay or refuse the registration.",
        ),
      /**
       * P10 — the patient has seen the proposed English spelling of their name
       * and said it is right.
       *
       * Only ever set in answer to `name_spelling_confirmation_required`. It is
       * a confirmation, not a value: the spelling that gets filed is the one
       * this tool proposed, never one the model composes.
       */
      name_spelling_confirmed: z
        .boolean()
        .optional()
        .describe(
          "True only when the patient has explicitly confirmed the English spelling you showed " +
            "them in the previous turn. Never set it on the first attempt.",
        ),
    }),
    execute: async (input) => {
      // Scheduling entitlement, not merely FAQ: registration exists to let a
      // booking finish, and a clinic without the booking feature has no use for
      // patient records created by an assistant.
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
        refuseIfPaused: true,
      });

      const forThirdParty =
        input.for_someone_else === true || identity.bookingStage.bookingForOther;
      const priorThirdParty = forThirdParty
        ? identity.bookingStage.thirdPartyIntake
        : null;
      if (forThirdParty) {
        // Latched before any validation runs. A friend whose date of birth was
        // unreadable still has to be askable about on the next turn, and that
        // requires the stage to still mount this tool.
        await recordStageTurn(identity, {
          bookingIntent: true,
          bookingForOther: true,
        });
      }
      // A linked sender has nothing to register about *themselves*. Registering
      // the person they are booking for is a different act with a different
      // subject, and it is the one this branch used to make impossible.
      if (identity.linked && identity.patientId && !forThirdParty) {
        return {
          registered: false as const,
          reason: "already_linked" as const,
          guidance:
            "This conversation is already linked to a patient record. Continue with the booking; " +
            "do not ask for registration details. If the appointment is for somebody else, call " +
            "this tool again with for_someone_else set and that person's details.",
        };
      }

      // P8B: every field is resolved against what this conversation already
      // established, so details that arrived over several messages — and a date
      // of birth whose month was clarified two turns ago — are not asked for
      // again. Each resolution is deterministic; none of them is evidence of
      // identity, and the RPC below re-derives the phone number from the
      // conversation regardless of any of this.
      // For the sender, every field is resolved against what this conversation
      // already established, so details spread over several messages are not
      // asked for again. For a third party that memory is *wrong* — the stored
      // `full_name` and `date_of_birth` are the sender's, and reusing them would
      // quietly stage a file combining two different people. The friend's
      // details are therefore taken only from what was said about the friend.
      const [nameOutcome, idOutcome, emailOutcome] = forThirdParty
        ? [
            resolveThirdPartyInput(
              identity,
              "full_name",
              input.full_name ?? priorThirdParty?.fullName ?? "",
            ),
            resolveThirdPartyInput(
              identity,
              "national_id",
              input.national_id ?? priorThirdParty?.nationalId ?? "",
            ),
            resolveThirdPartyInput(
              identity,
              "email",
              input.email ?? priorThirdParty?.email ?? "",
            ),
          ]
        : await Promise.all([
            resolvePatientInput(identity, "full_name", input.full_name ?? ""),
            resolvePatientInput(identity, "national_id", input.national_id ?? ""),
            resolvePatientInput(identity, "email", input.email ?? ""),
          ]);
      const dobOutcome = forThirdParty
        ? resolveThirdPartyDate(
            identity,
            "date_of_birth",
            input.date_of_birth ?? priorThirdParty?.dateOfBirth ?? "",
          )
        : await resolvePatientDate(identity, "date_of_birth", input.date_of_birth ?? "");
      // P12-QA — the other person's number, read with the country in play
      // rather than forced through the clinic's own.
      //
      // `resolveField` gave one bit — E.164 or nothing — so a Kuwaiti number
      // sent to a Turkish clinic and a Turkish number with a digit missing were
      // the same dead end: "I could not read that". `readPatientPhone` keeps
      // the two apart and hands the caller a question for each. Nothing here
      // normalizes optimistically: the only value that ever reaches the draft
      // is the parser's own E.164 for a number it calls valid.
      //
      // The clinic country is the default assumption; a country the patient has
      // just named replaces it, and a number carrying its own country code
      // overrules both.
      const suppliedPhone = input.phone ?? priorThirdParty?.phone ?? "";
      const statedPhoneCountry =
        readStatedPhoneCountry(input.phone_country ?? null) ??
        readStatedPhoneCountry(ctx.episodeUtterances?.at(-1) ?? null);
      const phoneReading = forThirdParty && suppliedPhone
        ? readPatientPhone(suppliedPhone, {
            clinicCountry: identity.clinicCountry,
            statedCountry: statedPhoneCountry,
          })
        : null;
      // Optional, and resolved separately for that reason: an unreadable blood
      // type is dropped, never reported as a missing field and never a reason
      // to stop. Persisting it still matters — it is what stops the assistant
      // asking a second time on the next turn.
      // The stage store commits a blood type the patient sent in answer to the
      // question below, so a value already collected counts as supplied even
      // when the model does not repeat it.
      const collectedBloodType =
        typeof identity.collectedData.blood_type === "string"
          ? identity.collectedData.blood_type
          : undefined;
      const suppliedBloodType = forThirdParty
        ? input.blood_type ?? priorThirdParty?.bloodType
        : input.blood_type ?? collectedBloodType;
      const bloodOutcome = suppliedBloodType
        ? forThirdParty
          ? resolveThirdPartyInput(identity, "blood_type", suppliedBloodType)
          : await resolvePatientInput(identity, "blood_type", suppliedBloodType)
        : null;
      const bloodType =
        bloodOutcome && bloodOutcome.ok ? String(bloodOutcome.value) : null;

      const fullName = nameOutcome.ok ? parseHumanName(String(nameOutcome.value)) : null;
      const nationalId = idOutcome.ok ? parseNationalId(String(idOutcome.value)) : null;
      const email = emailOutcome.ok ? parseHumanEmail(String(emailOutcome.value)) : null;
      const phone =
        phoneReading?.status === "accepted" ? phoneReading.e164 : null;

      if (forThirdParty) {
        await recordStageTurn(identity, {
          bookingIntent: true,
          bookingForOther: true,
          thirdPartyIntake: {
            fullName: fullName ?? priorThirdParty?.fullName ?? null,
            nationalId: nationalId ?? priorThirdParty?.nationalId ?? null,
            dateOfBirth:
              dobOutcome.ok ? dobOutcome.iso : priorThirdParty?.dateOfBirth ?? null,
            email: email ?? priorThirdParty?.email ?? null,
            phone: phone ?? priorThirdParty?.phone ?? null,
            bloodType: bloodType ?? priorThirdParty?.bloodType ?? null,
            nameSpellingConfirmed:
              input.name_spelling_confirmed === true ||
              priorThirdParty?.nameSpellingConfirmed === true,
          },
        });
      }

      // A contradiction is its own answer: the patient has given two different
      // values for the same field and only they can say which is right. It is
      // reported before the unreadable-field list so the assistant asks the
      // sharper question rather than re-collecting everything.
      const conflicting = [
        ["full_name", nameOutcome] as const,
        ["national_id", idOutcome] as const,
        ["email", emailOutcome] as const,
      ].filter(([, outcome]) => !outcome.ok && outcome.reason === "conflicting");
      if (conflicting.length > 0) {
        const fields = conflicting.map(([field]) => field);
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: "conflicting_details" as const,
          for_someone_else: forThirdParty,
          fields,
          // P11J-2 — the identifiers above are for the model's reasoning only.
          // The words a patient may actually see are supplied here, already
          // localized, so there is never a reason to render `fields` as copy.
          patient_facing_details: patientFacingFieldList(fields, ctx.locale),
          guidance:
            "The patient has given two different values for the listed details. Ask once, " +
            "plainly, which is correct. Do not choose one yourself and do not start over. " +
            "The `fields` values are internal schema identifiers: never write them, or any " +
            "other underscored identifier, in a message to the patient — use " +
            "`patient_facing_details`, or your own natural wording, instead.",
        };
      }

      // P12-QA — the phone question, asked before the generic missing-fields
      // list so the patient gets the sharp question instead of "resend your
      // details". The draft above has already been recorded, so the name, date
      // of birth and everything else they gave survive this turn untouched;
      // only the number is outstanding.
      if (phoneReading && phoneReading.status !== "accepted") {
        const detail =
          phoneReading.status === "needs_country"
            ? {
                reason: "phone_country_unknown" as const,
                guidance:
                  "This number is not a valid number in the clinic's own country and carries no " +
                  "country code, so the country is genuinely unknown. Say plainly that it does " +
                  "not look like a local number and ask which country it belongs to — one short " +
                  "question, in the patient's language. Do not guess a country, do not add a " +
                  "country code yourself, and do not ask them to resend the number. When they " +
                  "name the country, call this tool again with the same `phone` and that country " +
                  "in `phone_country`.",
              }
            : phoneReading.status === "needs_confirmation"
              ? {
                  reason:
                    phoneReading.problem === "too_short"
                      ? ("phone_missing_digits" as const)
                      : ("phone_extra_digits" as const),
                  guidance:
                    "This number is written as a local number but has " +
                    (phoneReading.problem === "too_short" ? "fewer" : "more") +
                    " digits than that country's numbers have. Say so naturally — a digit looks " +
                    "missing / there looks to be a digit too many — and ask them to confirm or " +
                    "correct it. Never add, drop or change a digit yourself. If they correct it, " +
                    "call this tool again with the corrected number. If they insist it is right, " +
                    "ask which country it belongs to and pass that in `phone_country`; if it " +
                    "still cannot be read, tell them clinic staff will confirm the number.",
                }
              : {
                  reason: "phone_unreadable" as const,
                  guidance:
                    "That is not a phone number. Ask once, plainly, for the other person's " +
                    "number. Never invent one and never reuse the sender's.",
                };
        await recordStageTurn(identity, {
          bookingIntent: true,
          bookingForOther: true,
          tool: "register_patient",
          outcome: detail.reason,
        });
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: detail.reason,
          for_someone_else: true as const,
          fields: ["phone"],
          patient_facing_details: patientFacingFieldList(["phone"], ctx.locale),
          // The digits exactly as the patient sent them, so the question can
          // quote them back. Never a normalized or completed form.
          provided_phone: phoneReading.status === "unreadable" ? null : phoneReading.digits,
          guidance:
            detail.guidance +
            " Do not ask again for any detail the patient has already given, and do not start " +
            "the booking over.",
        };
      }

      const unreadable: string[] = [];
      if (!fullName) unreadable.push("full_name");
      if (!nationalId) unreadable.push("national_id");
      if (!email) unreadable.push("email");
      // The real patientCreateSchema requires a valid phone. For the sender it
      // is channel-owned and never an AI argument; for another person it must
      // be that person's number, never silently copied from the sender.
      if (forThirdParty && !phone) unreadable.push("phone");
      if (!dobOutcome.ok && dobOutcome.toolResult.reason === "unrecognized") {
        unreadable.push("date_of_birth");
      }
      if (unreadable.length > 0) {
        // P11J-2 — repeated-question detection.
        //
        // A patient who answers and is asked the identical question again has
        // hit a loop, and the loop is ours: something they wrote is not being
        // read the way they meant it, and asking a fourth time will not change
        // that. The stage record carries the signature of the last thing we
        // asked for, so the third identical ask hands the file to staff instead
        // of continuing.
        const signature = [...unreadable].sort().join(",");
        const priorAsk = identity.bookingStage.intakeAsk;
        const repeats = priorAsk && priorAsk.signature === signature ? priorAsk.repeats + 1 : 1;
        await recordStageTurn(identity, {
          bookingIntent: true,
          intakeAsk: { signature, repeats },
        });
        if (repeats >= INTAKE_ASK_REPEAT_LIMIT) {
          return {
            registered: false as const,
            reason: "intake_repeated_question" as const,
            for_someone_else: forThirdParty,
            guidance:
              "The same details have now been asked for three times and still cannot be read. " +
              "Do not ask again. Tell the patient, in one short sentence, that a member of " +
              "clinic staff will complete the file with them, and do not name any field.",
          };
        }
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: "unreadable_fields" as const,
          for_someone_else: forThirdParty,
          fields: unreadable,
          // The question to ask, already written in the patient's language and
          // already free of identifiers. Sending it as-is is always correct.
          patient_question: buildIntakeQuestion(unreadable, ctx.locale, {
            subject: forThirdParty ? "other" : "self",
          }),
          guidance:
            "Ask the patient again for only the listed details, in ordinary words. Never quote a " +
            "required format back to them. The `fields` values are internal schema identifiers: " +
            "never write them, or any other underscored identifier, in a message to the patient. " +
            "Use `patient_question` verbatim, or your own natural phrasing of the same request.",
        };
      }

      // Item #3 — before anything is proposed, is this person already ours?
      //
      // Manual QA: a third-party beneficiary who was already a patient here,
      // with the same authoritative id, was headed for a second file. Nothing
      // could have caught it — the only existing-patient reuse in the system is
      // keyed on the *sender's* phone, and a beneficiary is by definition not
      // the person holding the handset.
      //
      // Asked here, and not later, for two reasons. The transliteration gate
      // below proposes an English spelling for a *new* file and asks the sender
      // to approve it; putting somebody through that for a file that already
      // exists is a question with no purpose and a spelling nobody should be
      // choosing. And the match itself must be made on the name the patient
      // actually wrote — the clinic stores "جهاد علي", and folding the proposed
      // Latin "Ghad Ali" against it would never match.
      //
      // Third-party only, deliberately. The sender's own path already has a
      // rule here: an id matching a record their phone does not belong to comes
      // back `duplicate_review`, on purpose, so the assistant cannot be used to
      // find out whether a given id belongs to a patient. That rule is
      // untouched. This adds the case that had no rule at all, at the same bar
      // — exact folded id *and* exactly folded name, decided in the database,
      // disclosing nothing when either fails.
      if (forThirdParty) {
        const discovery = await findExistingBeneficiary({
          clinicId: identity.clinicId,
          nationalId: nationalId!,
          fullName: fullName!,
        });
        if (discovery.kind !== "none") {
          // Where the booking is headed, as the conversation has settled it so
          // far. A matched beneficiary usually reaches here with neither set —
          // finding out where they are already known is the *point*, and it is
          // what the patient is about to be asked about. Nothing is staged
          // until that question has an answer, because the intake row records
          // the department and doctor the appointment is for.
          const settledDepartmentId =
            typeof identity.collectedData.department_id === "string"
              ? identity.collectedData.department_id
              : null;
          const settledDoctorId =
            typeof identity.collectedData.doctor_id === "string"
              ? identity.collectedData.doctor_id
              : null;
          if (!settledDepartmentId || !settledDoctorId) {
            await recordStageTurn(identity, {
              bookingIntent: true,
              tool: "register_patient",
              outcome: "matched_existing_pending_target",
              bookingForOther: true,
            });
            await logAgentTool({
              clinicId: identity.clinicId,
              actorId: null,
              tool: "register_patient",
              params: { outcome: "matched_existing_pending_target" },
            });
            return {
              registered: false as const,
              existing_patient: true as const,
              intake_staged: false as const,
              patient_name: discovery.patientName,
              ...describeExistingBeneficiary(discovery),
              guidance:
                "This person already has a file at this clinic, so no new file will be proposed " +
                "and no spelling needs confirming. Say that their file is already here, name the " +
                "department (and the treating doctor when one is given), and ask whether to book " +
                "in the same department with the same doctor. If more than one department is " +
                "given, ask which one first, and only then offer that department's treating " +
                "doctor. Once they answer, call prepare_booking with what they chose and then " +
                "call this tool again. If they want a different department or a different " +
                "doctor, continue the ordinary discovery flow and never force the historical " +
                "one. Do not read out any other detail of their file.",
            };
          }
          const staged = await stageMatchedThirdPartyIntake({
            clinicId: identity.clinicId,
            conversationId: identity.conversationId,
            fullName: fullName!,
            nationalId: nationalId!,
            phone: phone ?? null,
            departmentId: settledDepartmentId,
            doctorId: settledDoctorId,
          });
          const row = staged.data?.[0];
          // A refusal is not a reason to open a duplicate instead — that is the
          // exact outcome this branch exists to prevent. Staff pick it up.
          if (staged.error || !row || row.status === "no_match") {
            await logAgentTool({
              clinicId: identity.clinicId,
              actorId: null,
              tool: "register_patient",
              params: { outcome: "matched_existing_stage_failed" },
            });
            return {
              registered: false as const,
              reason: "needs_staff_review" as const,
              guidance:
                "This person already has a file here and it could not be attached automatically. " +
                "Do not create anything, do not ask for the details again, and do not say which " +
                "detail was involved. Tell the patient a member of clinic staff will confirm the " +
                "file and follow up.",
            };
          }
          await recordStageTurn(identity, {
            bookingIntent: true,
            tool: "register_patient",
            outcome: "matched_existing",
            intakeStaged: true,
            bookingForOther: true,
          });
          await logAgentTool({
            clinicId: identity.clinicId,
            actorId: null,
            tool: "register_patient",
            params: { outcome: row.status },
          });
          return {
            registered: false as const,
            existing_patient: true as const,
            intake_staged: true as const,
            awaiting_staff_review: true as const,
            can_request_appointment: true as const,
            patient_name: discovery.patientName,
            ...describeExistingBeneficiary(discovery),
            guidance:
              "This person already has a file at this clinic, so no new file was proposed and no " +
              "spelling needs confirming. Say that their file is already here, name the " +
              "department (and the treating doctor when one is given), and ask whether to book in " +
              "the same department with the same doctor. If more than one department is given, " +
              "ask which one they want first, and only then offer that department's treating " +
              "doctor. If they want a different department or a different doctor, continue the " +
              "ordinary discovery flow and never force the historical one. Do not read out any " +
              "other detail of their file.",
          };
        }
      }
      if (!dobOutcome.ok) {
        // Ambiguous, incomplete or contradictory — one short question about the
        // date alone, never a restart of the registration.
        // `toolResult` carries its own `reason` — `ambiguous_date`,
        // `incomplete_date` or `conflicting_date` — which is the sharper thing
        // to tell the model than "something about the date".
        //
        // A third-party field never enters the sender's collected-data or
        // clarification slots. Its complete, successfully resolved values are
        // remembered in the isolated booking-stage draft instead.
        return {
          registered: false as const,
          ...dobOutcome.toolResult,
          ...(forThirdParty
            ? {
                guidance:
                  `${String(dobOutcome.toolResult.guidance ?? "")} ` +
                  "This date belongs to the other person. Their other resolved details are " +
                  "already remembered in an isolated intake draft; ask only for the complete " +
                  "date of birth — day, month in words, and year — then call register_patient " +
                  "again with for_someone_else.",
              }
            : {}),
        };
      }

      // F-8 — the provenance gate.
      //
      // Everything above this line is a *format* check: `parseNationalId` asks
      // whether the value is 5-32 alphanumerics, `parseHumanDate` whether it is
      // a real calendar date, `parseHumanEmail` whether it has an @ and a dot.
      // A fabricated value passes all three by construction, and in the managed
      // live acceptance run that is exactly what happened — a stranger who had
      // given only their name had a national id, a date of birth and an email
      // invented for them, staged, and a booking created behind the staged
      // intake.
      //
      // This is the one check that asks where the value came from. It compares
      // each resolved value against the patient's own messages this episode,
      // allowing every normalization `human-input.ts` performs and nothing
      // else, and it can only refuse. Nothing is written when it refuses, and
      // the refusal is indistinguishable, to the patient, from a value that was
      // genuinely unreadable.
      //
      // `full_name` is checked as the patient wrote it (`fullName`), not as it
      // will be filed: the Latin spelling below is the *server's* proposal and
      // has no business proving its own provenance.
      const provenance = checkIntakeProvenance({
        evidence: ctx.episodeUtterances
          ? collectIntakeEvidence(ctx.episodeUtterances, {
              order: dateOrderForCountry(identity.clinicCountry),
            })
          : null,
        claim: {
          full_name: fullName,
          national_id: nationalId,
          date_of_birth: dobOutcome.iso,
          email,
          ...(forThirdParty ? { phone } : {}),
        },
      });
      if (!provenance.ok) {
        // Provenance without content: which fields failed the check, never a
        // value, a token or a digest of one. The content-free ledger rule is
        // unchanged.
        await logAgentTool({
          clinicId: identity.clinicId,
          actorId: null,
          tool: "register_patient",
          params: {
            outcome: "intake_provenance_refused",
            fields: provenance.untraceable.join(","),
          },
        });
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: "unreadable_fields" as const,
          for_someone_else: forThirdParty,
          fields: [...provenance.untraceable],
          patient_question: buildIntakeQuestion(
            [...provenance.untraceable],
            ctx.locale,
            { subject: forThirdParty ? "other" : "self" },
          ),
          guidance: `${INTAKE_PROVENANCE_GUIDANCE} The \`fields\` values are internal schema identifiers: never write them, or any other underscored identifier, in a message to the patient. Use \`patient_question\` verbatim, or your own natural phrasing of the same request.`,
        };
      }

      // Everything readable: whatever loop the patient was in is over.
      if (identity.bookingStage.intakeAsk) {
        await recordStageTurn(identity, { bookingIntent: true, intakeAsk: null });
      }

      // P10 — the name that goes on the file.
      //
      // ClinicFlow patient files are keyed on a Latin-script name, and a
      // WhatsApp patient writes theirs in Arabic. Where every part of the name
      // has a curated reading the transliteration is a lookup and is applied
      // silently; where any part does not, the spelling below is a
      // character-level guess and is shown to the patient once before it
      // becomes their medical record. Their own spelling is preserved either
      // way — `full_name_original` carries it beside the transliteration, so
      // nothing they wrote is destroyed by the convenience.
      //
      // Manual QA found the half that was missing: the spelling was only ever
      // *questioned*, never *shown*. The refusal below used to reach the patient
      // as "the file has not been saved because the spelling needs confirming",
      // which names no spelling and asks nothing, so there was nothing for them
      // to answer. And the confirmation lived only in the model's reading of the
      // transcript, so an answer to it could be missed or invented.
      //
      // Both halves are now deterministic. The question carries the proposed
      // spelling verbatim; the answer is read by `readNameConfirmation` in the
      // turn opener, which writes the settled name and the latch below. A
      // spelling the patient supplies themselves is filed exactly as they wrote
      // it and is never transliterated again.
      const spellingSettled =
        input.name_spelling_confirmed === true ||
        priorThirdParty?.nameSpellingConfirmed === true ||
        (!forThirdParty && identity.bookingStage.nameSpellingConfirmed);
      // The settled name is the *stored* one, not the argument: a model that
      // resends the original Arabic must not undo a spelling the patient chose.
      // Only a Latin stored name can be that — a settled intake whose stored
      // name is still Arabic (the patient confirmed a proposal composed from it)
      // falls through to the transliteration below, which no longer asks.
      const storedName = forThirdParty
        ? priorThirdParty?.fullName ?? null
        : typeof identity.collectedData.full_name === "string"
          ? identity.collectedData.full_name
          : null;
      const settledName =
        spellingSettled && storedName && !/[؀-ۿ]/.test(storedName) ? storedName : null;
      const nameProposal = settledName ? null : proposeLatinName(fullName!);
      if (nameProposal && !nameProposal.alreadyLatin && !spellingSettled) {
        await recordStageTurn(identity, {
          bookingIntent: true,
          ...(forThirdParty ? { bookingForOther: true } : {}),
          pendingNameConfirmation: {
            proposed: nameProposal.proposed,
            original: nameProposal.original,
          },
          tool: "register_patient",
          outcome: "name_spelling_confirmation_required",
        });
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: "name_spelling_confirmation_required" as const,
          for_someone_else: forThirdParty,
          proposed_name: nameProposal.proposed,
          patient_question:
            identity.bookingStage.pendingNameConfirmation?.proposed === nameProposal.proposed
              ? buildNameSpellingRequest(ctx.locale)
              : buildNameConfirmationQuestion(ctx.locale, nameProposal.proposed),
          guidance:
            "Use `patient_question` verbatim. It shows the patient the exact English spelling " +
            "their file would be opened with and asks whether it is right. Their answer is read " +
            "by the server, not by you: do not set name_spelling_confirmed and do not compose a " +
            "spelling of your own. Never file a spelling the patient has not seen.",
        };
      }
      const filedName = settledName ?? (nameProposal ? nameProposal.proposed : fullName!);
      // What the patient actually typed, kept beside what we file. The
      // confirmation record survives the confirmation for exactly this reason:
      // `full_name_original` is what a reviewing staff member reads next to the
      // spelling, and losing it would make the transliteration unauditable.
      const confirmationRecord = identity.bookingStage.pendingNameConfirmation;
      const originalName =
        (nameProposal && !nameProposal.alreadyLatin ? nameProposal.original : null) ??
        (confirmationRecord && confirmationRecord.original !== filedName
          ? confirmationRecord.original
          : null);

      const departmentId =
        typeof identity.collectedData.department_id === "string"
          ? identity.collectedData.department_id
          : null;
      const doctorId =
        typeof identity.collectedData.doctor_id === "string"
          ? identity.collectedData.doctor_id
          : null;
      if (!departmentId || !doctorId) {
        return {
          registered: false as const,
          reason: "assignment_required" as const,
          for_someone_else: forThirdParty,
          patient_question: buildIntakeQuestion(
            [...(departmentId ? [] : ["department_id"]), ...(doctorId ? [] : ["doctor_id"])],
            ctx.locale,
            { subject: forThirdParty ? "other" : "self" },
          ),
          guidance:
            "The personal details are already collected. Call prepare_booking to resolve one active " +
            "department and one active doctor in it, then call register_patient without asking for " +
            "these personal details again.",
        };
      }

      // Blood type, asked once, before the file exists.
      //
      // Manual QA found it skipped entirely: it is optional on the schema, so
      // nothing in the flow ever *required* the question to be put, and the
      // file was staged without it. Optional means the patient may decline —
      // "لا أعرف" resolves the step exactly as "O+" does — it does not mean the
      // question may go unasked. The answer is read deterministically by the
      // turn opener; this is only the gate that makes sure the question happens
      // while a new file is still being staged.
      //
      // It is placed here on purpose: after identity, contact, department and
      // doctor are all settled, and immediately before the only call in this
      // file that creates anything. It never runs for a linked patient booking
      // for themselves — that path returns `already_linked` far above.
      const bloodTypeState = identity.bookingStage;
      const bloodTypeSettled =
        Boolean(bloodType) ||
        // "I don't know" reaching the tool as the argument is the same answer
        // as "I don't know" reaching the turn opener as a message.
        (typeof suppliedBloodType === "string" && isBloodTypeDeclined(suppliedBloodType)) ||
        bloodTypeState.bloodTypeResolved ||
        // The loop guard, and the one case where the question is dropped without
        // the patient declining: three unreadable answers running. A question
        // that repeats forever is worse than an optional field left empty.
        bloodTypeState.bloodTypeAsks >= MAX_BLOOD_TYPE_ASKS;
      if (!bloodTypeSettled) {
        const firstAsk = bloodTypeState.bloodTypeAsks === 0;
        await recordStageTurn(identity, {
          bookingIntent: true,
          ...(forThirdParty ? { bookingForOther: true } : {}),
          bloodTypeAsk: true,
          tool: "register_patient",
          outcome: firstAsk ? "blood_type_requested" : "blood_type_unreadable",
        });
        return {
          registered: false as const,
          needs_clarification: true as const,
          reason: firstAsk
            ? ("blood_type_required" as const)
            : ("blood_type_invalid" as const),
          for_someone_else: forThirdParty,
          patient_question: firstAsk
            ? buildBloodTypeQuestion(ctx.locale)
            : buildBloodTypeRetry(ctx.locale),
          guidance:
            "Use `patient_question` verbatim. Blood type is optional: if the patient says they do " +
            "not know, or asks to skip it, that is a complete answer and the file is staged " +
            "without it on the next call. Never invent a blood type and never treat this as a " +
            "reason the registration failed.",
        };
      }

      const result = await stagePatientIntakeFromConversation({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        // Non-null by construction: the `unreadable` guard above returns when
        // any of the three failed to parse.
        fullName: filedName,
        nationalId: nationalId!,
        dateOfBirth: dobOutcome.iso,
        email: email!,
        departmentId,
        doctorId,
        forThirdParty,
        ...(bloodType ? { bloodType } : {}),
        ...(originalName ? { fullNameOriginal: originalName } : {}),
        // Absent, not null, on the sender's path: the sender's number is never
        // an argument to this boundary and the call site should not look as
        // though it could be.
        ...(forThirdParty && phone ? { phone } : {}),
      });
      if (result.error || !result.data?.[0]) {
        return {
          registered: false as const,
          reason: "registration_failed" as const,
          guidance:
            "Registration could not be completed. Tell the patient a member of clinic staff will " +
            "follow up, and do not retry.",
        };
      }

      const outcome = result.data[0];
      // Provenance without content: which decision was reached, never the name,
      // the id, the email or the date.
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "register_patient",
        params: { outcome: outcome.status },
      });

      if (outcome.status === "duplicate_ambiguous") {
        return {
          registered: false as const,
          reason: "duplicate_ambiguous" as const,
          guidance:
            "More than one existing record could be this patient. Do not create anything. Tell the " +
            "patient that clinic staff will confirm their file and continue from there.",
        };
      }
      // C1: the details point at a record this number does not belong to. The
      // wording below is deliberately identical to the ambiguous case and says
      // nothing about *what* matched — an assistant that replied "we already
      // have that national id" would be an existence oracle for every id the
      // sender cared to try.
      if (outcome.status === "duplicate_review" || outcome.status === "identity_mismatch") {
        return {
          registered: false as const,
          reason: "needs_staff_review" as const,
          guidance:
            "This registration cannot be completed automatically. Do not create anything, do not " +
            "ask for the details again, and do not say which detail was the problem. Tell the " +
            "patient that a member of clinic staff will confirm their file and follow up.",
        };
      }
      if (outcome.status === "identity_locked") {
        return {
          registered: false as const,
          reason: "identity_verification_locked" as const,
          guidance:
            "Do not retry registration on this conversation. Ask the patient to contact clinic " +
            "staff directly, and do not say which detail was the problem.",
        };
      }
      if (outcome.status === "already_linked") {
        return {
          registered: false as const,
          reason: "already_linked" as const,
          guidance: "This conversation is already linked to a patient. Continue with the booking.",
        };
      }

      if (outcome.status === "staged") {
        // The one latch the collected fields can never imply: a staged intake
        // means this stranger may now continue into a real-slot request even
        // though the conversation is still unlinked.
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "register_patient",
          outcome: "staged",
          intakeStaged: true,
          thirdPartyIntake: forThirdParty ? null : undefined,
          ...(forThirdParty ? { bookingForOther: true } : {}),
        });
        return {
          registered: false as const,
          intake_staged: true as const,
          intake_id: outcome.intake_id,
          intake_status: "pending_review" as const,
          intake: {
            id: outcome.intake_id,
            status: "pending_review" as const,
            entity: "ai_patient_intake" as const,
          },
          awaiting_staff_review: true as const,
          can_request_appointment: true as const,
          guidance:
            "The proposed patient file is securely staged for staff review. Do not say the patient " +
            "is registered yet. Continue to a real-slot appointment request if they asked to book, " +
            "and explain that both the file and appointment await clinic confirmation.",
        };
      }
      if (outcome.status !== "linked_existing") {
        return {
          registered: false as const,
          reason: "registration_failed" as const,
          guidance:
            "The intake cannot be changed automatically. Tell the patient clinic staff will follow " +
            "up, and do not retry or ask for the same details again.",
        };
      }

      await recordStageTurn(identity, {
        bookingIntent: true,
        tool: "register_patient",
        outcome: "linked_existing",
        intakeStaged: true,
      });
      // Exact phone-bound identity can still connect a real existing file. No
      // fuzzy entity resolver participates in this decision.
      return {
        registered: true as const,
        matched_existing: outcome.status === "linked_existing",
        identity_verification_required: false as const,
        guidance:
          "An existing record matched, and this conversation is now linked to it. Continue with " +
          "the booking without repeating any questions.",
      };
    },
  });
}
