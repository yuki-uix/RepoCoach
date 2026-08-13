/**
 * Domain model — zod schemas and inferred types.
 *
 * This module is the single source of truth for the shapes shared by the
 * Orchestrator, the Agent loop and the Session Store. Field definitions follow
 * docs/mvp-spec.md §6 and docs/architecture.md §5.
 */

import { z } from "zod";

/**
 * The learning phases. "error" is a terminal state reached when the agent
 * repeatedly fails validation (or a repository cannot be recognised); it is
 * never a value the model can output.
 */
export const phaseSchema = z.enum([
  "orientation",
  "hypothesis",
  "trace",
  "questioning",
  "feedback",
  "recap",
  "error",
]);
export type Phase = z.infer<typeof phaseSchema>;

/** The agent's judgement of a user answer. "unknown" also marks insufficient evidence. */
export const assessmentSchema = z.enum([
  "correct",
  "partial",
  "incorrect",
  "unknown",
]);
export type Assessment = z.infer<typeof assessmentSchema>;

/**
 * The agent's suggested next action. This is only a suggestion — the
 * Orchestrator arbitrates against the state machine and never lets the model
 * pick the phase (docs/architecture.md §5).
 */
export const nextActionSchema = z.enum(["ask", "show_evidence", "finish"]);
export type NextAction = z.infer<typeof nextActionSchema>;

export const evidenceSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  reason: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const repositorySchema = z.object({
  id: z.string(),
  url: z.string(),
  owner: z.string(),
  name: z.string(),
  ref: z.string(),
  language: z.enum(["typescript", "javascript"]),
  /** Set when the import narrowed a monorepo to a single package. */
  workspacePath: z.string().optional(),
});
export type Repository = z.infer<typeof repositorySchema>;

export const featureCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  entryFiles: z.array(z.string()),
  difficulty: z.enum(["intro", "intermediate", "advanced"]),
});
export type FeatureCandidate = z.infer<typeof featureCandidateSchema>;

export const sessionStatusSchema = z.enum(["active", "completed", "abandoned"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const learningSessionSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  featureId: z.string(),
  phase: phaseSchema,
  /** Number of questions asked so far (prediction + follow-ups). */
  turnCount: z.number().int().nonnegative(),
  status: sessionStatusSchema,
});
export type LearningSession = z.infer<typeof learningSessionSchema>;

export const learningTurnSchema = z.object({
  sessionId: z.string(),
  question: z.string(),
  userAnswer: z.string().optional(),
  evidence: z.array(evidenceSchema),
  assessment: assessmentSchema.optional(),
  feedback: z.string().optional(),
  /** True when the user skipped the question instead of answering. */
  skipped: z.boolean().optional(),
  /** True when the Orchestrator overruled the agent's suggested nextAction. */
  decisionOverridden: z.boolean().optional(),
});
export type LearningTurn = z.infer<typeof learningTurnSchema>;

/**
 * The structured decision the model must produce. Deliberately has no `phase`
 * field — the phase is Orchestrator context, never model output.
 */
export const agentDecisionSchema = z.object({
  question: z.string().optional(),
  evidence: z.array(evidenceSchema),
  assessment: assessmentSchema.optional(),
  feedback: z.string().optional(),
  nextAction: nextActionSchema,
});
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const tokenBudgetSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});
export type TokenBudget = z.infer<typeof tokenBudgetSchema>;
