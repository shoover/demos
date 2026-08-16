/**
 * Unit tests for the pure graph binning in site/vanilla-2048/stats.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Game } from "../site/vanilla-2048/board.js";
import { MAX_BINS, binGame } from "../site/vanilla-2048/stats.js";

/** A timeline of `length` states, scoring `perMove` points a move from `firstMove`. */
function timeline(length, { firstMove = 0, perMove = 10 } = {}) {
  return Array.from({ length }, (unused, index) => ({
    moves: firstMove + index,
    score: index * perMove,
  }));
}

test("a short game is one bin per move", () => {
  const { bins, binWidth } = binGame(timeline(4), new Map());
  assert.equal(binWidth, 1);
  assert.deepEqual(
    bins.map((bin) => [bin.from, bin.to, bin.points]),
    [[0, 0, 0], [1, 1, 10], [2, 2, 20], [3, 3, 30]]
  );
});

test("a long game is binned down to the cap", () => {
  // A thousand states is the longest timeline the game keeps, and the cap has to hold
  // at that length rather than only at the lengths it was written against.
  const { bins, binWidth } = binGame(timeline(1000), new Map());
  assert.ok(bins.length <= MAX_BINS, `${bins.length} bins`);
  assert.equal(binWidth, 10);
  assert.deepEqual([bins[0].from, bins[0].to], [0, 9]);
  assert.deepEqual([bins.at(-1).from, bins.at(-1).to], [990, 999]);
});

test("bins are contiguous and cover the whole span exactly once", () => {
  for (const length of [1, 2, 99, 100, 101, 150, 999, 1000]) {
    const { bins, firstMove, lastMove } = binGame(timeline(length), new Map());
    assert.ok(bins.length <= MAX_BINS, `${length} states gave ${bins.length} bins`);
    assert.equal(firstMove, 0);
    assert.equal(lastMove, length - 1);
    assert.equal(bins[0].from, firstMove);
    assert.equal(bins.at(-1).to, lastMove);
    bins.forEach((bin, index) => {
      assert.ok(bin.from <= bin.to, `bin ${index} runs backwards`);
      if (index > 0) {
        assert.equal(bin.from, bins[index - 1].to + 1);
      }
    });
  }
});

test("the axis starts where a trimmed timeline starts", () => {
  const { bins, firstMove, lastMove } = binGame(
    timeline(3, { firstMove: 500 }),
    new Map()
  );
  assert.equal(firstMove, 500);
  assert.equal(lastMove, 502);
  assert.equal(bins[0].from, 500);
});

test("a bin carries the highest score inside it", () => {
  const { bins, maxPoints } = binGame(timeline(10, { perMove: 7 }), new Map(), 5);
  // Two moves a bin, and the second of each pair is the higher: points only ever climb.
  assert.deepEqual(bins.map((bin) => bin.points), [7, 21, 35, 49, 63]);
  assert.equal(maxPoints, 63);
});

test("a bin sums the undos inside it", () => {
  const undos = new Map([[1, 2], [2, 1], [9, 4]]);
  const { bins, maxUndos, totalUndos } = binGame(timeline(10), undos, 5);
  assert.deepEqual(bins.map((bin) => bin.undos), [2, 1, 0, 0, 4]);
  assert.equal(maxUndos, 4);
  assert.equal(totalUndos, 7);
});

test("a game with no undos has no bars", () => {
  const { bins, maxUndos, totalUndos } = binGame(timeline(20), new Map());
  assert.equal(maxUndos, 0);
  assert.equal(totalUndos, 0);
  assert.ok(bins.every((bin) => bin.undos === 0));
});

test("an opening board is a single bin worth nothing", () => {
  const { bins, firstMove, lastMove, maxPoints } = binGame(timeline(1), new Map());
  assert.equal(bins.length, 1);
  assert.deepEqual([firstMove, lastMove], [0, 0]);
  assert.equal(maxPoints, 0);
});

test("a game graphs itself as it was played", () => {
  const game = new Game({ random: () => 0.5 });
  game.reset();
  for (const direction of ["left", "down", "right", "up", "left"]) {
    game.move(direction);
  }
  game.playFrom(3);

  const { bins, firstMove, lastMove, maxPoints, totalUndos } = binGame(
    game.timeline,
    game.undos
  );
  assert.equal(firstMove, 0);
  assert.equal(lastMove, game.moves);
  assert.equal(maxPoints, game.score);
  // One undo, against the state it resumed at, whatever it reached back over.
  assert.equal(totalUndos, 1);
  assert.equal(bins.at(-1).undos, 1);
});

test("an empty timeline is a bug rather than an empty graph", () => {
  assert.throws(() => binGame([], new Map()), /empty/);
});

test("a tally outside the timeline is a bug rather than a bar to place", () => {
  assert.throws(() => binGame(timeline(4), new Map([[9, 1]])), /outside/);
});

test("a bin count that cannot be binned to is refused", () => {
  for (const bins of [0, -1, 1.5]) {
    assert.throws(() => binGame(timeline(4), new Map(), bins), /bin count/);
  }
});
