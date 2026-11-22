/**
 * A recurring study reminder as an iCalendar (.ics) file, built from the
 * learner's if-then plan ("After <cue>, I will study for <minutes> minutes").
 * Times are floating local times, so the reminder follows the calendar's zone.
 */
import crypto from "node:crypto";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface StudyPlan {
  /** The cue: "After <cue>, I will study ...". */
  cue: string;
  minutes: number;
  /** Local start time "HH:MM". */
  time: string;
  days: Weekday[];
}

export function validatePlan(raw: unknown): StudyPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const cue =
    typeof r.cue === "string" ? r.cue.replace(/\s+/g, " ").trim() : "";
  if (!cue || cue.length > 120)
    throw new Error("Describe when you will study (up to 120 characters).");
  const minutes = Number(r.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)
    throw new Error("Choose between 1 and 240 minutes.");
  const time = typeof r.time === "string" ? r.time : "";
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error("Enter a time like 19:30.");
  const days = Array.isArray(r.days) ? [...new Set(r.days)] : [];
  if (
    !days.length ||
    !days.every((d): d is Weekday =>
      (WEEKDAYS as readonly unknown[]).includes(d),
    )
  )
    throw new Error("Pick at least one day.");
  return { cue, minutes, time, days: WEEKDAYS.filter((d) => days.includes(d)) };
}

/** RFC 5545 text escaping. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
    }
    current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** The next date (YYYYMMDD) on or after `from` that falls on one of the plan's days. */
function firstDate(from: Date, days: Weekday[]): string {
  for (let i = 0; i < 7; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (days.includes(WEEKDAYS[(d.getDay() + 6) % 7]!)) {
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    }
  }
  throw new Error("No matching day.");
}

export function buildIcs(plan: StudyPlan, now = new Date()): string {
  const [hh, mm] = plan.time.split(":");
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const intention = `After ${plan.cue}, I will study for ${plan.minutes} minutes in LearnHarness.`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//learnharness-gamification//study reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@learnharness-gamification`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${firstDate(now, plan.days)}T${hh}${mm}00`,
    `DURATION:PT${plan.minutes}M`,
    `RRULE:FREQ=WEEKLY;BYDAY=${plan.days.join(",")}`,
    `SUMMARY:${escapeText(`Study in LearnHarness (${plan.minutes} min)`)}`,
    `DESCRIPTION:${escapeText(intention)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(intention)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
