/**
 * Eval metrics — one pure function per metric, each independently unit-testable.
 *
 * Two metrics (evidence precision, hallucination) read the repository back
 * through the Reader, so they take a `Reader` + `Repository` alongside the
 * `EvalRun`. The symbol vocabulary for both comes from the fixture's
 * `call-chain.json` (the ground truth for what symbols exist); for a real repo
 * it can be derived from the repository itself (issue #25).
 */

import type { Evidence } from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";
import type { AnswerSample, CallChainStep } from "./fixtures.js";
import type { EvalRun } from "./types.js";

// ---------------------------------------------------------------------------
// Evidence precision
// ---------------------------------------------------------------------------

export interface PrecisionFailure {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  missing: string[];
}

export interface PrecisionResult {
  supported: number;
  total: number;
  failures: PrecisionFailure[];
  precision: number;
}

/**
 * For each evidence item, check whether its (path, line range) actually
 * contains every known symbol its `reason` claims. `supported / total` is the
 * fraction whose cited range backs up the claim.
 */
export function evidencePrecision(
  run: EvalRun,
  reader: Reader,
  repo: Repository,
  knownSymbols: string[],
): PrecisionResult {
  const evidence = run.turns.flatMap((turn) => turn.evidence);
  const failures: PrecisionFailure[] = [];
  let supported = 0;
  for (const item of evidence) {
    const claimed = knownSymbols.filter((symbol) => wordIn(symbol, item.reason));
    const failure = checkEvidence(item, claimed, reader, repo);
    if (failure === null) {
      supported += 1;
    } else {
      failures.push(failure);
    }
  }
  const total = evidence.length;
  return {
    supported,
    total,
    failures,
    precision: total === 0 ? 0 : supported / total,
  };
}

/** Returns null when the item is supported, otherwise the failure record. */
function checkEvidence(
  item: Evidence,
  claimed: string[],
  reader: Reader,
  repo: Repository,
): PrecisionFailure | null {
  if (claimed.length === 0) {
    // No known symbol claimed — cannot verify, so count it as unsupported.
    return { ...item, missing: [] };
  }
  let content: string;
  try {
    content = reader.readFile(repo, item.path, item.startLine, item.endLine).content;
  } catch {
    return { ...item, missing: claimed };
  }
  const missing = claimed.filter((symbol) => !wordIn(symbol, content));
  return missing.length === 0
    ? null
    : {
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        reason: item.reason,
        missing,
      };
}

// ---------------------------------------------------------------------------
// Path accuracy
// ---------------------------------------------------------------------------

export interface PathAccuracyResult {
  expected: string[];
  actual: string[];
  matched: number;
  total: number;
  accuracy: number;
}

/** Evidence paths in appearance order, deduped (the session's call chain). */
export function orderedPaths(run: EvalRun): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const turn of run.turns) {
    for (const evidence of turn.evidence) {
      if (!seen.has(evidence.path)) {
        seen.add(evidence.path);
        paths.push(evidence.path);
      }
    }
  }
  return paths;
}

/**
 * Compare the session's call chain to the expected chain position-by-position;
 * `matched / expected.length` is the fraction of steps in the right place.
 */
export function pathAccuracy(run: EvalRun, expected: CallChainStep[]): PathAccuracyResult {
  const actual = orderedPaths(run);
  const expectedPaths = expected.map((step) => step.path);
  let matched = 0;
  const length = Math.min(actual.length, expectedPaths.length);
  for (let i = 0; i < length; i++) {
    if (actual[i] === expectedPaths[i]) matched += 1;
  }
  const total = expectedPaths.length;
  return {
    expected: expectedPaths,
    actual,
    matched,
    total,
    accuracy: total === 0 ? 0 : matched / total,
  };
}

// ---------------------------------------------------------------------------
// Assessment agreement
// ---------------------------------------------------------------------------

export interface AgreementDisagreement {
  question: string;
  answer: string;
  expected: string;
  actual: string;
}

export interface AssessmentAgreementResult {
  matched: number;
  agreed: number;
  total: number;
  agreement: number;
  disagreements: AgreementDisagreement[];
}

/**
 * For every sample answer actually assessed this run, compare the model's
 * assessment to the annotated `expectedAssessment`. `agreement` is the AC ratio
 * (threshold ≥ 80% per docs/mvp-spec.md §8).
 *
 * An assessment does not always sit on the same turn as the answer it judges:
 * the hypothesis → trace transition consumes the answer, and the trace turn
 * (which carries no `userAnswer`) records the assessment. Pair each assessment
 * with the most recent `userAnswer` seen up to that turn, mirroring the
 * answer→assessment flow through the state machine.
 */
export function assessmentAgreement(
  run: EvalRun,
  samples: AnswerSample[],
): AssessmentAgreementResult {
  const byAnswer = new Map(
    samples.map((sample) => [sample.userAnswer.trim(), sample]),
  );
  let matched = 0;
  let agreed = 0;
  const disagreements: AgreementDisagreement[] = [];
  let lastUserAnswer: string | undefined;
  for (const turn of run.turns) {
    if (turn.userAnswer !== undefined) lastUserAnswer = turn.userAnswer;
    if (turn.assessment === undefined || lastUserAnswer === undefined) continue;
    const sample = byAnswer.get(lastUserAnswer.trim());
    if (sample === undefined) continue;
    matched += 1;
    if (turn.assessment === sample.expectedAssessment) {
      agreed += 1;
    } else {
      disagreements.push({
        question: sample.question,
        answer: sample.userAnswer,
        expected: sample.expectedAssessment,
        actual: turn.assessment,
      });
    }
  }
  return {
    matched,
    agreed,
    total: matched,
    agreement: matched === 0 ? 0 : agreed / matched,
    disagreements,
  };
}

// ---------------------------------------------------------------------------
// Adaptation
// ---------------------------------------------------------------------------

export interface AdaptationResult {
  afterCorrect: string;
  afterIncorrect: string;
  jaccard: number;
  sameQuestion: boolean;
  adapted: boolean;
  threshold: number;
}

export const DEFAULT_ADAPTATION_THRESHOLD = 0.5;

/** The first non-empty question posed after the turn that consumed `userAnswer`. */
export function nextQuestionAfter(run: EvalRun, userAnswer: string): string | undefined {
  const index = run.turns.findIndex((turn) => turn.userAnswer === userAnswer);
  if (index === -1) return undefined;
  for (let i = index + 1; i < run.turns.length; i++) {
    const question = run.turns[i].question.trim();
    if (question !== "") return question;
  }
  return undefined;
}

/** Normalized token-set Jaccard similarity in [0, 1]. */
export function questionJaccard(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Feed the same question a correct and an incorrect answer in two runs, then
 * compare the next question each run produced. A Jaccard similarity below the
 * threshold (and not the identical sentence) means the model adapted.
 */
export function adaptation(
  afterCorrect: EvalRun,
  afterIncorrect: EvalRun,
  correctAnswer: string,
  incorrectAnswer: string,
  threshold: number = DEFAULT_ADAPTATION_THRESHOLD,
): AdaptationResult {
  const correctNext = nextQuestionAfter(afterCorrect, correctAnswer) ?? "";
  const incorrectNext = nextQuestionAfter(afterIncorrect, incorrectAnswer) ?? "";
  const jaccard = questionJaccard(correctNext, incorrectNext);
  const sameQuestion =
    correctNext !== "" &&
    tokenize(correctNext).join(" ") === tokenize(incorrectNext).join(" ");
  return {
    afterCorrect: correctNext,
    afterIncorrect: incorrectNext,
    jaccard,
    sameQuestion,
    adapted: jaccard < threshold,
    threshold,
  };
}

// ---------------------------------------------------------------------------
// Hallucination
// ---------------------------------------------------------------------------

export interface HallucinationResult {
  mentioned: string[];
  missing: string[];
  total: number;
  missingCount: number;
  ratio: number;
}

/**
 * Function/module names mentioned in the conclusion (recap + feedback) that do
 * not appear anywhere in the repository's source files. README/docs mentions do
 * not count as existence — the fixture's README deliberately advertises an
 * `exportToCsv` that the source never implements (docs/mvp-spec.md §8).
 */
export async function hallucination(
  conclusion: string,
  reader: Reader,
  repo: Repository,
  knownSymbols: string[] = [],
): Promise<HallucinationResult> {
  const mentioned = extractSymbolNames(conclusion, knownSymbols);
  const missing: string[] = [];
  for (const name of mentioned) {
    if (!(await symbolExists(reader, repo, name))) missing.push(name);
  }
  const total = mentioned.length;
  return {
    mentioned,
    missing,
    total,
    missingCount: missing.length,
    ratio: total === 0 ? 0 : missing.length / total,
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostResult {
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
}

export function sessionCost(run: EvalRun): CostResult {
  return {
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    wallClockMs: run.wallClockMs,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Candidate symbol names from prose: snake_case identifiers, or camelCase /
 * PascalCase with a hump after the first character, plus any known symbol that
 * appears whole-word. Excluding sentence-capitalised prose ("The", "And") keeps
 * the candidate set to actual code symbols.
 */
export function extractSymbolNames(text: string, knownSymbols: string[] = []): string[] {
  const codeLike = (text.match(IDENTIFIER_RE) ?? []).filter(isCodeLike);
  const known = knownSymbols.filter((symbol) => wordIn(symbol, text));
  return [...new Set([...codeLike, ...known])];
}

function isCodeLike(token: string): boolean {
  if (token.length < 3) return false;
  return token.includes("_") || /[A-Z]/.test(token.slice(1));
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_$]+/g) ?? []).filter(
    (token) => !JACCARD_STOPWORDS.has(token),
  );
}

/** Whole-word membership: `\b` boundaries so `add` does not match `added`. */
function wordIn(symbol: string, text: string): boolean {
  return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text);
}

const REGEX_SPECIALS = new Set([
  ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\",
]);

/** Escape a literal so it can be interpolated into a RegExp safely. */
function escapeRegExp(text: string): string {
  let out = "";
  for (const char of text) {
    out += REGEX_SPECIALS.has(char) ? `\\${char}` : char;
  }
  return out;
}

/** Extensions counted as source code (README/docs are excluded). */
const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

function isSourcePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return false;
  return SOURCE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

async function symbolExists(
  reader: Reader,
  repo: Repository,
  symbol: string,
): Promise<boolean> {
  const matches = await reader.search(repo, escapeRegExp(symbol));
  return matches.some((match) => isSourcePath(match.path));
}

const JACCARD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "which", "what", "who", "whom", "when",
  "where", "how", "why", "does", "do", "did", "has", "have", "had", "will",
  "would", "can", "could", "should", "not", "no", "your", "you", "we", "they",
  "he", "she", "them",
]);
