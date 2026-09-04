import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * P15 — Pause AI must not consume the per-conversation AI exception.
 *
 * ## What broke, and why a state test alone would not have caught it
 *
 * The first draft of P15 had `set_conversation_ai_pause` write
 * `ai_enabled_override = false` on pause, and the resume branch withdraw it
 * with `case when ai_enabled_override is false then null else ... end`.
 *
 * `false` is `false`. Once the pause had written it, nothing in the row could
 * tell that value apart from an exclusion the clinic had set deliberately, so
 * the resume guessed — and it guessed "mine". A clinic that had excluded a
 * thread from the assistant lost that decision the moment any receptionist
 * finished a takeover on it, silently, with the assistant resuming on a thread
 * it had been told to stay out of.
 *
 * The fix is structural rather than behavioural: the pause control writes the
 * three pause columns and nothing else, and the two facts are combined at read
 * time by `resolveEffectiveConversationAi`. So the property under test here is
 * structural too — *which columns each branch writes* — and that is what these
 * tests assert, by parsing the shipped function body rather than by matching
 * substrings that a reformat would silently break.
 *
 * Asserting the column set is strictly stronger than asserting the six
 * transitions below, because it is the reason they hold: a branch that writes
 * no override cannot change one, whatever the override happened to be. The
 * transitions are then derived from the parsed SQL rather than hand-copied, so
 * they cannot drift from what the migration actually does.
 *
 * The end-to-end proof against a live database belongs in
 * `tests/unit/integration/` and needs the local stack with this migration
 * applied; it is complementary to, not a replacement for, this.
 */

const MIGRATION_PATH =
  "supabase/migrations/20260908120000_p15_inbox_status_and_ai_control.sql";
const sql = readFileSync(MIGRATION_PATH, "utf8");

/** Strip `--` line comments so a column named in prose is never miscounted. */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, "");
}

/** The body of one `create or replace function public.<name>`, up to its `$$;`. */
function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined in ${MIGRATION_PATH}`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} has a terminated body`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/**
 * The column names assigned by the `update public.<table>` statement beginning
 * at `fromIndex` — i.e. everything between `set` and the statement's `where`.
 */
function updatedColumns(body: string, fromIndex: number): string[] {
  const setStart = body.indexOf(" set ", fromIndex);
  const whereStart = body.indexOf(" where ", setStart);
  expect(setStart).toBeGreaterThan(-1);
  expect(whereStart).toBeGreaterThan(setStart);
  const clause = stripComments(body.slice(setStart + 5, whereStart));
  // Assignments are separated at the top level by commas; a column name is the
  // identifier immediately preceding its `=`.
  return clause
    .split(",")
    .map((assignment) => assignment.trim())
    .filter(Boolean)
    .map((assignment) => assignment.split("=")[0]!.trim())
    .filter((column) => /^[a-z_][a-z0-9_]*$/.test(column));
}

const pauseBody = stripComments(functionBody("set_conversation_ai_pause"));

/** The two `update public.conversations` statements, in source order. */
const pauseUpdateIndexes = [...pauseBody.matchAll(/update public\.conversations/g)].map(
  (match) => match.index!,
);

const PAUSE_COLUMNS = ["ai_paused_at", "ai_paused_by", "ai_pause_reason"];

describe("P15 set_conversation_ai_pause — the exception survives a takeover", () => {
  it("writes exactly the three pause columns on pause, and never the override", () => {
    expect(pauseUpdateIndexes).toHaveLength(2);
    const columns = updatedColumns(pauseBody, pauseUpdateIndexes[0]!);
    expect(columns.sort()).toEqual([...PAUSE_COLUMNS].sort());
    expect(columns).not.toContain("ai_enabled_override");
  });

  it("writes exactly the three pause columns on resume, and never the override", () => {
    const columns = updatedColumns(pauseBody, pauseUpdateIndexes[1]!);
    expect(columns.sort()).toEqual([...PAUSE_COLUMNS].sort());
    expect(columns).not.toContain("ai_enabled_override");
  });

  it("never mentions the override anywhere in the pause control", () => {
    // The regression in prose form: no branch, no CASE, no guard, nothing. If
    // this control needs to reason about the exception at all, the design has
    // regressed to the version that could not tell whose `false` it was.
    expect(pauseBody).not.toContain("ai_enabled_override");
  });

  it("returns early on a repeated call in either direction, writing nothing", () => {
    // Idempotency for scenarios 4 and 5: the no-op guard sits above both
    // UPDATEs, so a second Pause or a second Resume touches no column at all.
    const guard = pauseBody.indexOf("if p_paused = (v_conversation.ai_paused_at is not null) then");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(pauseUpdateIndexes[0]!);
    const noop = pauseBody.slice(guard, pauseUpdateIndexes[0]!);
    expect(noop).toContain("changed := false");
    expect(noop).not.toContain("update public.conversations");
  });

  it("still decides the transition under the row lock it has always held", () => {
    // The concurrency behaviour P8 shipped, unchanged by this fix.
    expect(pauseBody).toContain("for update");
    expect(pauseBody.indexOf("for update")).toBeLessThan(pauseUpdateIndexes[0]!);
  });
});

/**
 * The six required Pause/Resume scenarios.
 *
 * `applyPause` is not a hand-written model of the function: the set of columns
 * it changes is the set parsed out of the migration above. So these cases
 * assert the state table *and* stay tied to the shipped SQL — if a future edit
 * reintroduces an override write, `writesOverride` flips and every preserving
 * case below fails.
 */
type ConversationState = {
  aiPausedAt: string | null;
  aiEnabledOverride: boolean | null;
};

const pauseWritesOverride = updatedColumns(pauseBody, pauseUpdateIndexes[0]!).includes(
  "ai_enabled_override",
);
const resumeWritesOverride = updatedColumns(pauseBody, pauseUpdateIndexes[1]!).includes(
  "ai_enabled_override",
);

function applyPause(state: ConversationState, paused: boolean): ConversationState {
  // The no-op guard: a repeated call in the same direction changes nothing.
  if (paused === (state.aiPausedAt !== null)) return state;
  if (paused) {
    return {
      aiPausedAt: "2026-09-03T10:00:00Z",
      aiEnabledOverride: pauseWritesOverride ? false : state.aiEnabledOverride,
    };
  }
  return {
    aiPausedAt: null,
    aiEnabledOverride: resumeWritesOverride
      ? state.aiEnabledOverride === false
        ? null
        : state.aiEnabledOverride
      : state.aiEnabledOverride,
  };
}

describe("P15 Pause/Resume state table", () => {
  const cases: Array<{ name: string; override: boolean | null }> = [
    { name: "1. override NULL survives a takeover", override: null },
    { name: "2. override FALSE survives a takeover", override: false },
    { name: "3. override TRUE survives a takeover", override: true },
  ];

  for (const { name, override } of cases) {
    it(name, () => {
      const before: ConversationState = { aiPausedAt: null, aiEnabledOverride: override };
      const paused = applyPause(before, true);
      expect(paused.aiPausedAt).not.toBeNull();
      // The exception is untouched *while* paused, too — a takeover is not an
      // exclusion, and the Inbox exception control must not read as though the
      // clinic had made a standing decision it never made.
      expect(paused.aiEnabledOverride).toBe(override);

      const resumed = applyPause(paused, false);
      expect(resumed.aiPausedAt).toBeNull();
      expect(resumed.aiEnabledOverride).toBe(override);
    });
  }

  it("4. repeated Pause is idempotent", () => {
    const before: ConversationState = { aiPausedAt: null, aiEnabledOverride: false };
    const once = applyPause(before, true);
    const twice = applyPause(once, true);
    expect(twice).toEqual(once);
    expect(twice.aiEnabledOverride).toBe(false);
  });

  it("5. repeated Resume is idempotent", () => {
    const paused = applyPause({ aiPausedAt: null, aiEnabledOverride: true }, true);
    const once = applyPause(paused, false);
    const twice = applyPause(once, false);
    expect(twice).toEqual(once);
    expect(twice.aiPausedAt).toBeNull();
    expect(twice.aiEnabledOverride).toBe(true);
  });

  it("6. an exception changed mid-takeover takes effect and survives the resume", () => {
    // The case a snapshot column would have got wrong: staff exclude the thread
    // *while* holding it, and the resume must not restore a stale "before"
    // value over the newer decision.
    const paused = applyPause({ aiPausedAt: null, aiEnabledOverride: null }, true);
    const retargeted: ConversationState = { ...paused, aiEnabledOverride: false };
    const resumed = applyPause(retargeted, false);
    expect(resumed.aiPausedAt).toBeNull();
    expect(resumed.aiEnabledOverride).toBe(false);
  });
});

describe("P15 close_conversation_episode — repeated closes do not rewrite the thread", () => {
  const closeBody = stripComments(functionBody("close_conversation_episode"));

  it("7. clears the episode pointer only when one is actually set", () => {
    // Without this predicate every no-op close rewrites the conversation row and
    // fires trg_conversations_updated_at, so a thread nobody has touched keeps
    // reporting a fresh updated_at. P11T had the guard; P15 must not drop it.
    const updateIndex = closeBody.indexOf("update public.conversations");
    expect(updateIndex).toBeGreaterThan(-1);
    const statement = closeBody.slice(updateIndex, closeBody.indexOf(";", updateIndex));
    expect(statement).toContain("current_episode_id is not null");
    expect(updatedColumns(closeBody, updateIndex)).toEqual(["current_episode_id"]);
  });

  it("keeps the episode close itself scoped to the active episode", () => {
    expect(closeBody).toContain("and e.status = 'active'");
  });
});

describe("P15 migration remains non-destructive", () => {
  const lower = sql.toLowerCase();

  it("adds no data-rewriting statement", () => {
    expect(lower).not.toMatch(/\bdelete\s+from\b/);
    expect(lower).not.toMatch(/\btruncate\b/);
    expect(lower).not.toMatch(/\bdrop\s+table\b/);
    expect(lower).not.toMatch(/\bdrop\s+column\b/);
  });

  it("adds the override as a nullable column, so every existing row follows the clinic", () => {
    expect(lower).toContain("add column if not exists ai_enabled_override boolean");
    // No NOT NULL and no DEFAULT: NULL is "follow the clinic", which is what
    // every row that exists before this migration already means.
    expect(lower).not.toMatch(/ai_enabled_override boolean[^;]*\bdefault\b/);
    expect(lower).not.toMatch(/ai_enabled_override boolean[^;]*\bnot null\b/);
  });
});
