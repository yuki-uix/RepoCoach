/**
 * Injected message kinds — the single source of truth for the content kinds the
 * agent loop pushes into `messages` (issue #31).
 *
 * The loop (and its builders, entry-outline.ts and read-cache.ts) inject four
 * content kinds: repo tool results, the cross-turn carried block, the first-turn
 * entry outline, and the turn-history summary. Each kind has a data-guard
 * wrapper (REPO_DATA markers for tool results, UNTRUSTED_DATA markers for the
 * model/repo-sourced text blocks) and a terminal byte cap on the *wrapped*
 * message. This table records, per kind, its stable id, the marker pair that
 * proves it was wrapped, and its cap.
 *
 * The assembly code reads its `kind` header string and cap from here via
 * `injectedMessageKind` (which throws on an unknown id) instead of re-hardcoding
 * them, so a new injected message kind MUST be added to this table for the loop
 * to even load. The enumerated coverage test
 * (test/coverage/message-injection-paths.test.ts) iterates this table, so a new
 * kind is exercised automatically instead of silently going untested — the
 * hand-written-list defect issue #31 called out.
 */

import {
  REPO_DATA_END,
  REPO_DATA_START,
  UNTRUSTED_DATA_END,
  UNTRUSTED_DATA_START,
} from "./data-guard.js";
import {
  MAX_CARRIED_CONTEXT_BYTES,
  MAX_ENTRY_OUTLINE_BYTES,
  MAX_HISTORY_SUMMARY_BYTES,
  MAX_TOOL_RESULT_BYTES,
} from "./limits.js";

/** The data-guard wrapper a message kind carries. */
export type InjectedWrapper = "repo_data" | "untrusted_data";

export interface InjectedMessageKind {
  /**
   * Stable id used as the test key; for untrusted blocks it is also the
   * `kind` header value written by `wrapUntrustedContext`.
   */
  kind: string;
  /** Human-readable label for test names and failure messages. */
  name: string;
  /** Which data-guard wrapper the wrapped message carries. */
  wrapper: InjectedWrapper;
  /** The wrapper's opening marker the wrapped message must carry. */
  startMarker: string;
  /** The wrapper's closing marker the wrapped message must carry. */
  endMarker: string;
  /** Terminal byte cap on the *wrapped* message. */
  cap: number;
}

/**
 * Every content kind the loop injects into `messages`, in assembly order. The
 * enumerated coverage test iterates this list; adding a kind here without a test
 * producer (or removing one the loop still uses) fails the suite's guards.
 */
export const INJECTED_MESSAGE_KINDS: readonly InjectedMessageKind[] = [
  {
    kind: "repo_tool_result",
    name: "repo tool result",
    wrapper: "repo_data",
    startMarker: REPO_DATA_START,
    endMarker: REPO_DATA_END,
    cap: MAX_TOOL_RESULT_BYTES,
  },
  {
    kind: "already_read",
    name: "cross-turn carried block",
    wrapper: "untrusted_data",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_CARRIED_CONTEXT_BYTES,
  },
  {
    kind: "entry_outline",
    name: "first-turn entry outline",
    wrapper: "untrusted_data",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_ENTRY_OUTLINE_BYTES,
  },
  {
    kind: "turn_history",
    name: "turn-history summary",
    wrapper: "untrusted_data",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_HISTORY_SUMMARY_BYTES,
  },
];

/** Look up a registered kind by id, throwing if the id is not registered. */
export function injectedMessageKind(kind: string): InjectedMessageKind {
  const found = INJECTED_MESSAGE_KINDS.find((k) => k.kind === kind);
  if (found === undefined) {
    throw new Error(`Unknown injected message kind: ${kind}`);
  }
  return found;
}
