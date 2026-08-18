/**
 * Unit tests for the pure formatting helpers in site/vanilla-2048/format.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  abbreviate,
  count,
  formatDuration,
  scoreLine,
  scoreTitle,
} from "../site/vanilla-2048/format.js";

test("count groups digits with commas", () => {
  assert.equal(count(0), "0");
  assert.equal(count(999), "999");
  assert.equal(count(9999999), "9,999,999");
});

for (const [value, expected] of [
  [0, "0"],
  [999, "999"],
  [1000, "1k"],
  [10096, "10.1k"],
  [10049, "10k"],
  [10050, "10.1k"],
  [999999, "1M"],
  [1234567, "1.2M"],
  [9999999, "10M"],
  [999999999, "1B"],
  [1000000000, "1B"],
]) {
  test(`abbreviate(${value}) is "${expected}"`, () => {
    assert.equal(abbreviate(value), expected);
  });
}

test("abbreviate never grows longer once a unit is reached", () => {
  // The score line's whole reason to abbreviate: nothing past 1000 should ever again
  // run longer than a small number of characters, however many digits it started with.
  for (const value of [1000, 999999, 1000000, 999999999, 1000000000]) {
    assert.ok(abbreviate(value).length <= 5, `${value} -> ${abbreviate(value)}`);
  }
});

for (const [seconds, expected] of [
  [0, "0:00"],
  [45, "0:45"],
  [59, "0:59"],
  [60, "1:00"],
  [184, "3:04"],
  [59.9, "0:59"], // fractional playSeconds floors, so this doesn't tick over to 1:00 early
  [90.6, "1:30"],
  [3540, "59:00"],
  [3599, "59:59"],
  [3600, "1:00:00"], // the hour appears once there is one, not as a leading "0:"
  [12345, "3:25:45"],
  [86399, "23:59:59"],
  [86400, "24:00:00"], // hours keep counting up rather than rolling over into days
]) {
  test(`formatDuration(${seconds}) is "${expected}"`, () => {
    assert.equal(formatDuration(seconds), expected);
  });
}

/* The score line ------------------------------------------------------------ */

/** A game as the two formatters read it: every figure they name, and nothing else. */
const reading = (overrides = {}) => ({
  score: 3128,
  topTile: 256,
  replayed: false,
  replayedFrom: null,
  best: 12040,
  bestTile: 1024,
  replayedBest: 0,
  replayedBestTile: 0,
  ...overrides,
});

test("the score line pairs each score with the tile it was reached on", () => {
  assert.equal(scoreLine(reading()), "Score: 3.1k\u00b7256 | Best: 12k\u00b71024");
});

test("the score line prints tiles whole while abbreviating the scores beside them", () => {
  // 2048 is the name of the game, not "2k", and a tile is four digits at the very most.
  assert.equal(
    scoreLine(reading({ score: 205000, topTile: 2048, best: 205000, bestTile: 2048 })),
    "Score: 205k\u00b72048 | Best: 205k\u00b72048"
  );
});

test("a replayed game is marked once, after the pair it belongs to", () => {
  assert.equal(
    scoreLine(reading({ replayed: true, replayedFrom: 84, replayedBest: 9000, replayedBestTile: 512 })),
    "Score: 3.1k\u00b7256* | Best: 12k\u00b71024 (9k\u00b7512*)"
  );
});

test("the replayed track is a pair like every other figure on the line", () => {
  // The bracket holds a game, and a game is a score and the tile it got there on. A bare
  // score in it would be the one figure on the line meaning something other than what
  // the figure beside it means.
  const line = scoreLine(
    reading({ replayed: true, replayedFrom: 84, replayedBest: 9000, replayedBestTile: 512 })
  );
  assert.equal(line.match(/\u00b7/g).length, 3);
});

test("a player who has never taken a move back sees no bracket", () => {
  assert.ok(!scoreLine(reading()).includes("("));
});

test("the score line stays inside the width a phone gives it", () => {
  // The line must never wrap: the board is sized from what a two-line header leaves
  // over, so a third row is a board that no longer fits. The worst case a save can hold
  // is every figure at its longest, and it measured 300px of the 330px a 360px phone
  // leaves for text -- 48 characters in the panel's face, which is what is checked here.
  // A 320px screen leaves 290px, which is what the second type step in the stylesheet
  // is for; this bound is the 360px one.
  const worst = scoreLine(
    reading({
      score: 99999999,
      topTile: 8192,
      replayed: true,
      best: 99999999,
      bestTile: 8192,
      replayedBest: 99999999,
      replayedBestTile: 8192,
    })
  );
  assert.ok(worst.length <= 50, `${worst.length} chars: ${worst}`);
});

test("the hover title spells out everything the line abbreviates", () => {
  assert.equal(
    scoreTitle(reading({ replayed: true, replayedFrom: 84, replayedBest: 9000, replayedBestTile: 512 })),
    "Score: 3,128 (top tile 256, played on from move 84) | " +
      "Best: 12,040 (top tile 1024) | Replayed best: 9,000 (top tile 512)"
  );
});

test("the hover title names no replayed track until there is one", () => {
  assert.equal(
    scoreTitle(reading()),
    "Score: 3,128 (top tile 256) | Best: 12,040 (top tile 1024)"
  );
});
