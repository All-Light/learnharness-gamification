import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractEvents } from "../src/activity.ts";
import { Engine, type LearningReader } from "../src/backend.ts";

const answer = (answeredAt: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult", toolName: "quiz", isError: false,
  details: { kind: "quiz", correct: true, answeredAt, questionText: "Q", ...extra },
});

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gamification-hard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("out-of-range timestamps are ignored instead of breaking the plugin", () => {
  const events = extractEvents({ messages: [
    answer("1200-01-01T00:00:00Z"), answer("0999-06-01T00:00:00Z"), answer("+010000-01-01T00:00:00Z"),
    answer("2026-11-20T10:00:00Z"),
    { role: "custom", customType: "practice-thinking", timestamp: 8.64e15 },
  ] });
  assert.deepEqual(events.map((e) => e.at), ["2026-11-20T10:00:00.000Z"]);
});

test("excerpts never split a character", () => {
  const [e] = extractEvents({ messages: [answer("2026-11-20T10:00:00Z", { questionText: "a".repeat(78) + "😀😀😀" })] });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(e!.excerpt!), "no lone surrogate");
});

test("per-turn scan reads only that session; titles are never stored; unchanged state is not rewritten", async (t) => {
  const dir = await tempDir(t);
  // A state file from an earlier version, with a session title.
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1, sessions: { a: { title: "Private topic", messageCount: 0, events: [] } }, reached: [], delivered: [] }));
  let listed = 0;
  const sessions: Record<string, { messages: unknown[] }> = { a: { messages: [answer("2026-11-20T10:00:00Z")] } };
  const reader: LearningReader = {
    listSessions: () => { listed++; return Object.keys(sessions).map((id) => ({ id, title: "Private topic", messageCount: sessions[id]!.messages.length })); },
    getSession: (id) => sessions[id] ?? null,
  };
  const engine = new Engine(dir, reader, { now: () => new Date("2026-11-20T12:00:00Z"), timeZone: "UTC" });
  await engine.load();
  await engine.scan("a");
  assert.equal(listed, 0, "the per-turn path does not list all sessions");
  assert.ok(!(await fs.readFile(path.join(dir, "state.json"), "utf8")).includes("Private topic"));
  const stat = await fs.stat(path.join(dir, "state.json"));
  await new Promise((r) => setTimeout(r, 20));
  await engine.scan("a");
  assert.equal((await fs.stat(path.join(dir, "state.json"))).mtimeMs, stat.mtimeMs, "no rewrite when nothing changed");
});

test("only milestones the plugin recorded count as delivered", async (t) => {
  const dir = await tempDir(t);
  const fence = (id: string) => ({ role: "assistant", content: [{ type: "text", text: "```gamification-milestone\n" + id + "\n```" }] });
  const sessions: Record<string, { messages: unknown[] }> = { a: { messages: [answer("2026-11-20T10:00:00Z"), fence("run-365@2026-11-20")] } };
  const reader: LearningReader = { listSessions: () => [{ id: "a", title: "", messageCount: 2 }], getSession: (id) => sessions[id] ?? null };
  const engine = new Engine(dir, reader, { now: () => new Date("2026-11-20T12:00:00Z"), timeZone: "UTC" });
  await engine.load();
  await engine.scan();
  assert.equal(engine.isKnownMilestone("run-365@2026-11-20"), false);
  assert.deepEqual(engine.state.delivered, []);
});

test("saving the study plan again keeps the same calendar event ID", async (t) => {
  const dir = await tempDir(t);
  const engine = new Engine(dir, { listSessions: () => [], getSession: () => null }, { now: () => new Date("2026-11-22T12:00:00Z") });
  await engine.load();
  const plan = { cue: "dinner", minutes: 15, time: "19:30", days: ["MO"] };
  const uid = (ics: string) => /UID:(.*)\r\n/.exec(ics)![1];
  const first = await engine.savePlan(plan);
  const second = await engine.savePlan({ ...plan, minutes: 20 });
  assert.equal(uid(first.ics), uid(second.ics));
  assert.equal((await fs.stat(second.path)).mode & 0o777, 0o600);
});
