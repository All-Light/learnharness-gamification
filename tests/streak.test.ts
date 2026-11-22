import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  computeProgress,
  localDate,
  milestonesToday,
  weekStart,
} from "../src/streak.ts";

// 2026-11-16 is a Monday.
const MON = "2026-11-16",
  TUE = "2026-11-17",
  WED = "2026-11-18",
  THU = "2026-11-19",
  SUN = "2026-11-22";

test("calendar arithmetic and weeks", () => {
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // across a DST change
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekStart(SUN), MON);
  assert.equal(weekStart(MON), MON);
  assert.equal(
    localDate("2026-11-21T23:30:00Z", "Europe/Stockholm"),
    "2026-11-22",
  );
  assert.equal(
    localDate("2026-11-21T23:30:00Z", "America/New_York"),
    "2026-11-21",
  );
});

test("no history: today is pending, no run", () => {
  const p = computeProgress([], WED, 1);
  assert.equal(p.currentRun, 0);
  assert.equal(p.todayDone, false);
  assert.equal(p.days.get(WED), "pending");
});

test("consecutive days build a run; today not yet done keeps it alive", () => {
  assert.equal(computeProgress([MON, TUE, WED], WED, 1).currentRun, 3);
  const p = computeProgress([MON, TUE], WED, 1);
  assert.equal(p.currentRun, 2);
  assert.equal(p.todayDone, false);
  assert.equal(p.days.get(WED), "pending");
});

test("a missed day is a rest day when the week has one left", () => {
  const p = computeProgress([MON, WED], WED, 1);
  assert.equal(p.currentRun, 2);
  assert.equal(p.days.get(TUE), "rest");
  assert.equal(p.restLeftThisWeek, 0);
  const none = computeProgress([MON, WED], WED, 0);
  assert.equal(none.currentRun, 1);
  assert.equal(none.days.get(TUE), "gap");
});

test("a rest day that does not save the run becomes a gap and the allowance is returned", () => {
  const p = computeProgress([MON, THU], THU, 1);
  assert.equal(p.currentRun, 1);
  assert.equal(p.days.get(TUE), "gap");
  assert.equal(p.days.get(WED), "gap");
  assert.equal(p.restLeftThisWeek, 1);
  assert.equal(p.bestRun, 1);
});

test("yesterday covered by a rest day while today is still pending", () => {
  const p = computeProgress([MON], WED, 1);
  assert.equal(p.currentRun, 1);
  assert.equal(p.days.get(TUE), "rest");
});

test("rest allowance is per week", () => {
  // Sun 22 Nov (week 1) and Mon 23 Nov (week 2) both missed: one rest day each.
  const p = computeProgress(["2026-11-21", "2026-11-24"], "2026-11-24", 1);
  assert.equal(p.days.get(SUN), "rest");
  assert.equal(p.days.get("2026-11-23"), "rest");
  assert.equal(p.currentRun, 2);
});

test("total learning days never reset; best run is kept", () => {
  const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", MON];
  const p = computeProgress(dates, WED, 1);
  assert.equal(p.totalLearningDays, 5);
  assert.equal(p.bestRun, 4);
  assert.equal(p.currentRun, 1);
  assert.equal(p.previousLearningDay, MON);
});

test("milestones: run, comeback, best week; nothing before today is done", () => {
  const seven = Array.from({ length: 7 }, (_, i) => addDays("2026-11-10", i));
  assert.deepEqual(
    milestonesToday(computeProgress(seven, seven.at(-1)!, 0)).map((m) => m.id),
    [`run-7@${seven.at(-1)}`],
  );
  const comeback = computeProgress(["2026-11-02", THU], THU, 1);
  assert.ok(milestonesToday(comeback).some((m) => m.kind === "comeback"));
  assert.deepEqual(milestonesToday(computeProgress([MON, TUE], WED, 1)), []);
  // Earlier week had 2 days; this week reaches 3.
  const best = computeProgress(
    ["2026-11-09", "2026-11-10", MON, TUE, WED],
    WED,
    1,
  );
  assert.ok(milestonesToday(best).some((m) => m.id === `best-week-3@${WED}`));
});
