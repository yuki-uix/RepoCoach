/**
 * Injectable logger seam for the agent module.
 *
 * Every log line produced inside src/agent/ flows through this interface so
 * callers (and tests) can capture output and assert secrets never leak. The
 * API key must never be passed to any method here — it is not part of the
 * logger contract.
 */

export interface AgentLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: AgentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
