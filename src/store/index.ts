/**
 * Session Store — persistence for learning sessions and turns.
 *
 * The `SessionStore` interface is the seam that lets the JSON-file
 * implementation (issue #6) drop in without touching the Orchestrator. This
 * issue ships only the in-memory implementation.
 */

import { randomUUID } from "node:crypto";
import {
  learningSessionSchema,
  learningTurnSchema,
  type LearningSession,
  type LearningTurn,
} from "../domain/index.js";

export interface CreateSessionInput {
  repositoryId: string;
  featureId: string;
  /** Selected workspace directory (monorepo); absent for a root-scoped session. */
  workspacePath?: string;
}

/** Mutable session fields. id / repositoryId / featureId / workspacePath are immutable. */
export type SessionPatch = Partial<
  Pick<LearningSession, "phase" | "turnCount" | "status" | "usage">
>;

export interface SessionStore {
  createSession(input: CreateSessionInput): LearningSession;
  getSession(sessionId: string): LearningSession | undefined;
  updateSession(sessionId: string, patch: SessionPatch): LearningSession;
  appendTurn(turn: LearningTurn): void;
  listTurns(sessionId: string): LearningTurn[];
}

/**
 * Extension for stores that persist sessions beyond the process lifetime.
 * Adds the two queries the JSON-file implementation needs for the CLI (#7):
 * session duration (the "15-minute" measurement source) and enumeration.
 */
export interface PersistentSessionStore extends SessionStore {
  /** Milliseconds between session creation and completion (or now). */
  sessionDuration(sessionId: string): number;
  /** Every persisted session, oldest first. */
  listSessions(): LearningSession[];
}

export { JsonSessionStore, resumeSession } from "./json-store.js";
export type { ResumedSession } from "./json-store.js";

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, LearningSession>();
  private readonly turns = new Map<string, LearningTurn[]>();

  createSession(input: CreateSessionInput): LearningSession {
    const session = learningSessionSchema.parse({
      id: randomUUID(),
      repositoryId: input.repositoryId,
      featureId: input.featureId,
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
      phase: "orientation",
      turnCount: 0,
      status: "active",
    });
    this.sessions.set(session.id, session);
    this.turns.set(session.id, []);
    return session;
  }

  getSession(sessionId: string): LearningSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSession(sessionId: string, patch: SessionPatch): LearningSession {
    const current = this.requireSession(sessionId);
    const next = learningSessionSchema.parse({ ...current, ...patch });
    this.sessions.set(sessionId, next);
    return next;
  }

  appendTurn(turn: LearningTurn): void {
    const parsed = learningTurnSchema.parse(turn);
    const turns = this.turns.get(parsed.sessionId);
    if (turns === undefined) {
      throw new Error(`Unknown session: ${parsed.sessionId}`);
    }
    turns.push(parsed);
  }

  listTurns(sessionId: string): LearningTurn[] {
    const turns = this.turns.get(sessionId);
    if (turns === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return [...turns];
  }

  private requireSession(sessionId: string): LearningSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }
}
