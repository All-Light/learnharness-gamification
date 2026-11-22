/**
 * Learning events extracted from a saved LearnHarness session record.
 * Only counts and a short question excerpt are kept, never the learner's
 * written thinking.
 */

/** Graded/learning question tools. ask_user_question is a preference prompt, not learning. */
const LEARNING_QUESTION_TOOLS = new Set(["quiz", "probe", "explain", "recall"]);
const EXCERPT_CHARS = 80;
/** Confidence (0-100) at or above which a wrong answer is a "confident mistake". */
export const CONFIDENT_MISTAKE = 80;
/** Confidence at or below which an answer counts as challenging. */
export const LOW_CONFIDENCE = 50;

export interface LearningEvent {
  /** ISO timestamp of the answer or practice attempt. */
  at: string;
  kind: "question" | "practice";
  /** Wrong, "I don't know", or low confidence. */
  challenging?: boolean;
  /** Wrong at high confidence: these are corrected especially well. */
  confidentMistake?: boolean;
  /** Start of the question text, for "recent wins". */
  excerpt?: string;
}

const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};

function excerpt(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > EXCERPT_CHARS
    ? `${clean.slice(0, EXCERPT_CHARS - 1)}…`
    : clean;
}

function isoFromTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  return undefined;
}

/** Extract learning events from one session record (unknown shapes are skipped). */
export function extractEvents(record: unknown): LearningEvent[] {
  const messages: unknown[] = Array.isArray(obj(record).messages)
    ? obj(record).messages
    : [];
  const events: LearningEvent[] = [];
  for (const raw of messages) {
    const m = obj(raw);
    if (
      m.role === "toolResult" &&
      LEARNING_QUESTION_TOOLS.has(m.toolName) &&
      !m.isError
    ) {
      const d = obj(m.details);
      const at = isoFromTimestamp(d.answeredAt);
      if (!at || d.dismissed === true) continue;
      const graded = d.kind === "quiz";
      const confidence =
        typeof d.confidence === "number" ? d.confidence : undefined;
      const wrong = graded && d.correct === false && d.dontKnow !== true;
      const challenging =
        d.dontKnow === true ||
        wrong ||
        (graded && confidence !== undefined && confidence <= LOW_CONFIDENCE);
      const event: LearningEvent = { at, kind: "question" };
      if (challenging) event.challenging = true;
      if (wrong && confidence !== undefined && confidence >= CONFIDENT_MISTAKE)
        event.confidentMistake = true;
      const text = excerpt(d.questionText);
      if (text) event.excerpt = text;
      events.push(event);
    } else if (m.role === "custom" && m.customType === "practice-thinking") {
      const at = isoFromTimestamp(m.timestamp);
      if (at) events.push({ at, kind: "practice" });
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
