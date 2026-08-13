/**
 * Evidence module — constructive grounding and the evidence store.
 *
 * `ToolReturnLedger` records what the read/search tools actually returned this
 * turn; `GroundingEvidenceValidator` accepts only claims grounded in that
 * record and saves them to the `EvidenceStore`, which recap can use to jump
 * back to the source. See docs/architecture.md §1, §3.
 */

export { ToolReturnLedger } from "./ledger.js";
export { GroundingEvidenceValidator } from "./grounding.js";
export type { GroundingValidatorOptions } from "./grounding.js";
export { InMemoryEvidenceStore } from "./store.js";
export type {
  EvidenceStore,
  SourceContext,
  StoredEvidence,
} from "./store.js";
