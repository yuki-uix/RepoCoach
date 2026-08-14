/**
 * JSON Session Store — file-backed persistence for learning sessions and turns.
 *
 * Each session lives in its own file `<dataDir>/sessions/<id>.json` holding
 * `{ session, turns }`. Writes are atomic (write a `.tmp` file, then rename)
 * so an interrupted write can never leave a half-written JSON file behind.
 * Reads re-validate through the same zod schemas as the in-memory store, so a
 * corrupted or tampered file fails loudly with its path (never its contents).
 *
 * Implements the same `SessionStore` seam as `InMemorySessionStore` (issue #6):
 * the Orchestrator cannot tell the two apart.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  learningSessionSchema,
  learningTurnSchema,
  type LearningSession,
  type LearningTurn,
} from "../domain/index.js";
import type {
  CreateSessionInput,
  PersistentSessionStore,
  SessionPatch,
  SessionStore,
} from "./index.js";

/** The on-disk shape of one session file: the session plus its turns. */
const sessionFileSchema = z.object({
  session: learningSessionSchema,
  turns: z.array(learningTurnSchema),
});
type SessionFile = z.infer<typeof sessionFileSchema>;

const JSON_EXTENSION = ".json";

/**
 * Session ids are written into file paths, so they must stay a single, safe
 * filename segment. `randomUUID()` produces 36 hex-and-dash characters, which
 * this pattern admits while rejecting traversal (`../`) and encoded sequences
 * (`%2e%2e%2f`). The containment check in `filePath` is the second gate.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Reject any session id that could reach outside the sessions directory. */
function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

export class JsonSessionStore implements PersistentSessionStore {
  /** Root directory under which per-session files are written. */
  readonly dataDir: string;
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = join(dataDir, "sessions");
  }

  createSession(input: CreateSessionInput): LearningSession {
    const now = new Date().toISOString();
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
      createdAt: now,
      updatedAt: now,
    });
    this.writeFile(session.id, { session, turns: [] });
    return session;
  }

  getSession(sessionId: string): LearningSession | undefined {
    assertSafeSessionId(sessionId);
    return this.readFile(sessionId)?.session;
  }

  updateSession(sessionId: string, patch: SessionPatch): LearningSession {
    assertSafeSessionId(sessionId);
    const file = this.requireFile(sessionId);
    const now = new Date().toISOString();
    const next = learningSessionSchema.parse({
      ...file.session,
      ...patch,
      updatedAt: now,
      completedAt: this.resolveCompletedAt(file.session, patch, now),
    });
    this.writeFile(sessionId, { session: next, turns: file.turns });
    return next;
  }

  appendTurn(turn: LearningTurn): void {
    const parsed = learningTurnSchema.parse(turn);
    assertSafeSessionId(parsed.sessionId);
    const file = this.requireFile(parsed.sessionId);
    this.writeFile(parsed.sessionId, {
      session: { ...file.session, updatedAt: new Date().toISOString() },
      turns: [...file.turns, parsed],
    });
  }

  listTurns(sessionId: string): LearningTurn[] {
    assertSafeSessionId(sessionId);
    return [...this.requireFile(sessionId).turns];
  }

  sessionDuration(sessionId: string): number {
    assertSafeSessionId(sessionId);
    const session = this.requireFile(sessionId).session;
    const start = Date.parse(session.createdAt ?? new Date().toISOString());
    const end = Date.parse(session.completedAt ?? new Date().toISOString());
    return end - start;
  }

  listSessions(): LearningSession[] {
    mkdirSync(this.sessionsDir, { recursive: true });
    const sessions: LearningSession[] = [];
    for (const entry of readdirSync(this.sessionsDir)) {
      if (!entry.endsWith(JSON_EXTENSION)) {
        continue;
      }
      const sessionId = entry.slice(0, -JSON_EXTENSION.length);
      const session = this.readFile(sessionId)?.session;
      if (session !== undefined) {
        sessions.push(session);
      }
    }
    sessions.sort(
      (a, b) =>
        Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
    );
    return sessions;
  }

  /** First terminal transition stamps `completedAt`; later updates keep it. */
  private resolveCompletedAt(
    current: LearningSession,
    patch: SessionPatch,
    now: string,
  ): string | undefined {
    if (patch.phase === "recap" || patch.phase === "error") {
      return current.completedAt ?? now;
    }
    return current.completedAt;
  }

  private requireFile(sessionId: string): SessionFile {
    const file = this.readFile(sessionId);
    if (file === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return file;
  }

  /** Write atomically: tmp file first, then rename over the destination. */
  private writeFile(sessionId: string, data: SessionFile): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    const tmpPath = join(this.sessionsDir, `${sessionId}.json.tmp`);
    const finalPath = this.filePath(sessionId);
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, finalPath);
  }

  /**
   * Read and validate one session file. A missing file is `undefined`; a
   * corrupt one throws an error naming the path (never the file contents).
   */
  private readFile(sessionId: string): SessionFile | undefined {
    const path = this.filePath(sessionId);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupted session file (invalid JSON): ${path}`);
    }
    const parsed = sessionFileSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Corrupted session file (schema mismatch): ${path}`);
    }
    return parsed.data;
  }

  private filePath(sessionId: string): string {
    const path = join(this.sessionsDir, `${sessionId}.json`);
    const root = resolve(this.sessionsDir) + sep;
    if (!resolve(path).startsWith(root)) {
      throw new Error(`Session id escapes the sessions directory: ${sessionId}`);
    }
    return path;
  }
}

/** Data needed to reconstruct an `Orchestrator` for a previously-started session. */
export interface ResumedSession {
  sessionId: string;
  /**
   * Learning goal for the Orchestrator. The session only persists `featureId`
   * (see `LearningSession`), so resume falls back to it until a richer feature
   * lookup exists.
   */
  featureGoal: string;
  session: LearningSession;
}

/**
 * Validate that `sessionId` refers to a resumable session and return the data
 * needed to construct an `Orchestrator` for it. Only `active` sessions that
 * have not yet reached a terminal phase can be resumed.
 */
export function resumeSession(
  store: SessionStore,
  sessionId: string,
): ResumedSession {
  const session = store.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  if (session.status !== "active") {
    throw new Error(
      `Cannot resume session "${sessionId}": status is "${session.status}", expected "active"`,
    );
  }
  if (session.phase === "recap" || session.phase === "error") {
    throw new Error(
      `Cannot resume session "${sessionId}": already in terminal phase "${session.phase}"`,
    );
  }
  return {
    sessionId: session.id,
    featureGoal: session.featureId,
    session,
  };
}
