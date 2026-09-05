import type { z } from "zod";
import type { AuthedUser, UserRole } from "@/lib/rbac";

export type DomainMutationMode = "preview" | "execute";

export type DomainMutationAudit = {
  targetTable: string;
  targetRecordIds?: readonly string[];
  before?: unknown;
  after?: unknown;
};

export type DomainMutationSuccess<T> = {
  ok: true;
  data: T;
  audit: DomainMutationAudit;
};

export type DomainMutationFailure = {
  ok: false;
  code: string;
  values?: Record<string, string | number | Date>;
  validationError?: z.ZodError;
  fieldErrorCodes?: Record<string, readonly string[]>;
  details?: Readonly<Record<string, unknown>>;
};

export type DomainMutationResult<T> =
  | DomainMutationSuccess<T>
  | DomainMutationFailure;

export class DomainMutationAuthorizationError extends Error {
  constructor(
    public readonly role: UserRole,
    public readonly allowedRoles: readonly UserRole[],
  ) {
    super(`Role ${role} is not authorized for this domain mutation.`);
    this.name = "DomainMutationAuthorizationError";
  }
}

/**
 * Domain cores are callable without a request/session guard, so they must fail
 * closed when invoked directly. The action registry mirrors these same role
 * arrays and re-checks them after a confirmation token is claimed.
 */
export function assertDomainMutationRole(
  user: AuthedUser,
  allowedRoles: readonly UserRole[],
): void {
  if (!allowedRoles.includes(user.role)) {
    throw new DomainMutationAuthorizationError(user.role, allowedRoles);
  }
}

export function domainFailure(
  code: string,
  options?: Omit<DomainMutationFailure, "ok" | "code">,
): DomainMutationFailure {
  return { ok: false, code, ...options };
}

export function domainSuccess<T>(
  data: T,
  audit: DomainMutationAudit,
): DomainMutationSuccess<T> {
  return { ok: true, data, audit };
}
