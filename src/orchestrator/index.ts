/**
 * Learning Orchestrator — public entry point.
 *
 * Composes the pure state machine and the Orchestrator class. See
 * docs/architecture.md §3–§4.
 */

export {
  ALL_EVENTS,
  InvalidTransitionError,
  transition,
  VALID_TRANSITIONS,
} from "./state-machine.js";
export { Orchestrator } from "./orchestrator.js";

export type {
  OrchestratorEvent,
  OrchestratorEventType,
} from "./state-machine.js";
export type {
  AgentInvocation,
  AgentInvoker,
  AgentInvokerInput,
  OrchestratorOptions,
  StepResult,
} from "./orchestrator.js";
