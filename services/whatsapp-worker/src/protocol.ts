/**
 * The contract between this worker and the ClinicFlow application.
 *
 * There is a deployment-ordering trap here that no amount of care at pairing
 * time can close from the application alone. Account isolation is a property of
 * *both* halves: the worker must resolve the authenticated account from the
 * Baileys socket identity and stamp it on every row it writes, and the
 * application must refuse to interpret anything that is not so stamped. A web
 * deploy that reaches production before the worker does would otherwise offer
 * "Connect with QR" against a worker that still writes account-less rows — and
 * the first scan, not the deploy, is when that becomes visible and expensive.
 *
 * So the worker publishes what it can do, the application checks it before it
 * lets anyone scan anything, and the two can be deployed in either order
 * without a window in which pairing half-works.
 *
 * Bump `WORKER_PROTOCOL_VERSION` only for a change the application must not
 * pair across. It is an integer, not a version string, because the only
 * question ever asked of it is "is this at least what I need".
 */
export const WORKER_PROTOCOL_VERSION = 2;

/**
 * The capability the version above is currently *about*: every account-scoped
 * write path (bindings, contacts, LID aliases, history spool, inbound) resolves
 * its authenticated account from `socket.user.id` rather than inheriting the
 * clinic's ambient state.
 */
export const WORKER_CAPABILITIES = {
  linkedAccountIsolation: true,
} as const;

/**
 * What `/healthz` says about this build. Deliberately only a version and a
 * capability flag: liveness is unauthenticated, so nothing here may describe
 * the deployment, its tenants or its configuration.
 */
export function workerProtocolAdvertisement(): {
  workerProtocolVersion: number;
  linkedAccountIsolation: boolean;
} {
  return {
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    linkedAccountIsolation: WORKER_CAPABILITIES.linkedAccountIsolation,
  };
}
