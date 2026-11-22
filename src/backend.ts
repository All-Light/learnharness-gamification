import fs from "node:fs/promises";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { extractEvents } from "./activity.ts";
import { Updater } from "./update.ts";
import { buildIcs, validatePlan, type StudyPlan } from "./ics.ts";
import {
  buildInstructions,
  deliveredMilestones,
  type AgentInstructions,
} from "./instructions.ts";
import {
  allEvents,
  loadState,
  recentWins,
  saveState,
  validateSettings,
  type Settings,
  type State,
} from "./state.ts";
import {
  addDays,
  computeProgress,
  localDate,
  milestonesToday,
  type DayStatus,
  type Milestone,
  type Progress,
  weekStart,
} from "./streak.ts";

export interface LearningReader {
  listSessions(): { id: string; title: string; messageCount?: number }[];
  getSession(id: string): { title?: string; messages?: unknown[] } | null;
}

export interface Summary {
  today: string;
  todayDone: boolean;
  currentRun: number;
  runSince?: string;
  bestRun: number;
  totalLearningDays: number;
  weekDays: number;
  restLeftThisWeek: number;
  /** Four whole weeks, Monday first, ending with the current week. */
  calendar: { date: string; status: DayStatus | "future" }[];
  wins: string[];
  milestones: Milestone[];
  settings: Settings;
  plan?: StudyPlan;
}

/** All plugin logic, independent of the host so it can be tested directly. */
export class Engine {
  state!: State;

  constructor(
    private readonly dataDir: string,
    private readonly learning: LearningReader,
    private readonly clock: { now: () => Date; timeZone?: string } = {
      now: () => new Date(),
    },
  ) {}

  async load(): Promise<void> {
    this.state = await loadState(this.dataDir);
  }

  private today(): string {
    return localDate(this.clock.now(), this.clock.timeZone);
  }

  /** Re-read sessions whose message count changed (all, or one chat). */
  async scan(chatId?: string): Promise<void> {
    const listed = this.learning.listSessions();
    const ids = new Set(listed.map((s) => s.id));
    for (const s of listed) {
      if (chatId && s.id !== chatId) continue;
      const known = this.state.sessions[s.id];
      if (
        known &&
        !known.deleted &&
        s.messageCount !== undefined &&
        known.messageCount === s.messageCount &&
        !chatId
      )
        continue;
      const record = this.learning.getSession(s.id);
      if (!record) continue;
      const messages = Array.isArray(record.messages) ? record.messages : [];
      this.state.sessions[s.id] = {
        title: s.title,
        messageCount: messages.length,
        events: extractEvents(record),
      };
      for (const id of deliveredMilestones(messages))
        if (!this.state.delivered.includes(id)) this.state.delivered.push(id);
    }
    if (!chatId)
      for (const [id, entry] of Object.entries(this.state.sessions))
        if (!ids.has(id) && !entry.deleted) {
          // Keep the learning days; drop the question excerpts of deleted sessions.
          entry.deleted = true;
          entry.title = "";
          entry.events = entry.events.map(
            ({ excerpt: _drop, ...rest }) => rest,
          );
        }
    this.updateMilestones();
    await saveState(this.dataDir, this.state);
  }

  progress(): Progress {
    const dates = allEvents(this.state, this.clock.timeZone).map((e) => e.date);
    return computeProgress(
      dates,
      this.today(),
      this.state.settings.restPerWeek,
    );
  }

  private updateMilestones(): void {
    for (const m of milestonesToday(this.progress()))
      if (!this.state.reached.some((r) => r.id === m.id))
        this.state.reached.push(m);
  }

  /** Today's milestone that the tutor has not shown yet, if cards are on. */
  pendingMilestone(): Milestone | undefined {
    if (!this.state.settings.milestoneCards) return undefined;
    const today = this.today();
    return [...this.state.reached]
      .reverse()
      .find((m) => m.date === today && !this.state.delivered.includes(m.id));
  }

  instructions(): AgentInstructions {
    return buildInstructions(this.pendingMilestone()?.id, {
      rules: this.state.settings.affirmations,
    });
  }

  summary(): Summary {
    const p = this.progress();
    return {
      today: p.today,
      todayDone: p.todayDone,
      currentRun: p.currentRun,
      ...(p.runSince ? { runSince: p.runSince } : {}),
      bestRun: p.bestRun,
      totalLearningDays: p.totalLearningDays,
      weekDays: p.weekDays,
      restLeftThisWeek: p.restLeftThisWeek,
      calendar: Array.from({ length: 28 }, (_, i) => {
        const date = addDays(addDays(weekStart(p.today), -21), i);
        return {
          date,
          status:
            date > p.today ? ("future" as const) : (p.days.get(date) ?? "none"),
        };
      }),
      wins: recentWins(
        allEvents(this.state, this.clock.timeZone),
        p,
        this.state.reached,
      ),
      milestones: this.state.reached.slice(-5).reverse(),
      settings: this.state.settings,
      ...(this.state.plan ? { plan: this.state.plan } : {}),
    };
  }

  async setSettings(raw: unknown): Promise<Summary> {
    this.state.settings = validateSettings(raw);
    this.updateMilestones();
    await saveState(this.dataDir, this.state);
    return this.summary();
  }

  /** Save the study plan and write the calendar file next to the plugin data. */
  async savePlan(raw: unknown): Promise<{ path: string; ics: string }> {
    const plan = validatePlan(raw);
    const ics = buildIcs(plan, this.clock.now());
    const file = path.join(this.dataDir, "study-reminder.ics");
    await fs.writeFile(file, ics, { mode: 0o600 });
    this.state.plan = plan;
    await saveState(this.dataDir, this.state);
    return { path: file, ics };
  }
}

export function activate(ctx: PluginBackendContext) {
  // ── Updates (explicit user actions only; see update.ts) ─────────────────
  const updater = new Updater({
    directory: ctx.directory,
    dataDirectory: ctx.dataDirectory,
    currentVersion: ctx.manifest.version,
  });
  ctx.handle("updateStatus", (input: any) => updater.status(input?.force === true, ctx.signal));
  ctx.handle("installUpdate", () => updater.install(ctx.signal));
  ctx.handle("rollBackUpdate", () => updater.rollBack());

  const engine = new Engine(
    ctx.dataDirectory,
    ctx.learning as unknown as LearningReader,
  );
  // One registration per audience; each is replaced only when its text changes.
  const registered: Record<
    keyof AgentInstructions,
    { text?: string; off?: () => void }
  > = {
    teaching: {},
    probe: {},
  };
  let queue: Promise<unknown> = Promise.resolve();

  const AGENTS = {
    teaching: ["teacher", "practice"],
    probe: ["prober"],
  } as const;
  const applyInstructions = () => {
    const next = engine.instructions();
    for (const key of ["teaching", "probe"] as const) {
      const slot = registered[key];
      if (next[key] === slot.text) continue;
      slot.off?.();
      slot.off = undefined;
      slot.text = next[key];
      if (slot.text)
        slot.off = ctx.registerInstructions({
          agents: [...AGENTS[key]],
          text: slot.text,
        });
    }
  };
  const refresh = (chatId?: string) => {
    queue = queue
      .then(async () => {
        if (ctx.signal.aborted) return;
        await engine.scan(chatId);
        if (ctx.signal.aborted) return;
        applyInstructions();
        ctx.events.emit("state-changed");
      })
      .catch(() => {});
    return queue;
  };
  const ready = engine.load().then(() => refresh());

  ctx.events.on((event) => {
    if (event.type === "turn-settled" || event.type === "record-changed")
      void refresh(event.chatId);
    if (event.type === "chats-changed") void refresh();
  });
  // Notice day changes (new day, rest days, run status) even without activity.
  const timer = setInterval(() => void refresh(), 60 * 60 * 1000);
  ctx.cleanup(() => {
    clearInterval(timer);
    for (const slot of Object.values(registered)) slot.off?.();
  });

  ctx.handle("summary", async () => {
    await ready;
    return engine.summary();
  });
  ctx.handle("setSettings", async (input) => {
    await ready;
    const summary = await engine.setSettings(input);
    applyInstructions();
    return summary;
  });
  ctx.handle("rescan", async () => {
    await ready;
    for (const entry of Object.values(engine.state.sessions))
      entry.messageCount = -1;
    await refresh();
    return engine.summary();
  });
  ctx.handle("savePlan", async (input) => {
    await ready;
    return engine.savePlan(input);
  });
}
