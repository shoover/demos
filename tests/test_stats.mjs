/**
 * Unit tests for the pure graph binning in site/vanilla-2048/stats.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Game, TIMELINE_LIMIT } from "../site/vanilla-2048/board.js";
import { MAX_BINS, binGame } from "../site/vanilla-2048/stats.js";

/**
 * A timeline of `length` states, scoring `perMove` points a move from `firstMove`.
 *
 * `undos` maps a move to the count on that state, for the tests that are about the bars.
 */
function timeline(length, { firstMove = 0, perMove = 10, undos = new Map() } = {}) {
  return Array.from({ length }, (unused, index) => ({
    moves: firstMove + index,
    score: index * perMove,
    undos: undos.get(firstMove + index) ?? 0,
  }));
}

test("a short game is one bin per move", () => {
  const { bins, binWidth } = binGame(timeline(4));
  assert.equal(binWidth, 1);
  assert.deepEqual(
    bins.map((bin) => [bin.from, bin.to, bin.points]),
    [[0, 0, 0], [1, 1, 10], [2, 2, 20], [3, 3, 30]]
  );
});

test("a bin gains what was scored inside it", () => {
  // Ten points a move, four moves to a bin, so every bin past the first is worth forty.
  // The first is worth thirty: it holds the opening state, which gained nothing because
  // nothing came before it.
  const { bins, maxGained } = binGame(timeline(12), 3);
  assert.deepEqual(bins.map((bin) => bin.gained), [30, 40, 40]);
  assert.equal(maxGained, 40);
});

test("the gains add up to the score the game reached", () => {
  // The two series are two readings of one set of figures, so the last total and the
  // sum of the gains are the same number. A gains series that drifts from the line
  // above it is drawing a different game.
  const states = timeline(60, { perMove: 7 });
  const { bins, maxPoints } = binGame(states, 9);
  assert.equal(bins.reduce((sum, bin) => sum + bin.gained, 0), maxPoints);
});

test("a bin that scored nothing gains nothing", () => {
  // A stretch of moves that shifted tiles without merging any: the total holds level
  // and the gains lane is empty under it, which is the pair saying the same thing.
  const states = [0, 10, 20, 20, 20, 20, 30, 40].map((score, moves) => ({
    moves, score, undos: 0,
  }));
  const { bins } = binGame(states, 4);
  assert.deepEqual(bins.map((bin) => bin.gained), [10, 10, 0, 20]);
  assert.deepEqual(bins.map((bin) => bin.points), [10, 20, 20, 40]);
});

test("a game worth nothing has no scale in either points lane", () => {
  const { maxPoints, maxGained } = binGame(timeline(6, { perMove: 0 }));
  assert.equal(maxPoints, 0);
  assert.equal(maxGained, 0);
});

test("a long game is binned down to the cap", () => {
  // A thousand states is the longest timeline the game keeps, and the cap has to hold
  // at that length rather than only at the lengths it was written against.
  const { bins, binWidth } = binGame(timeline(1000));
  assert.ok(bins.length <= MAX_BINS, `${bins.length} bins`);
  assert.equal(binWidth, 10);
  assert.deepEqual([bins[0].from, bins[0].to], [0, 9]);
  assert.deepEqual([bins.at(-1).from, bins.at(-1).to], [990, 999]);
});

test("bins are contiguous and cover the whole span exactly once", () => {
  for (const length of [1, 2, 99, 100, 101, 150, 999, 1000]) {
    const { bins, firstMove, lastMove } = binGame(timeline(length));
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
  const { bins, firstMove, lastMove } = binGame(timeline(3, { firstMove: 500 }));
  assert.equal(firstMove, 500);
  assert.equal(lastMove, 502);
  assert.equal(bins[0].from, 500);
});

test("a bin carries the highest score inside it", () => {
  const { bins, maxPoints } = binGame(timeline(10, { perMove: 7 }), 5);
  // Two moves a bin, and the second of each pair is the higher: points only ever climb.
  assert.deepEqual(bins.map((bin) => bin.points), [7, 21, 35, 49, 63]);
  assert.equal(maxPoints, 63);
});

test("a bin sums the undos inside it", () => {
  const undos = new Map([[1, 2], [2, 1], [9, 4]]);
  const { bins, maxUndos, totalUndos } = binGame(timeline(10, { undos }), 5);
  assert.deepEqual(bins.map((bin) => bin.undos), [2, 1, 0, 0, 4]);
  assert.equal(maxUndos, 4);
  assert.equal(totalUndos, 7);
});

test("a game with no undos has no bars", () => {
  const { bins, maxUndos, totalUndos } = binGame(timeline(20));
  assert.equal(maxUndos, 0);
  assert.equal(totalUndos, 0);
  assert.ok(bins.every((bin) => bin.undos === 0));
});

test("an opening board is a single bin worth nothing", () => {
  const { bins, firstMove, lastMove, maxPoints } = binGame(timeline(1));
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

  // The history rather than the timeline: the timeline is capped, so it is the history
  // that is the whole game, and the undo tallies live there with it.
  const { bins, firstMove, lastMove, maxPoints, totalUndos } = binGame(game.history);
  assert.equal(firstMove, 0);
  assert.equal(lastMove, game.moves);
  assert.equal(maxPoints, game.score);
  // One undo, against the state it resumed at, whatever it reached back over.
  assert.equal(totalUndos, 1);
  assert.equal(bins.at(-1).undos, 1);
});

test("a game past the timeline cap still graphs from its first move", () => {
  const game = new Game({ random: () => 0.5 });
  game.reset();
  for (let move = 0; move < TIMELINE_LIMIT + 200; move += 1) {
    game.score += 4;
    game.moves += 1;
    game.record();
  }

  // The timeline has long since trimmed its opening, and the graph is drawn from the
  // history, so the axis still starts where the game did.
  assert.ok(game.timeline[0].moves > 0, "the timeline has trimmed");
  const { firstMove, lastMove, maxPoints } = binGame(game.history);
  assert.equal(firstMove, 0);
  assert.equal(lastMove, game.moves);
  assert.equal(maxPoints, game.score);
});

test("an empty history is a bug rather than an empty graph", () => {
  assert.throws(() => binGame([]), /empty/);
});

test("a bin count that cannot be binned to is refused", () => {
  for (const bins of [0, -1, 1.5]) {
    assert.throws(() => binGame(timeline(4), bins), /bin count/);
  }
});
