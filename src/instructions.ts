/**
 * Instructions added to the tutors. They are written to fit LearnHarness's
 * shared voice rules (no praise or enthusiasm, wrong answers named plainly):
 * the research favors specific feedback about the task and reasoning over
 * praise, so the guidance is informational. Celebration lives in the
 * plugin's own UI (flame, milestone cards), not in the tutor's words.
 * The streak itself is not given to the tutors; it lives only in the UI.
 */

export const MILESTONE_LANGUAGE = "gamification-milestone";

const TEACHING_RULES = `Feedback guidance (Gamification plugin). It works within your voice rules: no praise words, no performed reactions, no softened verdicts.
- When responding to an answer, first name specifically what was right in the learner's reasoning, if anything was, then correct the rest plainly.
- When an answer to a hard question is wrong, "I don't know", or low-confidence, add one plain sentence that missing hard questions is expected and is where the learning happens. Then continue.
- When a wrong answer was given with 80% confidence or more, say once that confidently held mistakes tend to be corrected especially well once the right answer is clear.`;

const PROBE_RULES = `Assessment guidance (Gamification plugin). It works within your voice rules.
- Missing questions during the assessment is expected: it shows where teaching should start. The first time the learner misses a question or answers "I don't know", say so once, plainly, then continue. Do not repeat it.`;

function milestoneDirective(id: string): string {
  return `A milestone was just reached. At the end of your next message to the learner (inside that message), add exactly this block once, on its own lines, and add no other text about it; the app shows it as a card:\n\`\`\`${MILESTONE_LANGUAGE}\n${id}\n\`\`\``;
}

export interface AgentInstructions {
  /** Teacher and practice agents. */
  teaching?: string;
  /** The prober (assessment phase). */
  probe?: string;
}

export function buildInstructions(
  pendingMilestoneId: string | undefined,
  options: { rules: boolean } = { rules: true },
): AgentInstructions {
  const directive = pendingMilestoneId
    ? [milestoneDirective(pendingMilestoneId)]
    : [];
  const teaching = [...(options.rules ? [TEACHING_RULES] : []), ...directive];
  const probe = [...(options.rules ? [PROBE_RULES] : []), ...directive];
  return {
    ...(teaching.length ? { teaching: teaching.join("\n\n") } : {}),
    ...(probe.length ? { probe: probe.join("\n\n") } : {}),
  };
}

/** Milestone IDs the tutor already delivered in these messages. */
export function deliveredMilestones(messages: unknown[]): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(
    "```" +
      MILESTONE_LANGUAGE +
      "\\s*\\n\\s*([a-z-]+-\\d+@\\d{4}-\\d{2}-\\d{2})\\s*\\n\\s*```",
    "g",
  );
  const scan = (text: unknown) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(pattern)) found.add(m[1]!);
  };
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as {
      type?: string;
      text?: unknown;
      arguments?: { message?: unknown };
    }[]) {
      if (block?.type === "text") scan(block.text);
      if (block?.type === "toolCall") scan(block.arguments?.message);
    }
  }
  return [...found];
}
