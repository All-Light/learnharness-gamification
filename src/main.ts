import type { PluginFrontendContext } from "learnharness-plugin-api";

type DayStatus = "learned" | "rest" | "gap" | "pending" | "none" | "future";
interface Milestone {
  id: string;
  kind: "run" | "total" | "comeback" | "best-week";
  value: number;
  date: string;
}
interface Settings {
  restPerWeek: number;
  affirmations: boolean;
  milestoneCards: boolean;
}
interface StudyPlan {
  cue: string;
  minutes: number;
  time: string;
  days: string[];
}
interface Summary {
  today: string;
  todayDone: boolean;
  currentRun: number;
  runSince?: string;
  bestRun: number;
  totalLearningDays: number;
  weekDays: number;
  restLeftThisWeek: number;
  calendar: { date: string; status: DayStatus }[];
  wins: string[];
  milestones: Milestone[];
  settings: Settings;
  plan?: StudyPlan;
}

const MILESTONE_LANGUAGE = "gamification-milestone";
const WEEKDAYS: [string, string][] = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
  ["SA", "Sat"],
  ["SU", "Sun"],
];
const FLAME_PATH =
  "M12 2.5c.6 3.1 2.6 4.6 4.1 6.4 1.4 1.7 2.4 3.5 2.4 5.8A6.5 6.5 0 0 1 12 21.2a6.5 6.5 0 0 1-6.5-6.5c0-2 .8-3.7 2.1-5.1.2 1.6 1 2.8 2.3 3.4-.4-3.9.6-7.6 2.1-10.5Z";
const FLAME_COLOR = "#f97316";

/**
 * The streak flame. Filled once today has a learning day, outlined while it is
 * still open. With `animate`, a spring "pop" and a fading ring play when the
 * SVG is inserted, i.e. exactly when the host swaps in this new icon. Class and
 * keyframe names are prefixed because inline SVG styles are page-global.
 */
export function flameIcon(done: boolean, animate: boolean): string {
  const style = animate
    ? "<style>@keyframes lhgam-pop{0%{transform:scale(.55)}55%{transform:scale(1.3)}100%{transform:scale(1)}}" +
      "@keyframes lhgam-ring{0%{opacity:.75;transform:scale(.45)}100%{opacity:0;transform:scale(1.7)}}" +
      ".lhgam-anim .lhgam-flame{transform-box:fill-box;transform-origin:50% 85%;animation:lhgam-pop .7s cubic-bezier(.3,1.6,.5,1) both}" +
      ".lhgam-anim .lhgam-ring{transform-box:fill-box;transform-origin:center;animation:lhgam-ring .8s ease-out both}" +
      "@media (prefers-reduced-motion:reduce){.lhgam-anim .lhgam-flame,.lhgam-anim .lhgam-ring{animation:none}.lhgam-anim .lhgam-ring{opacity:0}}</style>"
    : "";
  const ring = animate
    ? `<circle class="lhgam-ring" cx="12" cy="13" r="9" fill="none" stroke="${FLAME_COLOR}" stroke-width="2" opacity="0"/>`
    : "";
  const flame = done
    ? `<path class="lhgam-flame" d="${FLAME_PATH}" fill="${FLAME_COLOR}" stroke="${FLAME_COLOR}" stroke-width="1.5" stroke-linejoin="round"/>`
    : `<path class="lhgam-flame" d="${FLAME_PATH}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  return `<svg${animate ? ' class="lhgam-anim"' : ""} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" overflow="visible">${style}${ring}${flame}</svg>`;
}

export function streakLabel(run: number): string {
  return run > 0 ? `${run}-day streak` : "Start a streak";
}

/** Animate only when things improve: the run grew, or today got done. */
export function shouldAnimate(
  before: { run: number; done: boolean } | undefined,
  after: { run: number; done: boolean },
): boolean {
  return !!before && (after.run > before.run || (after.done && !before.done));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const child of children) node.append(child);
  return node;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Fixed wording for milestone cards; the tutor only supplies the milestone ID. */
export function milestoneText(
  m: Pick<Milestone, "kind" | "value">,
): { title: string; body: string } | undefined {
  switch (m.kind) {
    case "run":
      return {
        title: `${plural(m.value, "learning day")} in a row`,
        body: "Showing up regularly is what makes learning stick.",
      };
    case "total":
      return {
        title: `${plural(m.value, "learning day")} in total`,
        body: "Every one of those days added up.",
      };
    case "comeback":
      return {
        title: "Welcome back",
        body: "A fresh start counts. Today is day 1 of a new run.",
      };
    case "best-week":
      return {
        title: `Your best week yet: ${plural(m.value, "learning day")}`,
        body: "Consistency over intensity.",
      };
    default:
      return undefined;
  }
}

export function parseMilestoneId(
  id: string,
): Pick<Milestone, "kind" | "value" | "date"> | undefined {
  const m = /^(run|total|comeback|best-week)-(\d+)@(\d{4}-\d{2}-\d{2})$/.exec(
    id.trim(),
  );
  return m
    ? { kind: m[1] as Milestone["kind"], value: Number(m[2]), date: m[3]! }
    : undefined;
}

export function activate(ctx: PluginFrontendContext) {
  const call = <T>(op: string, input?: unknown) => ctx.call<T>(op, input);
  const button = (
    container: HTMLElement,
    label: string,
    onClick: () => unknown,
    signal: AbortSignal,
    variant: "default" | "outline" | "ghost" = "outline",
  ) =>
    ctx.ui.mountButton(
      container,
      {
        label,
        onClick: async () => {
          await onClick();
        },
        variant,
        size: "sm",
      },
      { signal },
    );

  // ── Milestone cards inside lessons ────────────────────────────────────────
  ctx.registerCodeBlock({
    language: MILESTONE_LANGUAGE,
    async mount(container, block) {
      const parsed = parseMilestoneId(block.source);
      const text = parsed && milestoneText(parsed);
      if (!text || block.incomplete) return;
      // Only milestones this plugin actually recorded become cards; the tutor
      // (or course material steering it) cannot invent one.
      const known = await call<boolean>("milestoneKnown", { id: block.source.trim() }).catch(() => false);
      if (!known || block.signal.aborted) return;
      const card = el(
        "div",
        { className: "lh-gam lh-gam-milestone" },
        el("div", { className: "lh-gam-milestone-mark", text: "★" }),
        el(
          "div",
          {},
          el("strong", { text: text.title }),
          el("p", { text: text.body }),
        ),
      );
      container.append(card);
      return () => card.remove();
    },
  });

  // ── Progress view ─────────────────────────────────────────────────────────
  const renders = new Set<() => void>();
  ctx.onNotification((event) => {
    if (event.topic === "state-changed") for (const r of renders) r();
  });
  ctx.onResync(() => {
    for (const r of renders) r();
  });

  ctx.registerView({
    id: "progress",
    name: "Progress",
    async mount(container, signal) {
      const root = el("div", { className: "lh-gam lh-gam-view" });
      container.append(root);
      // Live sections are rebuilt on each change; the study-plan form is built
      // once per mount so typing and the download link survive updates.
      const live = el("div", { className: "lh-gam-live" });
      let planSection: HTMLElement | undefined;
      let generation = 0;
      const render = async () => {
        const mine = ++generation;
        let s: Summary;
        try {
          s = await call<Summary>("summary");
        } catch (error) {
          live.replaceChildren(el("p", { className: "lh-gam-error", text: errorText(error) }));
          if (!live.isConnected) root.replaceChildren(live);
          return;
        }
        if (signal.aborted || mine !== generation) return;
        live.replaceChildren(today(s), calendarGrid(s), wins(s));
        if (!planSection) {
          planSection = plan(s, signal);
          root.replaceChildren(live, planSection);
        }
      };
      renders.add(render);
      signal.addEventListener("abort", () => renders.delete(render), {
        once: true,
      });
      await render();
      return () => root.remove();
    },
  });

  const today = (s: Summary) => {
    const headline =
      s.currentRun > 0
        ? `${plural(s.currentRun, "learning day")} in a row`
        : "Start a run today";
    const status = s.todayDone
      ? "Done for today. Nice work."
      : s.currentRun > 0
        ? "One answered question today keeps your run going."
        : s.totalLearningDays > 0
          ? "Welcome back. One answered question starts a fresh run."
          : "Answer one question in any lesson to start.";
    const stats = [
      `${plural(s.totalLearningDays, "learning day")} in total`,
      `best run ${s.bestRun}`,
      `${plural(s.weekDays, "day")} this week`,
      `${plural(s.restLeftThisWeek, "rest day")} left this week`,
    ];
    return el(
      "section",
      { className: "lh-gam-today" },
      el("h2", { text: headline }),
      el("p", {
        className: s.todayDone ? "lh-gam-done" : "lh-gam-muted",
        text: status,
      }),
      el("p", { className: "lh-gam-muted", text: stats.join(" · ") }),
    );
  };

  const LABEL: Record<DayStatus, string> = {
    learned: "learning day",
    rest: "rest day (run protected)",
    gap: "no learning",
    pending: "today",
    none: "",
    future: "",
  };
  const calendarGrid = (s: Summary) => {
    const grid = el("div", { className: "lh-gam-grid" });
    grid.setAttribute("role", "grid");
    for (const [, name] of WEEKDAYS)
      grid.append(el("div", { className: "lh-gam-weekday", text: name }));
    for (const day of s.calendar) {
      const cell = el("div", {
        className: `lh-gam-day lh-gam-${day.status}${day.date === s.today ? " lh-gam-today-cell" : ""}`,
        text: String(Number(day.date.slice(8))),
      });
      cell.title = `${day.date}${LABEL[day.status] ? `: ${LABEL[day.status]}` : ""}`;
      grid.append(cell);
    }
    const legend = el(
      "p",
      { className: "lh-gam-legend" },
      el("span", { className: "lh-gam-swatch lh-gam-learned" }),
      " learning day  ",
      el("span", { className: "lh-gam-swatch lh-gam-rest" }),
      " rest day (keeps your run)  ",
      el("span", { className: "lh-gam-swatch lh-gam-gap" }),
      " no learning",
    );
    return el(
      "section",
      {},
      el("h3", { text: "Last four weeks" }),
      grid,
      legend,
    );
  };

  const wins = (s: Summary) => {
    const section = el("section", {}, el("h3", { text: "Recent wins" }));
    const items = [...s.wins];
    for (const m of s.milestones) {
      const text = milestoneText(m);
      if (text && (m.kind === "run" || m.kind === "total"))
        items.push(`${m.date === s.today ? "Today" : m.date}: ${text.title}.`);
    }
    if (!items.length)
      section.append(
        el("p", {
          className: "lh-gam-muted",
          text: "Your wins from the last week will show up here: challenging questions you stuck with, confident mistakes you corrected, and milestones.",
        }),
      );
    else {
      const ul = el("ul", { className: "lh-gam-wins" });
      for (const item of items.slice(0, 10))
        ul.append(el("li", { text: item }));
      section.append(ul);
    }
    return section;
  };

  const plan = (s: Summary, signal: AbortSignal) => {
    const section = el(
      "section",
      { className: "lh-gam-plan" },
      el("h3", { text: "Study plan" }),
      el("p", {
        className: "lh-gam-muted",
        text: "Planning when and where you will study makes it much more likely to happen. Save a plan to get a repeating reminder for your own calendar.",
      }),
    );
    const cue = el("input", { className: "lh-gam-input" });
    cue.placeholder = "dinner";
    cue.value = s.plan?.cue ?? "";
    cue.maxLength = 120;
    const minutes = el("input", { className: "lh-gam-input lh-gam-short" });
    minutes.type = "number";
    minutes.min = "1";
    minutes.max = "240";
    minutes.value = String(s.plan?.minutes ?? 15);
    const time = el("input", { className: "lh-gam-input lh-gam-short" });
    time.type = "time";
    time.value = s.plan?.time ?? "19:30";
    const days = el("div", { className: "lh-gam-days" });
    const boxes = new Map<string, HTMLInputElement>();
    for (const [code, name] of WEEKDAYS) {
      const box = el("input");
      box.type = "checkbox";
      box.checked = s.plan
        ? s.plan.days.includes(code)
        : !["SA", "SU"].includes(code);
      boxes.set(code, box);
      days.append(el("label", { className: "lh-gam-daybox" }, box, name));
    }
    const sentence = el(
      "p",
      { className: "lh-gam-sentence" },
      "After ",
      cue,
      ", I will study for ",
      minutes,
      " minutes at ",
      time,
      " on:",
    );
    const message = el("p", { className: "lh-gam-muted" });
    const actions = el("div", { className: "lh-gam-actions" });
    section.append(sentence, days, actions, message);
    button(
      actions,
      s.plan ? "Update plan and reminder" : "Save plan and create reminder",
      async () => {
        message.className = "lh-gam-muted";
        message.textContent = "Saving…";
        try {
          const result = await call<{ path: string; ics: string }>("savePlan", {
            cue: cue.value,
            minutes: Number(minutes.value),
            time: time.value,
            days: [...boxes].filter(([, b]) => b.checked).map(([code]) => code),
          });
          message.replaceChildren(`Saved. Add the reminder to your calendar: `);
          const link = el("a", { text: "download study-reminder.ics" });
          link.href = URL.createObjectURL(
            new Blob([result.ics], { type: "text/calendar" }),
          );
          link.download = "study-reminder.ics";
          signal.addEventListener(
            "abort",
            () => URL.revokeObjectURL(link.href),
            { once: true },
          );
          message.append(link, ` (also saved at ${result.path}).`);
        } catch (error) {
          message.className = "lh-gam-error";
          message.textContent = errorText(error);
        }
      },
      signal,
      "default",
    );
    return section;
  };

  // ── Streak button (sidebar + session top bar) ───────────────────────────────
  // The host renders an action's name and SVG icon; there is no live badge API,
  // so an update swaps the action (same ID). Placements look it up by ID, and
  // the host re-inserts the icon only when its markup changes.
  let shown: { run: number; done: boolean } | undefined;
  let unregisterAction: (() => void) | undefined;
  const showStreak = (run: number, done: boolean, animate: boolean) => {
    unregisterAction?.();
    unregisterAction = ctx.registerAction({
      id: "streak",
      name: streakLabel(run),
      icon: flameIcon(done, animate),
      run: () => ctx.app.openView("progress"),
    });
  };
  showStreak(0, false, false);
  ctx.placeAction({
    id: "streak-sidebar",
    actionId: "streak",
    location: "sidebar",
  });
  ctx.placeAction({
    id: "streak-top-bar",
    actionId: "streak",
    location: "top-bar",
    sessions: ["teaching", "practice"],
  });
  const syncStreak = async () => {
    try {
      const s = await call<Summary>("summary");
      if (ctx.signal.aborted) return;
      const next = { run: s.currentRun, done: s.todayDone };
      if (shown && shown.run === next.run && shown.done === next.done) return;
      showStreak(next.run, next.done, shouldAnimate(shown, next));
      shown = next;
    } catch {
      // Keep the last known streak; the next update retries.
    }
  };
  void syncStreak();
  ctx.onNotification((event) => {
    if (event.topic === "state-changed") void syncStreak();
  });
  ctx.onResync(() => void syncStreak());

  // ── Settings ──────────────────────────────────────────────────────────────
  // ── Updates ───────────────────────────────────────────────────────────────
  interface UpdateStatus {
    mode: "updatable" | "developer" | "managed";
    current: string;
    latest?: { version: string; minAppVersion: string; notes: string };
    available: boolean;
    checkedAt?: string;
    error?: string;
    canRollBack: boolean;
    restartRequired: boolean;
    needsAppConfirm?: boolean;
  }
  const renderUpdates = (section: HTMLElement, signal: AbortSignal) => {
    let scope: AbortController | undefined;
    const show = (
      status: UpdateStatus | undefined,
      message?: { text: string; error?: boolean },
    ) => {
      scope?.abort();
      scope = new AbortController();
      const sig = AbortSignal.any([signal, scope.signal]);
      section.replaceChildren(el("h3", { text: "Updates" }));
      const line = (text: string, className = "lh-gam-muted") =>
        section.append(el("p", { className, text }));
      if (message)
        line(message.text, message.error ? "lh-gam-error" : "lh-gam-muted");
      if (!status) return;
      if (status.mode === "developer") {
        line(
          `Version ${status.current}. This is a development build: update it by rebuilding (npm run install:local).`,
        );
        return;
      }
      if (status.mode === "managed") {
        line(
          `Version ${status.current}. Updates for this copy come with LearnHarness.`,
        );
        return;
      }
      if (status.restartRequired)
        line(
          "Update applied. Restart LearnHarness to finish.",
          "lh-gam-attention",
        );
      const actions = el("div", { className: "lh-gam-actions" });
      if (status.available && status.latest && !status.restartRequired) {
        const notice = el(
          "div",
          { className: "lh-gam-notice" },
          el("strong", {
            text: `Version ${status.latest.version} is available `,
          }),
          `(you have ${status.current}). Requires LearnHarness ${status.latest.minAppVersion} or newer.`,
        );
        if (status.latest.notes)
          notice.append(
            el("p", { className: "lh-gam-notes", text: status.latest.notes }),
          );
        section.append(notice);
        // Plugins cannot read the app version; when a release needs a newer
        // LearnHarness than before, the user confirms it before installing.
        let confirm: HTMLInputElement | undefined;
        if (status.needsAppConfirm) {
          confirm = el("input");
          confirm.type = "checkbox";
          section.append(
            el("label", { className: "lh-gam-confirm" }, confirm,
              ` I have LearnHarness ${status.latest.minAppVersion} or newer (an older app could not load this update).`),
          );
        }
        section.append(actions);
        const installButton = button(
          actions,
          "Install update",
          () => run("installUpdate", "Downloading and verifying the update…", { confirmAppVersion: confirm?.checked === true }),
          sig,
          "default",
        );
        if (confirm) {
          installButton.update({ disabled: true });
          confirm.addEventListener("change", () => installButton.update({ disabled: !confirm!.checked }), { signal: sig });
        }
      } else {
        if (status.error)
          line(`Could not check for updates: ${status.error}`, "lh-gam-error");
        else if (!status.restartRequired)
          line(
            `Up to date (version ${status.current}).${status.checkedAt ? ` Checked ${new Date(status.checkedAt).toLocaleString()}.` : ""}`,
          );
        section.append(actions);
      }
      button(
        actions,
        "Check for updates",
        () => run("updateStatus", "Checking for updates…", { force: true }),
        sig,
        "outline",
      );
      if (status.canRollBack && !status.restartRequired)
        button(
          actions,
          "Roll back to previous version",
          () => run("rollBackUpdate", "Restoring the previous version…"),
          sig,
          "ghost",
        );
    };
    const run = async (op: string, busy: string, input?: unknown) => {
      show(undefined, { text: busy });
      try {
        show(await call<UpdateStatus>(op, input));
      } catch (error) {
        const fallback = await call<UpdateStatus>("updateStatus").catch(
          () => undefined,
        );
        show(fallback, { text: errorText(error), error: true });
      }
    };
    void run("updateStatus", "Checking for updates…");
  };

  ctx.registerSettings(async (container, signal) => {
    const updates = el("section", { className: "lh-gam lh-gam-updates" });
    const root = el("div", { className: "lh-gam" });
    container.append(updates, root);
    renderUpdates(updates, signal);
    let s: Summary;
    try {
      s = await call<Summary>("summary");
    } catch (error) {
      root.append(
        el("p", { className: "lh-gam-error", text: errorText(error) }),
      );
      return () => {
        updates.remove();
        root.remove();
      };
    }
    let current = s.settings;
    const rows = el("div");
    const message = el("p", { className: "lh-gam-muted" });
    root.append(rows, message);
    const save = async (next: Settings) => {
      const result = await call<Summary>("setSettings", next);
      current = result.settings;
      handle.update(schema());
    };
    const schema = () => ({
      rows: [
        {
          key: "rest",
          type: "dropdown" as const,
          label: "Rest days per week",
          description:
            "Missed days covered automatically so your run continues.",
          value: String(current.restPerWeek),
          options: [
            { value: "0", label: "None" },
            { value: "1", label: "1" },
            { value: "2", label: "2" },
          ],
          onChange: (v: string) => save({ ...current, restPerWeek: Number(v) }),
        },
        {
          key: "affirmations",
          type: "toggle" as const,
          label: "Feedback guidance in lessons",
          description:
            "Tells the tutor to name what was right in your reasoning, say plainly that misses on hard questions are expected, and point out when a confident mistake is worth remembering.",
          value: current.affirmations,
          onChange: (v: boolean) => save({ ...current, affirmations: v }),
        },
        {
          key: "cards",
          type: "toggle" as const,
          label: "Milestone cards in lessons",
          description:
            "The tutor shows a small card when you reach a milestone.",
          value: current.milestoneCards,
          onChange: (v: boolean) => save({ ...current, milestoneCards: v }),
        },
      ],
    });
    const handle = ctx.ui.mountSettingsRows(rows, schema(), { signal });
    const actions = el("div", { className: "lh-gam-actions" });
    root.append(actions);
    button(
      actions,
      "Re-scan learning history",
      async () => {
        message.textContent = "Scanning…";
        try {
          const r = await call<Summary>("rescan");
          message.textContent = `Done: ${plural(r.totalLearningDays, "learning day")} found.`;
        } catch (error) {
          message.textContent = errorText(error);
        }
      },
      signal,
    );
    return () => {
      updates.remove();
      root.remove();
    };
  });
}
