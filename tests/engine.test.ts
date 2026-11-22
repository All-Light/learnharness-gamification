import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractEvents } from "../src/activity.ts";
import { Engine, type LearningReader } from "../src/backend.ts";
import { buildIcs, validatePlan } from "../src/ics.ts";
import { deliveredMilestones } from "../src/instructions.ts";
import { milestoneText, parseMilestoneId } from "../src/main.ts";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../learnharness/tests/fixtures/golden-data/chats",
);

const answer = (toolName: string, details: Record<string, unknown>) => ({
  role: "toolResult",
  toolName,
  isError: false,
  details: {
    answeredAt: "2026-11-20T10:00:00Z",
    questionText: "What is a derivative?",
    ...details,
  },
});

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gamification-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("extracts learning answers and practice attempts, skips preference and dismissed", () => {
  const events = extractEvents({
    messages: [
      answer("quiz", { kind: "quiz", correct: true, confidence: 90 }),
      answer("quiz", { kind: "quiz", correct: false, confidence: 85 }),
      answer("quiz", { kind: "quiz", correct: false, dontKnow: true }),
      answer("probe", { kind: "quiz", correct: true, confidence: 30 }),
      answer("explain", { kind: "explain" }),
      answer("ask_user_question", { kind: "ask" }),
      answer("quiz", { kind: "quiz", dismissed: true }),
      { role: "toolResult", toolName: "quiz", isError: false, details: null },
      {
        role: "custom",
        customType: "practice-thinking",
        timestamp: Date.parse("2026-11-20T11:00:00Z"),
        details: { text: "my private reasoning" },
      },
    ],
  });
  assert.equal(events.length, 6);
  assert.deepEqual(
    events
      .filter((e) => e.kind === "question")
      .map((e) => [!!e.challenging, !!e.confidentMistake]),
    [
      [false, false],
      [true, true],
      [true, false],
      [true, false],
      [false, false],
    ],
  );
  assert.equal(events.filter((e) => e.kind === "practice").length, 1);
  assert.ok(
    !JSON.stringify(events).includes("my private reasoning"),
    "learner thinking is never stored",
  );
});

test("reads LearnHarness's real fixture sessions", async () => {
  const files = (await fs.readdir(FIXTURES)).filter((f) => f.endsWith(".json"));
  const byKind: Record<string, number> = {};
  for (const f of files) {
    const record = JSON.parse(
      await fs.readFile(path.join(FIXTURES, f), "utf8"),
    );
    for (const e of extractEvents(record))
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }
  assert.ok((byKind.question ?? 0) >= 5, `questions found: ${byKind.question}`);
  assert.ok((byKind.practice ?? 0) >= 2, `practice found: ${byKind.practice}`);
});

function reader(
  sessions: Record<string, { title: string; messages: unknown[] }>,
): LearningReader {
  return {
    listSessions: () =>
      Object.entries(sessions).map(([id, s]) => ({
        id,
        title: s.title,
        messageCount: s.messages.length,
      })),
    getSession: (id) => sessions[id] ?? null,
  };
}

test("engine: run, milestone instructions, delivery, deleted sessions, settings", async (t) => {
  const dir = await tempDir(t);
  const at = (day: number) =>
    `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`;
  const sessions: Record<string, { title: string; messages: unknown[] }> = {
    a: {
      title: "Calculus",
      messages: [10, 11, 12, 13, 14, 15].map((d) =>
        answer("quiz", {
          kind: "quiz",
          correct: false,
          confidence: 90,
          answeredAt: at(d),
        }),
      ),
    },
  };
  let now = new Date("2026-11-16T12:00:00Z");
  const engine = new Engine(dir, reader(sessions), {
    now: () => now,
    timeZone: "UTC",
  });
  await engine.load();
  await engine.scan();
  assert.equal(engine.progress().currentRun, 6);
  const before = engine.instructions();
  assert.match(before.teaching!, /works within your voice rules/);
  assert.doesNotMatch(before.teaching!, /gamification-milestone/);
  assert.match(
    before.probe!,
    /Missing questions during the assessment is expected/,
  );
  for (const text of Object.values(before))
    assert.doesNotMatch(text!, /streak|current run|learning day/i, "the streak is not given to the tutors");

  // Day 7: a run-7 milestone becomes pending for the tutor.
  sessions.a!.messages.push(
    answer("quiz", {
      kind: "quiz",
      correct: true,
      answeredAt: "2026-11-16T09:00:00Z",
    }),
  );
  await engine.scan("a");
  assert.equal(engine.pendingMilestone()?.id, "run-7@2026-11-16");
  for (const text of Object.values(engine.instructions()))
    assert.match(text!, /```gamification-milestone\nrun-7@2026-11-16\n```/);

  // The tutor shows it; it is no longer pending.
  sessions.a!.messages.push({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "send_to_user",
        arguments: {
          message: "Great.\n\n```gamification-milestone\nrun-7@2026-11-16\n```",
        },
      },
    ],
  });
  await engine.scan("a");
  assert.equal(engine.pendingMilestone(), undefined);

  const summary = engine.summary();
  assert.equal(summary.calendar.length, 28);
  assert.equal(summary.calendar[0]!.date, "2026-10-26"); // Monday, three weeks before this week
  assert.ok(summary.wins.some((w) => w.includes("confident mistake")));

  // Deleting the session keeps learning days but drops excerpts.
  delete sessions.a;
  await engine.scan();
  assert.equal(engine.progress().totalLearningDays, 7);
  assert.ok(!JSON.stringify(engine.state).includes("What is a derivative"));

  // Settings: both off means no instructions at all.
  await engine.setSettings({
    restPerWeek: 2,
    affirmations: false,
    milestoneCards: false,
  });
  assert.deepEqual(engine.instructions(), {});
  await assert.rejects(
    engine.setSettings({
      restPerWeek: 5,
      affirmations: true,
      milestoneCards: true,
    }),
  );

  // State survives a reload.
  const again = new Engine(dir, reader({}), {
    now: () => now,
    timeZone: "UTC",
  });
  await again.load();
  assert.equal(again.state.settings.restPerWeek, 2);
  now = new Date("2026-11-17T12:00:00Z");
  assert.equal(again.progress().totalLearningDays, 7);
});

test("guidance never asks for praise or enthusiasm", async () => {
  const { buildInstructions } = await import("../src/instructions.ts");
  const text = Object.values(buildInstructions(undefined)).join("\n");
  assert.doesNotMatch(
    text,
    /keep praise|praise brief|great job|well done|encourag/i,
  );
  assert.match(text, /no praise words/);
});

test("milestone delivery is only detected in assistant messages, with exact IDs", () => {
  assert.deepEqual(
    deliveredMilestones([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "```gamification-milestone\ncomeback-4@2026-11-20\n```",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "```gamification-milestone\nrun-7@2026-11-20\n```",
          },
        ],
      },
    ]),
    ["comeback-4@2026-11-20"],
  );
});

test("milestone cards render fixed wording only", () => {
  assert.deepEqual(parseMilestoneId("run-7@2026-11-16"), {
    kind: "run",
    value: 7,
    date: "2026-11-16",
  });
  assert.equal(parseMilestoneId("<img src=x>"), undefined);
  assert.equal(parseMilestoneId("hack-1@2026-11-16"), undefined);
  assert.equal(
    milestoneText({ kind: "run", value: 7 })?.title,
    "7 learning days in a row",
  );
  assert.equal(
    milestoneText({ kind: "total", value: 1 })?.title,
    "1 learning day in total",
  );
});

test("study plan: validation and calendar file", () => {
  assert.throws(() =>
    validatePlan({ cue: "", minutes: 15, time: "19:30", days: ["MO"] }),
  );
  assert.throws(() =>
    validatePlan({ cue: "dinner", minutes: 0, time: "19:30", days: ["MO"] }),
  );
  assert.throws(() =>
    validatePlan({ cue: "dinner", minutes: 15, time: "25:00", days: ["MO"] }),
  );
  assert.throws(() =>
    validatePlan({ cue: "dinner", minutes: 15, time: "19:30", days: [] }),
  );
  const plan = validatePlan({
    cue: "dinner, dishes; then tea",
    minutes: 20,
    time: "19:30",
    days: ["FR", "MO"],
  });
  assert.deepEqual(plan.days, ["MO", "FR"]);
  const ics = buildIcs(plan, new Date(2026, 10, 22, 12)); // Sunday 22 Nov 2026, local time
  assert.match(ics, /DTSTART:20261123T193000/); // next Monday
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,FR/);
  assert.match(ics, /DURATION:PT20M/);
  assert.match(ics, /After dinner\\, dishes\\; then tea\\, I will study/);
  for (const line of ics.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  assert.ok(
    ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"),
  );
});
