export class ActionBusinessRuleError extends Error {
  constructor(public readonly code: string) {
    super(`AI action business rule refused: ${code}`);
    this.name = "ActionBusinessRuleError";
  }
}

/**
 * P6-06 — a timeout, 5xx, or unexpected resolver failure inside an action.
 *
 * §11's denial taxonomy has a dedicated `transient_failure` row precisely so a
 * retryable infrastructure problem is never reported under a reason belonging to
 * another row: telling a user their own data is "out of scope" is a false
 * authorization statement, and it suppresses the "retry once, then offer the UI
 * path" guidance `DENIAL_GUIDANCE` defines. Distinct from
 * `ActionBusinessRuleError`, which is a permanent domain refusal.
 */
export class ActionTransientError extends Error {
  constructor(public readonly code: string) {
    super(`AI action transient failure: ${code}`);
    this.name = "ActionTransientError";
  }
}
