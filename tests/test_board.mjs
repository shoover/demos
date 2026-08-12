/**
 * Unit tests for the pure 2048 rules in site/vanilla-2048/board.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  Game,
  SIZE,
  STATE_VERSION,
  SaveError,
  boardCanMove,
  compressAndMerge,
  decodeSavedState,
  emptyCells,
  lineCoordinates,
} from "../site/vanilla-2048/board.js";

const HUGE_BEST = 10 ** 9;

/** Spawns the first empty cell in row-major order, always a 2. */
const fixedRandom = () => 0;

/** A Game with deterministic spawns, optionally starting from a fixed board. */
function newGame(cells = null, best = HUGE_BEST) {
  // 0 picks the first empty cell but would also roll a 4, so the value roll is
  // answered separately: cell choice first, then the spawn value.
  let call = 0;
  const game = new Game({
    best,
    random: () => (call++ % 2 === 0 ? 0 : 0.99),
  });
  if (cells !== null) {
    game.cells = cells.map((row) => row.slice());
  }
  return game;
}

function encoded(overrides = {}) {
  return JSON.stringify({
    version: STATE_VERSION,
    board: [
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 100,
    moves: 7,
    game_over: false,
    play_seconds: 12.5,
    ...overrides,
  });
}

test("a line collapses toward index 0", () => {
  const { merged, gained } = compressAndMerge([0, 2, 0, 2]);
  assert.deepEqual(merged, [4, 0, 0, 0]);
  assert.equal(gained, 4);
});

test("only the leading pair of a run merges", () => {
  const { merged, mergePositions, gained } = compressAndMerge([2, 2, 2, 0]);
  assert.deepEqual(merged, [4, 2, 0, 0]);
  assert.deepEqual([...mergePositions], [0]);
  assert.equal(gained, 4);
});

test("equal pairs merge separately rather than into one tile", () => {
  const { merged, mergePositions, gained } = compressAndMerge([2, 2, 2, 2]);
  assert.deepEqual(merged, [4, 4, 0, 0]);
  assert.deepEqual([...mergePositions].sort(), [0, 1]);
  assert.equal(gained, 8);
});

test("a merged tile does not merge again in the same move", () => {
  const { merged, gained } = compressAndMerge([4, 2, 2, 0]);
  assert.deepEqual(merged, [4, 4, 0, 0]);
  assert.equal(gained, 4);
});

test("sources name the input tiles behind each output tile", () => {
  const { sources } = compressAndMerge([0, 2, 2, 8]);
  assert.deepEqual(sources, [[1, 2], [3]]);
});

test("every direction covers the board exactly once", () => {
  for (const direction of ["up", "down", "left", "right"]) {
    const cells = lineCoordinates(direction).flat();
    assert.deepEqual([...cells].sort((a, b) => a - b), [...Array(SIZE * SIZE).keys()]);
  }
});

test("each line is ordered from the edge tiles collapse toward", () => {
  assert.deepEqual(lineCoordinates("left")[0], [0, 1, 2, 3]);
  assert.deepEqual(lineCoordinates("right")[0], [3, 2, 1, 0]);
  assert.deepEqual(lineCoordinates("up")[0], [0, 4, 8, 12]);
  assert.deepEqual(lineCoordinates("down")[0], [12, 8, 4, 0]);
});

test("a move slides, merges, scores, and spawns", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const result = game.move("left");

  assert.equal(game.cells[0][0], 4);
  assert.equal(game.score, 4);
  assert.equal(game.moves, 1);
  assert.deepEqual([...result.mergedCells], [0]);
  assert.equal(result.gained, 4);
  // The two source tiles travel to the merged cell; the spawn lands elsewhere.
  assert.deepEqual(
    result.slidingTiles.map(({ value, from, to }) => [value, from, to]),
    [[2, 0, 0], [2, 1, 0]]
  );
  assert.equal(emptyCells(game.cells).length, SIZE * SIZE - 2);
});

test("a move that changes nothing is rejected", () => {
  const game = newGame([
    [2, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(game.move("left"), null);
  assert.equal(game.moves, 0);
});

test("a move is rejected once the game is over", () => {
  const game = newGame([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  game.gameOver = true;
  assert.equal(game.move("left"), null);
});

test("the best score follows the score and reports the change", () => {
  const pair = [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const fresh = newGame(pair, 0);
  assert.equal(fresh.move("left").bestChanged, true);
  assert.equal(fresh.best, 4);

  const behind = newGame(pair, 10);
  assert.equal(behind.move("left").bestChanged, false);
  assert.equal(behind.best, 10);
});

test("filling the last cell ends the game", () => {
  const game = newGame([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [0, 4, 2, 4],
  ]);
  // The move frees nothing, and the tile it spawns fills the hole it left behind.
  assert.notEqual(game.move("left"), null);
  assert.equal(emptyCells(game.cells).length, 0);
  assert.equal(game.gameOver, true);
});

test("a new game starts from two tiles", () => {
  const game = newGame();
  const spawned = game.reset();
  assert.equal(spawned.length, 2);
  assert.equal(emptyCells(game.cells).length, SIZE * SIZE - 2);
  assert.equal(game.score, 0);
  assert.equal(game.moves, 0);
  assert.equal(game.gameOver, false);
});

test("spawns land on empty cells and are always 2 or 4", () => {
  const game = new Game();
  for (let round = 0; round < 200; round += 1) {
    game.reset();
    const spawned = game.cells.flat().filter(Boolean);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned.filter((value) => value !== 2 && value !== 4), []);
  }
});

test("a full board with no equal neighbours cannot move", () => {
  assert.equal(
    boardCanMove([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]),
    false
  );
  assert.equal(
    boardCanMove([
      [2, 2, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]),
    true
  );
});

test("a round trip through the save format preserves the game", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  game.move("left");
  const saved = decodeSavedState(game.encode(9.5), game.best);
  assert.deepEqual(saved.cells, game.cells);
  assert.equal(saved.score, game.score);
  assert.equal(saved.moves, game.moves);
  assert.equal(saved.gameOver, game.gameOver);
  assert.equal(saved.playSeconds, 9.5);
});

test("an interrupted write is rejected rather than half-read", () => {
  assert.throws(() => decodeSavedState(encoded().slice(0, 20), HUGE_BEST), SaveError);
});

for (const [name, overrides] of [
  ["an unknown version", { version: 99 }],
  ["a short board", { board: [[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a non-power-of-two tile", { board: [[3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a fractional tile", { board: [[2.5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a negative score", { score: -1 }],
  ["a fractional move count", { moves: 1.5 }],
  ["a non-boolean game-over flag", { game_over: "yes" }],
  ["a negative play time", { play_seconds: -1 }],
  ["an infinite play time", { play_seconds: null }],
  ["a game-over flag the board contradicts", { game_over: true }],
]) {
  test(`${name} is rejected`, () => {
    assert.throws(() => decodeSavedState(encoded(overrides), HUGE_BEST), SaveError);
  });
}

test("a score beyond the best score ever recorded is rejected", () => {
  assert.throws(() => decodeSavedState(encoded({ score: 101 }), 100), SaveError);
  assert.doesNotThrow(() => decodeSavedState(encoded({ score: 100 }), 100));
});

test("a negative best score is rejected", () => {
  assert.throws(() => new Game({ best: -1 }), SaveError);
});
