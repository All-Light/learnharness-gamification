import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LearningEvent } from "./activity.ts";
import type { StudyPlan } from "./ics.ts";
import { addDays, localDate, type Milestone, type Progress } from "./streak.ts";

export interface Settings {
  restPerWeek: number;
  affirmations: boolean;
  milestoneCards: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  restPerWeek: 1,
  affirmations: true,
  milestoneCards: true,
};

export interface SessionEntry {
  title: string;
  /** Message count when last scanned; unchanged sessions are not re-read. */
  messageCount: number;
  events: LearningEvent[];
  /** The session was deleted; its learning days still count, excerpts are dropped. */
  deleted?: boolean;
}

export interface State {
  version: 1;
  settings: Settings;
  sessions: Record<string, SessionEntry>;
  /** Milestones reached, oldest first. */
  reached: Milestone[];
  /** Milestone IDs the tutor has shown as a card. */
  delivered: string[];
  plan?: StudyPlan;
}

const FILE = "state.json";

export function emptyState(): State {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {},
    reached: [],
    delivered: [],
  };
}

export async function loadState(dir: string): Promise<State> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, FILE), "utf8"));
    if (raw?.version !== 1)
      throw new Error(
        "Unsupported Gamification state version; refusing to overwrite it.",
      );
    return {
      ...emptyState(),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(dir: string, state: State): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export function validateSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const rest = Number(r.restPerWeek);
  if (![0, 1, 2].includes(rest))
    throw new Error("Rest days per week must be 0, 1 or 2.");
  if (
    typeof r.affirmations !== "boolean" ||
    typeof r.milestoneCards !== "boolean"
  )
    throw new Error("Invalid settings.");
  return {
    restPerWeek: rest,
    affirmations: r.affirmations,
    milestoneCards: r.milestoneCards,
  };
}

export interface DatedEvent extends LearningEvent {
  date: string;
  sessionTitle: string;
}

export function allEvents(state: State, timeZone?: string): DatedEvent[] {
  const out: DatedEvent[] = [];
  for (const entry of Object.values(state.sessions))
    for (const e of entry.events)
      out.push({
        ...e,
        ...(entry.deleted ? { excerpt: undefined } : {}),
        date: localDate(e.at, timeZone),
        sessionTitle: entry.deleted ? "" : entry.title,
      });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  timeZone: "UTC",
});
function dayName(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  return WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

/**
 * Specific, process-focused "recent wins" from the learner's own last 7 days.
 * Templates only, no generated text.
 */
export function recentWins(
  events: DatedEvent[],
  progress: Progress,
  reached: Milestone[],
): string[] {
  const since = addDays(progress.today, -6);
  const wins: string[] = [];
  const byDay = new Map<string, DatedEvent[]>();
  for (const e of events)
    if (e.date >= since) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  for (const date of [...byDay.keys()].sort().reverse()) {
    const day = byDay.get(date)!;
    const name = dayName(date, progress.today);
    const challenging = day.filter(
      (e) => e.kind === "question" && e.challenging,
    ).length;
    const practice = day.filter((e) => e.kind === "practice").length;
    for (const e of day.filter((x) => x.confidentMistake).slice(0, 2))
      wins.push(
        e.excerpt
          ? `${name}: you corrected a confident mistake (“${e.excerpt}”). Those tend to stick especially well.`
          : `${name}: you corrected a confident mistake. Those tend to stick especially well.`,
      );
    if (challenging >= 2)
      wins.push(
        `${name}: you stuck with ${challenging} challenging questions.`,
      );
    if (practice >= 3) wins.push(`${name}: ${practice} practice attempts.`);
  }
  for (const m of [...reached].reverse()) {
    if (m.date < since) continue;
    const name = dayName(m.date, progress.today);
    if (m.kind === "comeback")
      wins.push(`${name}: welcome back. A fresh start counts.`);
    if (m.kind === "best-week")
      wins.push(`${name}: your best week yet (${m.value} learning days).`);
  }
  return wins.slice(0, 8);
}
