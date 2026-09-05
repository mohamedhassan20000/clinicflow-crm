import pino from "pino";

/**
 * Nothing a dependency hands to the global `console` is ever printed.
 *
 * ## The leak this closes
 *
 * `libsignal@6.0.0` — reached through `baileys` — narrates the Signal session
 * lifecycle straight to stdout, passing the session record itself as an
 * argument. From `libsignal/src/session_record.js`:
 *
 *     closeSession(session) {
 *         if (this.isClosed(session)) {
 *             console.warn("Session already closed", session);
 *             return;
 *         }
 *         console.info("Closing session:", session);
 *         ...
 *     }
 *
 * A `SessionEntry` carries `privKey`, `rootKey`, `chainKey`, `remoteIdentityKey`
 * and `pendingPreKey`. `console.info` formats it with `util.inspect`, so the raw
 * key material lands in the platform's log stream, where it is retained,
 * indexed, and readable by anyone with log access. That is a disclosure of the
 * private half of a clinic's device identity: it is not noise, and it is not
 * something to filter downstream of the log aggregator.
 *
 * There is no option, level or logger injection point for it — libsignal writes
 * to the global console unconditionally, and Baileys' own `logger` config does
 * not reach it. The real source is the console call, and this module is what
 * stands in front of it. Nine other call sites in the same package pass session
 * records, prekey bundles or error stacks the same way (`Opening session:`,
 * `Removing old closed session:`, `Session error:` …), so the guard is written
 * against the *channel*, not against the one line that was noticed.
 *
 * ## Why arguments are dropped rather than redacted
 *
 * A redacting formatter has to be right about every shape it is handed, forever,
 * including shapes a future dependency version invents. This drops every
 * argument unread and emits only a fixed event name chosen by matching the
 * literal prefix of the first argument. The set of strings this module can
 * possibly print is therefore the constant table below — which can be read in
 * full, and contains no interpolation. A line nobody has classified prints its
 * level and an argument count and nothing else.
 *
 * The guard is not a substitute for the worker's own redaction discipline; it is
 * the backstop for code the worker does not own.
 */

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({
  component: "console-guard",
});

/** Every console method that renders its arguments somewhere a human can read. */
const GUARDED_METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "dirxml",
  "table",
  "group",
  "groupCollapsed",
] as const;

export type GuardedLevel = "debug" | "warn";

/** What the guard is willing to say about a console call. Never the arguments. */
export type GuardedConsoleRecord = {
  level: GuardedLevel;
  /** A fixed identifier from the table below, or `unclassified_console_line`. */
  event: string;
  /** How many arguments were dropped without being read or formatted. */
  suppressedArgs: number;
};

export type ConsoleSink = (record: GuardedConsoleRecord) => void;

/**
 * The console lines the worker's dependencies are known to emit.
 *
 * Matched on the *prefix* of the first argument, because several of these are
 * built by concatenation (`"Session error:" + e`) and the tail is exactly the
 * part that must not be looked at. Order matters only in that the first match
 * wins; the prefixes are disjoint today.
 *
 * Every entry is `libsignal@6.0.0` unless marked otherwise.
 */
const KNOWN_LINES: ReadonlyArray<{ prefix: string; event: string; level: GuardedLevel }> = [
  // session_record.js — each of these passes a SessionEntry as an argument.
  { prefix: "Closing session:", event: "signal_session_closed", level: "debug" },
  { prefix: "Session already closed", event: "signal_session_already_closed", level: "debug" },
  { prefix: "Opening session:", event: "signal_session_opened", level: "debug" },
  { prefix: "Session already open", event: "signal_session_already_open", level: "debug" },
  { prefix: "Removing old closed session:", event: "signal_session_evicted", level: "debug" },
  { prefix: "Migrating session to:", event: "signal_session_migrated", level: "debug" },
  {
    prefix: "V1 session storage migration error",
    event: "signal_session_migration_failed",
    level: "warn",
  },
  // session_builder.js
  {
    prefix: "Closing open session in favor of incoming prekey bundle",
    event: "signal_session_replaced_by_prekey",
    level: "debug",
  },
  {
    prefix: "Closing stale open session",
    event: "signal_stale_session_closed",
    level: "debug",
  },
  // session_cipher.js — the decryption failure that produces a retry receipt.
  {
    prefix: "Failed to decrypt message with any known session",
    event: "signal_decrypt_failed",
    level: "warn",
  },
  { prefix: "Session error:", event: "signal_session_error", level: "warn" },
  {
    prefix: "Decrypted message with closed session",
    event: "signal_decrypt_on_closed_session",
    level: "warn",
  },
  // curve.js
  {
    prefix: "WARNING: Expected pubkey of length 33",
    event: "signal_unexpected_pubkey_length",
    level: "warn",
  },
  // queue_job.js
  { prefix: "Unhandled bucket type", event: "signal_unhandled_bucket_type", level: "warn" },
  // baileys@6.7.24, Socket/messages-send.js
  {
    prefix: "cachedGroupMetadata in sendMessage are deprecated",
    event: "baileys_deprecated_send_option",
    level: "debug",
  },
];

/** The event name for a console line no version of this table has seen. */
export const UNCLASSIFIED_EVENT = "unclassified_console_line";

/**
 * Which fixed event a console call is, decided from the literal prefix of its
 * first argument and nothing else.
 *
 * A non-string first argument — `console.info(sessionEntry)` — is unclassified
 * by construction: the guard will not stringify an object in order to decide
 * what to call it.
 */
export function classifyConsoleLine(first: unknown): { event: string; level: GuardedLevel } {
  if (typeof first === "string") {
    for (const line of KNOWN_LINES) {
      if (first.startsWith(line.prefix)) return { event: line.event, level: line.level };
    }
  }
  return { event: UNCLASSIFIED_EVENT, level: "debug" };
}

/**
 * Replaces the console's printing methods for the life of the process.
 *
 * Call it before anything can reach WhatsApp — the leak happens the first time a
 * Signal session is closed, which is during ordinary message traffic, not at
 * boot. Returns an uninstall function so a test can restore the real console;
 * production never calls it.
 *
 * `sink` exists so the regression suite can observe exactly what the guard would
 * have emitted without racing pino's own output stream. Production leaves it
 * unset and the records go to the worker's structured log at their mapped level.
 */
export function installConsoleGuard(
  options: { sink?: ConsoleSink; target?: Partial<Console> } = {},
): () => void {
  const target = (options.target ?? console) as Record<string, unknown>;
  const sink =
    options.sink ??
    ((record: GuardedConsoleRecord) => {
      const line = { event: record.event, suppressedArgs: record.suppressedArgs };
      if (record.level === "warn") logger.warn(line, "suppressed console output");
      else logger.debug(line, "suppressed console output");
    });

  const originals = new Map<string, unknown>();
  for (const method of GUARDED_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    target[method] = (...args: unknown[]) => {
      // `args[0]` is read only by `classifyConsoleLine`, which touches it only
      // when it is a string and only via `startsWith`. Nothing else in this
      // function reads an argument's value.
      const { event, level } = classifyConsoleLine(args[0]);
      sink({ level, event, suppressedArgs: args.length });
    };
  }

  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}
