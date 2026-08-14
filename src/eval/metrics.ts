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
  /** Judgeable evidence items (supported + failed). */
  total: number;
  /** Evidence items whose reason claimed no symbol — excluded from `total`. */
  notApplicable: number;
  failures: PrecisionFailure[];
  /** Not-applicable items, kept verbatim for human review. */
  notApplicableDetails: PrecisionFailure[];
  precision: number;
}

/**
 * For each evidence item, check whether its (path, line range) backs up the
 * symbols its `reason` mentions. A claim is supported when at least one
 * mentioned symbol appears in the cited range; an item whose reason mentions no
 * symbol is not judgeable and is reported separately (excluded from the ratio).
 */
export function evidencePrecision(
  run: EvalRun,
  reader: Reader,
  repo: Repository,
  knownSymbols: string[],
): PrecisionResult {
  const evidence = run.turns.flatMap((turn) => turn.evidence);
  const failures: PrecisionFailure[] = [];
  const notApplicableDetails: PrecisionFailure[] = [];
  let supported = 0;
  for (const item of evidence) {
    const claimed = extractSymbolNames(item.reason, knownSymbols);
    if (claimed.length === 0) {
      notApplicableDetails.push({ ...item, missing: [] });
      continue;
    }
    const failure = checkEvidence(item, claimed, reader, repo);
    if (failure === null) {
      supported += 1;
    } else {
      failures.push(failure);
    }
  }
  const total = evidence.length - notApplicableDetails.length;
  return {
    supported,
    total,
    notApplicable: notApplicableDetails.length,
    failures,
    notApplicableDetails,
    precision: total === 0 ? 0 : supported / total,
  };
}

/** Returns null when at least one claimed symbol is supported, else the failure. */
function checkEvidence(
  item: Evidence,
  claimed: string[],
  reader: Reader,
  repo: Repository,
): PrecisionFailure | null {
  let content: string;
  try {
    content = reader.readFile(repo, item.path, item.startLine, item.endLine).content;
  } catch {
    return { ...item, missing: claimed };
  }
  const supported = claimed.some((symbol) => wordIn(symbol, content));
  return supported
    ? null
    : {
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        reason: item.reason,
        missing: claimed,
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
 * Compare the session's call chain to the expected chain as a subsequence: the
 * expected path sequence must appear in order within the actual evidence paths,
 * allowing unrelated files (README, type definitions, …) to interleave.
 * `matched / expected.length` is the fraction of steps appearing in order.
 */
export function pathAccuracy(run: EvalRun, expected: CallChainStep[]): PathAccuracyResult {
  const actual = orderedPaths(run);
  const expectedPaths = expected.map((step) => step.path);
  let matched = 0;
  let cursor = 0;
  for (const expectedPath of expectedPaths) {
    const index = actual.indexOf(expectedPath, cursor);
    if (index === -1) break;
    matched += 1;
    cursor = index + 1;
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

/** Annotation labels from `answer-samples.json` (rows of the confusion matrix). */
export const ASSESSMENT_LABELS = ["correct", "partial", "incorrect"] as const;
export type AssessmentLabel = (typeof ASSESSMENT_LABELS)[number];

/** Model assessment labels (columns of the confusion matrix). */
export const MODEL_ASSESSMENT_LABELS = ["correct", "partial", "incorrect", "unknown"] as const;
export type ModelAssessmentLabel = (typeof MODEL_ASSESSMENT_LABELS)[number];

/** Annotation (row) × model assessment (column) counts. */
export type ConfusionMatrix = Record<string, Record<string, number>>;

export interface AssessmentAgreementResult {
  matched: number;
  agreed: number;
  total: number;
  agreement: number;
  disagreements: AgreementDisagreement[];
  /** Annotation (row) × model assessment (column) counts. */
  confusion: ConfusionMatrix;
}

/**
 * For every sample answer actually assessed this run, compare the model's
 * assessment to the annotated `expectedAssessment`. `agreement` is the AC ratio
 * (threshold ≥ 80% per docs/mvp-spec.md §8). The `confusion` matrix shows the
 * full annotation × model distribution so a systematic bias (e.g. the model
 * grading more conservatively than the annotations) is visible at a glance.
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
  const confusion = emptyConfusion();
  let lastUserAnswer: string | undefined;
  for (const turn of run.turns) {
    if (turn.userAnswer !== undefined) lastUserAnswer = turn.userAnswer;
    if (turn.assessment === undefined || lastUserAnswer === undefined) continue;
    const sample = byAnswer.get(lastUserAnswer.trim());
    if (sample === undefined) continue;
    matched += 1;
    confusion[sample.expectedAssessment][turn.assessment] += 1;
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
    confusion,
  };
}

/** A confusion matrix pre-filled with zeros for every annotation × model cell. */
function emptyConfusion(): ConfusionMatrix {
  const table: ConfusionMatrix = {};
  for (const label of ASSESSMENT_LABELS) {
    table[label] = {};
    for (const modelLabel of MODEL_ASSESSMENT_LABELS) {
      table[label][modelLabel] = 0;
    }
  }
  return table;
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

/** A source-file path token like `src/types.ts` or `format.ts`. */
const FILE_NAME_RE = /([\w$./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g;

/** True for symbols that look like a file path (basename ends in a source ext). */
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Candidate symbol names from prose, restricted to tokens that carry a code
 * context rather than prose emphasis:
 *   - backtick-wrapped identifiers (`exportToCsv`)
 *   - call form `name(`
 *   - file paths like `src/types.ts`
 *   - camelCase / PascalCase / snake_case identifiers
 * plus any known symbol that appears whole-word (so lowercase known symbols
 * like `validate` / `add` are still recognised).
 *
 * All-caps prose words (PARSE, VALIDATE, AFTER) are excluded from the code
 * signals; CONST_NAME-shaped all-caps tokens (with an underscore) are kept and
 * left to the downstream existence check.
 */
export function extractSymbolNames(text: string, knownSymbols: string[] = []): string[] {
  const candidates = new Set<string>();
  const addCodeSignal = (token: string) => {
    if (!isAllCapsProse(token)) candidates.add(token);
  };

  // Backtick-wrapped identifiers.
  for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
    addCodeSignal(match[1]);
  }

  // Call form `name(`.
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)(?=\()/g)) {
    addCodeSignal(match[1]);
  }

  // File paths like `src/types.ts`.
  for (const match of text.matchAll(FILE_NAME_RE)) {
    addCodeSignal(match[1]);
  }

  // camelCase / PascalCase / snake_case identifiers.
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    const token = match[0];
    if (isCodeLike(token)) addCodeSignal(token);
  }

  // Known symbols are authoritative even when lowercase ("validate", "add").
  for (const symbol of knownSymbols) {
    if (wordIn(symbol, text)) candidates.add(symbol);
  }

  return [...candidates];
}

/** A code-shaped identifier: snake_case, or camelCase/PascalCase with a hump. */
function isCodeLike(token: string): boolean {
  if (token.length < 3) return false;
  return token.includes("_") || /[A-Z]/.test(token.slice(1));
}

/** All-caps prose emphasis (AFTER, PARSE) — not a symbol unless CONST_NAME-shaped. */
function isAllCapsProse(token: string): boolean {
  return token.length >= 2 && token === token.toUpperCase() && !token.includes("_");
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
  if (SOURCE_FILE_RE.test(symbol)) {
    return fileExists(reader, repo, symbol);
  }
  const matches = await reader.search(repo, escapeRegExp(symbol));
  return matches.some((match) => isSourcePath(match.path));
}

/** True when a filename-shaped symbol names a file present in the repo tree. */
function fileExists(reader: Reader, repo: Repository, path: string): boolean {
  const normalized = path.replace(/^\.\/+/, "").split("\\").join("/");
  return reader
    .getTree(repo)
    .some((entry) => entry.path === normalized || entry.path.endsWith(`/${normalized}`));
}

const JACCARD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "which", "what", "who", "whom", "when",
  "where", "how", "why", "does", "do", "did", "has", "have", "had", "will",
  "would", "can", "could", "should", "not", "no", "your", "you", "we", "they",
  "he", "she", "them",
]);
