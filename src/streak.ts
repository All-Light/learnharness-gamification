/**
 * Streak rules (pure). Dates are local calendar dates "YYYY-MM-DD".
 *
 * - A learning day has at least one answered question or practice attempt.
 * - A missed day is covered by a rest day if the run is alive and that week
 *   (Monday-Sunday) still has rest days left. Rest days keep a run alive but
 *   do not add to it. A rest day only counts once the run continues; if the
 *   run breaks anyway, the day becomes a gap and the allowance is returned.
 * - Today is never "missed": until something is learned it is pending.
 * - Total learning days never reset.
 */

export type DayStatus = "learned" | "rest" | "gap" | "pending" | "none";

export interface Progress {
  today: string;
  todayDone: boolean;
  /** Learning days in the current run (0 if there is none). */
  currentRun: number;
  /** First day of the current run. */
  runSince?: string;
  bestRun: number;
  totalLearningDays: number;
  /** Learning days in the current week (Monday start). */
  weekDays: number;
  /** Most learning days in any earlier week. */
  bestEarlierWeek: number;
  /** Most recent learning day before today, if any. */
  previousLearningDay?: string;
  /** Rest days still available this week. */
  restLeftThisWeek: number;
  /** Status of every day from the first learning day through today. */
  days: Map<string, DayStatus>;
}

/** Local calendar date for an ISO timestamp in the given (or system) time zone. */
export function localDate(
  iso: string | number | Date,
  timeZone?: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Add whole days to a calendar date (calendar arithmetic, DST-safe). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts this date's week. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

export function computeProgress(
  learningDates: Iterable<string>,
  today: string,
  restPerWeek: number,
): Progress {
  const learned = new Set([...learningDates].filter((d) => d <= today));
  const sorted = [...learned].sort();
  const days = new Map<string, DayStatus>();
  const restsUsed = new Map<string, number>();
  let run = 0;
  let runSince: string | undefined;
  let best = 0;
  let pending: string[] = [];

  const breakRun = () => {
    for (const p of pending) {
      days.set(p, "gap");
      const w = weekStart(p);
      restsUsed.set(w, (restsUsed.get(w) ?? 1) - 1);
    }
    pending = [];
    best = Math.max(best, run);
    run = 0;
    runSince = undefined;
  };

  if (sorted.length) {
    for (let d = sorted[0]!; d <= today; d = addDays(d, 1)) {
      if (learned.has(d)) {
        for (const p of pending) days.set(p, "rest");
        pending = [];
        days.set(d, "learned");
        run++;
        runSince ??= d;
      } else if (d === today) {
        days.set(d, "pending");
      } else {
        const w = weekStart(d);
        if (run > 0 && (restsUsed.get(w) ?? 0) < restPerWeek) {
          restsUsed.set(w, (restsUsed.get(w) ?? 0) + 1);
          pending.push(d);
        } else {
          breakRun();
          days.set(d, "gap");
        }
      }
    }
    // Rest days at the end are protecting a run that is still alive.
    for (const p of pending) days.set(p, "rest");
    best = Math.max(best, run);
  } else {
    days.set(today, "pending");
  }

  const thisWeek = weekStart(today);
  const weekCounts = new Map<string, number>();
  for (const d of learned)
    weekCounts.set(weekStart(d), (weekCounts.get(weekStart(d)) ?? 0) + 1);
  let bestEarlierWeek = 0;
  for (const [w, n] of weekCounts)
    if (w < thisWeek) bestEarlierWeek = Math.max(bestEarlierWeek, n);
  const previous = sorted.filter((d) => d < today).at(-1);

  return {
    today,
    todayDone: learned.has(today),
    currentRun: run,
    ...(runSince ? { runSince } : {}),
    bestRun: best,
    totalLearningDays: learned.size,
    weekDays: weekCounts.get(thisWeek) ?? 0,
    bestEarlierWeek,
    ...(previous ? { previousLearningDay: previous } : {}),
    restLeftThisWeek: Math.max(0, restPerWeek - (restsUsed.get(thisWeek) ?? 0)),
    days,
  };
}

/** Status for each of the `count` days ending today (oldest first). */
export function calendar(
  progress: Progress,
  count = 28,
): { date: string; status: DayStatus }[] {
  const out: { date: string; status: DayStatus }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = addDays(progress.today, -i);
    out.push({ date, status: progress.days.get(date) ?? "none" });
  }
  return out;
}

export type MilestoneKind = "run" | "total" | "comeback" | "best-week";

export interface Milestone {
  /** Unique per occurrence, e.g. "run-7@2026-11-22". */
  id: string;
  kind: MilestoneKind;
  value: number;
  date: string;
}

const RUN_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
const TOTAL_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

/** Milestones reached today (only once today has a learning day). */
export function milestonesToday(p: Progress): Milestone[] {
  if (!p.todayDone) return [];
  const out: Milestone[] = [];
  const add = (kind: MilestoneKind, value: number) =>
    out.push({ id: `${kind}-${value}@${p.today}`, kind, value, date: p.today });
  if (p.runSince === p.today && p.totalLearningDays > 1)
    add("comeback", p.totalLearningDays);
  if (RUN_MILESTONES.includes(p.currentRun)) add("run", p.currentRun);
  if (TOTAL_MILESTONES.includes(p.totalLearningDays))
    add("total", p.totalLearningDays);
  if (
    p.weekDays >= 3 &&
    p.bestEarlierWeek > 0 &&
    p.weekDays === p.bestEarlierWeek + 1
  )
    add("best-week", p.weekDays);
  return out;
}
