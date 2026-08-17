/**
 * Constructive grounding validator — the EvidenceValidator implementation that
 * replaces `acceptAllEvidence` (issue #5).
 *
 * A claim passes only when its (path, line range) was actually returned this
 * turn by repo_read_file / repo_search; passing claims are saved to the
 * Evidence Store. Rejected claims return a corrective message the model can act
 * on: read the range first, then cite it. See docs/architecture.md §1, §3.
 */

import type { EvidenceValidator } from "../agent/tools.js";
import type { Evidence } from "../domain/index.js";
import type { ToolReturnLedger } from "./ledger.js";
import type { EvidenceStore } from "./store.js";

export interface GroundingValidatorOptions {
  ledger: ToolReturnLedger;
  store: EvidenceStore;
  sessionId: string;
}

export class GroundingEvidenceValidator implements EvidenceValidator {
  private turnIndex = 0;

  constructor(private readonly options: GroundingValidatorOptions) {}

  /**
   * Advance the turn association. The loop calls this at the start of each
   * turn (via the optional EvidenceValidator hook) so saved evidence is tagged
   * with the right turn index.
   */
  setTurnIndex(turnIndex: number): void {
    this.turnIndex = turnIndex;
  }

  validate(evidence: Evidence): { ok: true } | { ok: false; reason: string } {
    if (!this.options.ledger.isGrounded(evidence)) {
      return {
        ok: false,
        reason:
          `${evidence.path} lines ${evidence.startLine}-${evidence.endLine} were not ` +
          `returned this turn by repo_read_file or repo_search. Read that range first, ` +
          `then cite only the lines that were actually returned.`,
      };
    }
    this.options.store.save(this.options.sessionId, this.turnIndex, evidence);
    // Keep the accepted range citable for the rest of the turn even after the
    // same-turn compression window (issue #36) revokes the round that produced
    // it: the claim was checked while the model could see the content, and
    // repeating it in `submit_decision` refers to that accepted claim rather
    // than making a new one. Without this the loop would reject the model's own
    // saved evidence and fail the turn.
    this.options.ledger.recordValidated(
      evidence.path,
      evidence.startLine,
      evidence.endLine,
    );
    return { ok: true };
  }
}
