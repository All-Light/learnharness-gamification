# Gamification plugin for LearnHarness

Helps you come back to learning consistently, even when the questions are hard:

- **Learning streak with rest days.** Any day with at least one answered question or
  practice attempt is a learning day. A missed day is covered automatically by a rest
  day (1 per week by default), and your total learning days never reset. After a break
  you get a fresh start, never a "you lost your streak" message.
- **Progress view** (click the streak button in the sidebar or a lesson's top bar):
  today's status, your current run, a
  four-week calendar, and recent wins from your own work, such as challenging questions
  you stuck with and confident mistakes you corrected.
- **Feedback guidance in lessons.** The tutor is told to name what was right in your
  reasoning before correcting the rest, to say plainly that misses on hard questions are
  expected, and to point out that confidently held mistakes are corrected especially
  well. The tutor is not told your streak; on a day you reach a milestone it only
  receives the milestone's ID (for example `run-7`) so it can show the card. During the
  assessment (probe) phase the guidance is just one line: missed questions are expected. This works
  within LearnHarness's own voice rules (no praise, wrong answers named plainly), which
  match the research: specific feedback about the task beats praise. Celebration lives
  in the plugin's UI instead: the streak flame in the sidebar and lesson top bar, and
  milestone cards (3, 7, 14, 30… days in a row, total learning days, your best week,
  coming back after a break) shown in the lesson.
- **Study plan and calendar reminder.** "After ___, I will study for ___ minutes at ___"
  becomes a repeating `.ics` reminder for your own calendar, which works even when
  LearnHarness is closed.

No points, no leaderboards, no ability scores.

## Why it is built this way

- Gamification has small positive effects on learning, motivation and behavior on
  average, and design decides whether it helps: rewards that are not feedback (points,
  leaderboards) can undermine intrinsic motivation
  ([Sailer & Homner 2020](https://doi.org/10.1007/s10648-019-09498-w)).
- Showing an intact streak increases re-engagement and showing a broken one reduces it;
  the drop is smaller when a streak can be protected or repaired
  ([Silverman & Barasch 2023](https://doi.org/10.1093/jcr/ucac029)). Hence rest days and
  no broken-streak messages.
- Single missed days did not hurt habit formation (Lally et al. 2010), and people restart
  goals at "fresh starts" like a new week
  ([Dai, Milkman & Riis 2014](https://doi.org/10.1287/mnsc.2014.1901)).
- Feedback about the task and process works better than praise about the person, which
  often does nothing or harms performance (Kluger & DeNisi 1996; Hattie & Timperley 2007).
  Process praise beats ability praise only slightly, too much praise backfires, and
  growth-mindset effects are small; so the tutor's feedback is informational, not praise.
- Errors made with high confidence are corrected especially well (the hypercorrection
  effect), so the tutor says so when it happens.
- If-then study plans ("implementation intentions") are among the best-replicated
  behavior-change techniques; the calendar reminder carries your own plan.

## Updates

The plugin's settings page has an **Updates** section. When you open it (at most once a
day), or when you click **Check for updates**, it asks GitHub
(`github.com/All-Light/learnharness-gamification`) for the latest release. Nothing is
installed until you click **Install update**. The release must be signed with this
plugin's own key (a release signed with another key, even one of the maintainer's other
plugins, is rejected), must be newer, and must match its signed checksum and layout. The
current version is kept as `gamification/dist.previous/`; your `data/` folder is not
touched. Restart LearnHarness to load the update; **Roll back to previous version**
restores the earlier copy. If an update stops the plugin from loading, close
LearnHarness and rename `gamification/dist.previous` back to `gamification/dist`.

Plugins cannot read LearnHarness's version. If an update needs a newer LearnHarness than
the installed plugin did, you are asked to confirm you have it before it installs; an
older app could not load it.

Updates only work when the GitHub repository is public: the plugin downloads releases
without signing in. Development builds never self-update: builds installed with
`npm run install:local` are marked as such, and so is a plugin folder containing
`package.json`, `src` or `.git`.

## Data

In the plugin's `data/` folder: `state.json` (dates of learning events, whether a
question was challenging or a confident mistake, a short question excerpt, milestones,
settings, your study plan) and `study-reminder.ics`. Your written thinking is never
stored, and neither are session titles. If you delete a session, its learning days
still count but its excerpts are removed. The plugin only reads your sessions; it never changes them.

## Settings

Rest days per week (0, 1 or 2), feedback guidance in lessons on/off, milestone cards
on/off, re-scan learning history, and updates.

## Limits

- The tutor follows the feedback guidance and milestone cards most of the time, not
  always. Streak counting itself is exact.
- LearnHarness plugins cannot show notifications; the calendar reminder is the only
  nudge while the app is closed.

## Development

```sh
npm ci
npm run sdk -- ../../learnharness
npm run typecheck && npm test
npm run install:local -- ../../learnharness/data/plugins   # then restart LearnHarness
```

### Publishing a release

1. Once: `npm run keygen` creates this plugin's signing key at
   `~/.config/learnharness-gamification/signing-key.pem` and writes its public key to
   `src/update-key.ts`. Back it up and never commit it; losing it means installed copies
   reject updates until reinstalled manually.
2. Bump `version` in `manifest.json` and `package.json`.
3. `npm run release -- --notes "What changed"` writes `gamification-<version>.zip`,
   `latest.json` and `latest.json.sig` to `release/` (it refuses to sign with a key that
   does not match `src/update-key.ts`).
4. Publish them: `gh release create v<version> -R All-Light/learnharness-gamification release/*`.

## License

Third-party code bundled into the plugin is listed with its license in `dist/licenses/`
(fflate, MIT).


AGPL-3.0-only, the same license as LearnHarness. See [LICENSE](LICENSE).
