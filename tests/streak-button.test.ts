import { test } from "node:test";
import assert from "node:assert/strict";
import { flameIcon, shouldAnimate, streakLabel } from "../src/main.ts";

test("streak label", () => {
  assert.equal(streakLabel(0), "Start a streak");
  assert.equal(streakLabel(1), "1-day streak");
  assert.equal(streakLabel(12), "12-day streak");
});

test("animates only when the streak improves, never on first show", () => {
  assert.equal(shouldAnimate(undefined, { run: 5, done: true }), false);
  assert.equal(
    shouldAnimate({ run: 4, done: false }, { run: 5, done: true }),
    true,
  );
  assert.equal(
    shouldAnimate({ run: 5, done: false }, { run: 5, done: true }),
    true,
  );
  assert.equal(
    shouldAnimate({ run: 5, done: true }, { run: 5, done: true }),
    false,
  );
  assert.equal(
    shouldAnimate({ run: 5, done: true }, { run: 0, done: false }),
    false,
  );
  assert.equal(
    shouldAnimate({ run: 5, done: true }, { run: 5, done: false }),
    false,
  );
});

test("icon: filled when done, outlined when open, animation markup only when animating", () => {
  assert.match(flameIcon(true, false), /fill="#f97316"/);
  assert.match(flameIcon(false, false), /fill="none" stroke="currentColor"/);
  assert.doesNotMatch(flameIcon(true, false), /<style|lhgam-anim/);
  const animated = flameIcon(true, true);
  assert.match(animated, /class="lhgam-anim"/);
  assert.match(animated, /prefers-reduced-motion/);
  assert.notEqual(
    flameIcon(true, true),
    flameIcon(true, false),
    "markup changes so the host re-inserts the icon",
  );
});
