/**
 * P6A — adversarial & evaluation suites entry point.
 *
 * See `docs/reports/P6A_IMPLEMENTATION.md`. Run both suites locally with:
 *   pnpm test:ai-adversarial
 */
export * from "@/lib/ai/eval/injection-corpus";
export * from "@/lib/ai/eval/eval-set";
export {
  ALL_STAFF_ROLES,
  maximalStaffTools,
  unscopedStaffTools,
  allStaffToolNames,
  patientTools,
  staffOnlyToolNames,
  patientOnlyToolNames,
} from "@/lib/ai/eval/authorized-tools";
export {
  reachableToolsFor,
  checkRubricConsistency,
  scoreOfflineConsistency,
  gradeTurn,
  scoreEvalRun,
  type RubricConsistency,
  type ObservedTurn,
  type TurnGrade,
} from "@/lib/ai/eval/grade";
