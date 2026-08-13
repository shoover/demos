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
  LEGACY_STATE_VERSION,
  SIZE,
  STATE_VERSION,
  SaveError,
  TIMELINE_LIMIT,
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
    // The fixed board is where this game starts, so it is where its timeline starts:
    // the state recorded at construction was of the empty board it replaced.
    game.timeline = [];
    game.record();
  }
  return game;
}

/** One stored state, in the shape the save format writes it. */
function savedState(overrides = {}) {
  return {
    board: [
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    score: 100,
    moves: 7,
    game_over: false,
    ...overrides,
  };
}

/** A whole save, holding a one-state timeline unless told otherwise. */
function encoded(overrides = {}) {
  return JSON.stringify({
    version: STATE_VERSION,
    timeline: [savedState()],
    cursor: 0,
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

/* Time travel --------------------------------------------------------------- */

test("a new game starts a timeline holding just its opening board", () => {
  const game = newGame();
  game.reset();
  assert.equal(game.timeline.length, 1);
  assert.equal(game.cursor, 0);
  assert.equal(game.atLatest, true);
  assert.deepEqual(game.timeline[0].cells, game.cells);
});

test("every move is recorded, and the cursor follows the newest state", () => {
  const game = newGame();
  game.reset();
  for (const direction of ["left", "down", "right", "up"]) {
    game.move(direction);
  }
  assert.equal(game.timeline.length, 5);
  assert.equal(game.cursor, 4);
  assert.deepEqual(
    game.timeline.map((state) => state.moves),
    [0, 1, 2, 3, 4]
  );
});

test("a move that is refused is not recorded", () => {
  const game = newGame([
    [2, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const length = game.timeline.length;
  assert.equal(game.move("left"), null);
  assert.equal(game.timeline.length, length);
});

test("a recorded state is not disturbed by the moves that follow it", () => {
  const game = newGame();
  game.reset();
  const opening = game.timeline[0].cells.map((row) => row.slice());
  game.move("left");
  game.move("down");
  assert.deepEqual(game.timeline[0].cells, opening);
});

test("seeking shows an earlier board and its score", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const before = game.cells.map((row) => row.slice());
  game.move("left");
  const after = game.cells.map((row) => row.slice());

  assert.equal(game.seek(0), 0);
  assert.deepEqual(game.cells, before);
  assert.equal(game.score, 0);
  assert.equal(game.moves, 0);
  assert.equal(game.atLatest, false);

  assert.equal(game.seek(1), 1);
  assert.deepEqual(game.cells, after);
  assert.equal(game.score, 4);
  assert.equal(game.atLatest, true);
});

test("each state records the move that led to it", () => {
  const game = newGame();
  game.reset();
  for (const direction of ["left", "down", "right", "up"]) {
    game.move(direction);
  }
  assert.deepEqual(
    game.timeline.map((state) => state.direction),
    [null, "left", "down", "right", "up"]
  );
});

test("the next move is the one played from the state on screen", () => {
  const game = newGame();
  game.reset();
  game.move("left");
  game.move("down");

  game.seek(0);
  assert.equal(game.nextDirection, "left");
  game.seek(1);
  assert.equal(game.nextDirection, "down");
  // Nothing has been played from the newest state yet.
  game.seek(2);
  assert.equal(game.nextDirection, null);
});

test("a new game has no move to show on its opening board", () => {
  const game = newGame();
  game.reset();
  assert.equal(game.timeline[0].direction, null);
  assert.equal(game.nextDirection, null);
});

test("seeking past either end of the timeline lands on the end", () => {
  const game = newGame();
  game.reset();
  game.move("left");
  assert.equal(game.seek(-5), 0);
  assert.equal(game.seek(99), game.timeline.length - 1);
});

test("only the latest state can be played, and seeking back to it restores play", () => {
  const game = newGame();
  game.reset();
  game.move("left");
  game.seek(0);

  assert.equal(game.move("down"), null);
  assert.equal(game.timeline.length, 2);
  assert.equal(game.moves, 0);

  game.seek(1);
  assert.notEqual(game.move("down"), null);
  assert.equal(game.timeline.length, 3);
});

test("the board seeked to is a copy, so playing on cannot rewrite history", () => {
  const game = newGame();
  game.reset();
  game.move("left");
  const recorded = game.timeline[1].cells.map((row) => row.slice());
  game.seek(1);
  game.move("down");
  assert.deepEqual(game.timeline[1].cells, recorded);
});

test("the timeline drops its oldest states rather than growing without limit", () => {
  const game = newGame();
  game.reset();
  // Recorded directly: a game long enough to reach the limit cannot be played out
  // against a spawn that always fills the first empty cell.
  for (let extra = 0; extra < TIMELINE_LIMIT + 10; extra += 1) {
    game.moves += 1;
    game.record();
  }
  assert.equal(game.timeline.length, TIMELINE_LIMIT);
  assert.equal(game.atLatest, true);
  assert.equal(game.timeline.at(-1).moves, game.moves);
  assert.equal(game.timeline[0].moves, game.moves - (TIMELINE_LIMIT - 1));
});

/* Saving -------------------------------------------------------------------- */

test("a round trip through the save format preserves the game", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  game.move("left");
  const saved = decodeSavedState(game.encode(9.5), game.best);
  assert.equal(saved.timeline.length, game.timeline.length);
  assert.deepEqual(saved.timeline, game.timeline);
  assert.equal(saved.cursor, game.cursor);
  assert.equal(saved.playSeconds, 9.5);
});

test("a restored game comes back on the state it was left on", () => {
  const played = newGame();
  played.reset();
  for (const direction of ["left", "down", "right", "up"]) {
    played.move(direction);
  }
  played.seek(2);

  const restored = newGame();
  restored.restore(decodeSavedState(played.encode(3), played.best));
  assert.equal(restored.cursor, played.cursor);
  assert.deepEqual(restored.timeline, played.timeline);
  assert.equal(restored.nextDirection, played.nextDirection);
  assert.deepEqual(restored.cells, played.cells);
  assert.equal(restored.score, played.score);
  assert.equal(restored.moves, played.moves);
  assert.equal(restored.atLatest, false);
});

test("an interrupted write is rejected rather than half-read", () => {
  assert.throws(() => decodeSavedState(encoded().slice(0, 20), HUGE_BEST), SaveError);
});

for (const [name, overrides] of [
  ["an unknown version", { version: 99 }],
  ["a negative play time", { play_seconds: -1 }],
  ["an infinite play time", { play_seconds: null }],
  ["a missing timeline", { timeline: undefined }],
  ["an empty timeline", { timeline: [] }],
  ["a timeline that is not a list", { timeline: { 0: savedState() } }],
  ["a state that is not an object", { timeline: [null] }],
  ["a fractional cursor", { cursor: 0.5 }],
  ["a negative cursor", { cursor: -1 }],
  ["a cursor past the end of the timeline", { cursor: 1 }],
]) {
  test(`${name} is rejected`, () => {
    assert.throws(() => decodeSavedState(encoded(overrides), HUGE_BEST), SaveError);
  });
}

for (const [name, overrides] of [
  ["a short board", { board: [[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a non-power-of-two tile", { board: [[3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a fractional tile", { board: [[2.5, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }],
  ["a negative score", { score: -1 }],
  ["a fractional move count", { moves: 1.5 }],
  ["a non-boolean game-over flag", { game_over: "yes" }],
  ["a game-over flag the board contradicts", { game_over: true }],
]) {
  test(`a state with ${name} is rejected`, () => {
    assert.throws(
      () => decodeSavedState(encoded({ timeline: [savedState(overrides)] }), HUGE_BEST),
      SaveError
    );
  });
}

test("a timeline that does not run one move forward at a time is rejected", () => {
  const skips = [savedState(), savedState({ moves: 9, score: 120 })];
  assert.throws(() => decodeSavedState(encoded({ timeline: skips }), HUGE_BEST), SaveError);

  const loses = [savedState(), savedState({ moves: 8, score: 99 })];
  assert.throws(() => decodeSavedState(encoded({ timeline: loses }), HUGE_BEST), SaveError);

  const runs = [savedState(), savedState({ moves: 8, score: 120 })];
  assert.doesNotThrow(() => decodeSavedState(encoded({ timeline: runs }), HUGE_BEST));
});

test("a score beyond the best score ever recorded is rejected", () => {
  const scored = (score) => encoded({ timeline: [savedState({ score })] });
  assert.throws(() => decodeSavedState(scored(101), 100), SaveError);
  assert.doesNotThrow(() => decodeSavedState(scored(100), 100));
});

test("a move direction that is not a direction is rejected", () => {
  const bogus = encoded({ timeline: [savedState({ direction: "sideways" })] });
  assert.throws(() => decodeSavedState(bogus, HUGE_BEST), SaveError);
});

test("a state saved without its move reads back with none", () => {
  // What a save written before moves were tracked holds, and what the oldest state of a
  // trimmed timeline holds: a state whose next move simply cannot be shown.
  const saved = decodeSavedState(encoded(), HUGE_BEST);
  assert.equal(saved.timeline[0].direction, null);

  const game = newGame();
  game.restore(saved);
  assert.equal(game.nextDirection, null);
  // And it survives a round trip rather than turning into something else.
  assert.equal(decodeSavedState(game.encode(1), game.best).timeline[0].direction, null);
});

test("a save from before time travel reads back as a one-state timeline", () => {
  // Version 1 kept the state at the top level and had no history to scrub.
  const legacy = JSON.stringify({
    version: LEGACY_STATE_VERSION,
    ...savedState(),
    play_seconds: 4.5,
  });
  const saved = decodeSavedState(legacy, HUGE_BEST);
  assert.equal(saved.timeline.length, 1);
  assert.equal(saved.cursor, 0);
  assert.equal(saved.timeline[0].moves, 7);
  assert.equal(saved.playSeconds, 4.5);

  const game = newGame();
  game.restore(saved);
  assert.equal(game.atLatest, true);
  assert.equal(game.moves, 7);
});

test("a negative best score is rejected", () => {
  assert.throws(() => new Game({ best: -1 }), SaveError);
});
