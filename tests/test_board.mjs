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
  TIMELINE_ONLY_STATE_VERSION,
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

/** Best scores that bound anything, for the cases that are not about the bounds. */
const BESTS = { best: HUGE_BEST, replayedBest: HUGE_BEST };

/** Every state's undo count, oldest first: the whole of what a graph would draw. */
const undosOf = (game) => game.history.map((entry) => entry.undos);

/** The bounds a game's own save has to be read back against. */
const bestsOf = (game) => ({ best: game.best, replayedBest: game.replayedBest });

/** Spawns the first empty cell in row-major order, always a 2. */
const fixedRandom = () => 0;

/** A Game with deterministic spawns, optionally starting from a fixed board. */
function newGame(cells = null, best = HUGE_BEST, bestTile = 0) {
  // 0 picks the first empty cell but would also roll a 4, so the value roll is
  // answered separately: cell choice first, then the spawn value.
  let call = 0;
  const game = new Game({
    best,
    bestTile,
    random: () => (call++ % 2 === 0 ? 0 : 0.99),
  });
  if (cells !== null) {
    game.cells = cells.map((row) => row.slice());
    // The fixed board is where this game starts, so it is where both of its records
    // start: what was taken down at construction was of the empty board it replaced.
    game.timeline = [];
    game.history = [];
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

/**
 * The history a timeline implies: the same scores, written as the gains between them.
 *
 * Derived rather than written out, so a fixture that overrides the timeline still saves
 * a history that agrees with it -- disagreeing is its own failure, and the tests about
 * that say so by overriding the history on purpose.
 */
function historyFor(timeline) {
  // The tests about a malformed timeline expect the timeline itself to be what is
  // rejected, so a fixture that carries one still needs a history to be attached --
  // any history, since decoding never reaches it.
  if (
    !Array.isArray(timeline) ||
    timeline.length === 0 ||
    timeline[0] === null ||
    typeof timeline[0] !== "object"
  ) {
    return { from: 0, score: 0, gains: [] };
  }
  return {
    from: timeline[0].moves,
    score: timeline[0].score,
    gains: timeline.slice(1).map((state, index) => state.score - timeline[index].score),
  };
}

/** A whole save, holding a one-state timeline unless told otherwise. */
function encoded(overrides = {}) {
  const timeline = overrides.timeline ?? [savedState()];
  return JSON.stringify({
    version: STATE_VERSION,
    timeline,
    history: historyFor(timeline),
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

test("a state names the cells its move merged into and spawned onto", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const result = game.move("left");
  const { merged, appeared } = game.arrival;
  assert.deepEqual([...merged], [...result.mergedCells]);
  assert.deepEqual([...appeared], [result.spawnedCell]);
});

test("what a state arrived with is worked out again rather than stored", () => {
  const played = newGame();
  played.reset();
  const results = ["left", "down", "right"].map((direction) => played.move(direction));

  // Through the save format, which carries boards and directions and nothing else.
  const restored = newGame();
  restored.restore(decodeSavedState(played.encode(1), bestsOf(played)));
  const sorted = (cells) => [...cells].sort((a, b) => a - b);
  results.forEach((result, index) => {
    assert.notEqual(result, null);
    restored.seek(index + 1);
    assert.deepEqual(sorted(restored.arrival.merged), sorted(result.mergedCells));
    assert.deepEqual([...restored.arrival.appeared], [result.spawnedCell]);
  });
});

test("a state with no move behind it arrived with nothing", () => {
  const game = newGame();
  game.reset();
  game.move("left");

  // The opening board of a game: two tiles that were placed rather than played to.
  game.seek(0);
  assert.deepEqual([...game.arrival.merged], []);
  assert.deepEqual([...game.arrival.appeared], []);

  // And a state whose move was dropped with the states before it, or never recorded.
  game.timeline[1].direction = null;
  game.seek(1);
  assert.deepEqual([...game.arrival.merged], []);
  assert.deepEqual([...game.arrival.appeared], []);
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

/* Playing on from an earlier state ------------------------------------------- */

/**
 * A game four moves deep, with the cursor left on the state after move two.
 *
 * Best starts at zero rather than out of reach, so the two tracks actually move as it
 * is played and can be read back afterwards.
 */
function replayable() {
  const game = newGame(null, 0);
  game.reset();
  for (const direction of ["left", "down", "right", "up"]) {
    game.move(direction);
  }
  game.seek(2);
  return game;
}

test("playing on from a state discards what the game had gone on to do", () => {
  const game = replayable();
  const board = game.cells.map((row) => row.slice());

  assert.equal(game.playFrom(2), 2);
  assert.equal(game.timeline.length, 3);
  assert.equal(game.atLatest, true);
  assert.equal(game.moves, 2);
  // The board is the one that was being looked at, not the one play had reached.
  assert.deepEqual(game.cells, board);
  assert.deepEqual(game.latest.cells, board);
});

test("a move played on from an earlier state extends the shortened history", () => {
  const game = replayable();
  game.playFrom(2);
  assert.notEqual(game.move("right"), null);

  assert.equal(game.timeline.length, 4);
  assert.equal(game.moves, 3);
  // Still one move apart and still running forward, which is all the save format asks.
  game.timeline.forEach((state, index) => {
    assert.equal(state.moves, index + game.timeline[0].moves);
  });
});

test("playing on from the newest state changes nothing", () => {
  const game = replayable();
  game.seek(4);
  assert.equal(game.playFrom(4), 0);
  assert.equal(game.timeline.length, 5);
  // And the game is not marked as replayed for a fork that never happened.
  assert.equal(game.replayed, false);
  assert.equal(game.replayedFrom, null);
});

test("a game remembers the move it was played on from", () => {
  const game = replayable();
  assert.equal(game.replayed, false);
  game.playFrom(2);
  assert.equal(game.replayed, true);
  assert.equal(game.replayedFrom, 2);

  // The most recent fork, not the first: it is what a reopened save has to describe.
  game.move("left");
  game.playFrom(1);
  assert.equal(game.replayedFrom, 1);
});

test("a new game is clean however the last one was played", () => {
  const game = replayable();
  game.playFrom(2);
  game.reset();
  assert.equal(game.replayed, false);
  assert.equal(game.replayedFrom, null);
});

test("taking back the losing move puts the game back in play", () => {
  const game = newGame([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [0, 4, 2, 4],
  ]);
  assert.notEqual(game.move("left"), null);
  assert.equal(game.gameOver, true);

  game.playFrom(game.cursor - 1);
  assert.equal(game.gameOver, false);
  assert.notEqual(game.move("left"), null);
});

test("undo is playing on from the state before this one", () => {
  const game = replayable();
  game.seek(4);
  assert.equal(game.playFrom(game.cursor - 1), 1);
  assert.equal(game.timeline.length, 4);
  assert.equal(game.atLatest, true);
});

/* Undo tallies ---------------------------------------------------------------- */

test("taking play back is tallied against the move it resumed at", () => {
  const game = replayable();
  game.playFrom(2);
  // One undo, however many moves it reached back over, against the state at move 2 --
  // which is a move the game still has, unlike the two that are now gone.
  assert.deepEqual(undosOf(game), [0, 0, 1]);
});

test("tallies count undos rather than the moves they take back", () => {
  const game = replayable();
  game.seek(4);
  game.playFrom(3);
  game.move("left");
  game.playFrom(3);
  assert.deepEqual(undosOf(game), [0, 0, 0, 2]);

  // A longer reach back takes those states with it, and their tallies come along: three
  // undos by now, and the state the game stands on is move 0. The fourth move it just
  // discarded does not make it four.
  game.move("down");
  game.playFrom(0);
  assert.deepEqual(undosOf(game), [3]);
});

test("taking back a state that was itself undone at keeps the count", () => {
  // Undo pressed twice in a row: the first press tallies against move 3, the second
  // takes move 3 back as well. Both presses are still counted, against the state the
  // game is left standing on -- the graph has no column for the one that has just gone.
  const game = replayable();
  game.seek(4);
  game.playFrom(3);
  game.playFrom(2);
  assert.deepEqual(undosOf(game), [0, 0, 2]);
});

test("playing on from the newest state tallies nothing", () => {
  const game = replayable();
  game.seek(4);
  assert.equal(game.playFrom(4), 0);
  assert.deepEqual(undosOf(game), [0, 0, 0, 0, 0]);
});

test("a new game starts with no undos", () => {
  const game = replayable();
  game.playFrom(2);
  game.reset();
  assert.deepEqual(undosOf(game), [0]);
});

test("tallies outlive the states they were counted against", () => {
  const game = replayable();
  game.playFrom(2);
  game.playFrom(1);
  assert.deepEqual(undosOf(game), [0, 2]);

  // Far enough for the trim to run past both. The tally belongs to the move, and the
  // history still has that move, so the graph still has a column to draw it in -- the
  // boards being gone only costs the scrubber its reach.
  for (let extra = 0; extra < TIMELINE_LIMIT + 10; extra += 1) {
    game.moves += 1;
    game.record();
  }
  assert.ok(game.timeline[0].moves > 1, "the timeline has trimmed past the tallied move");
  assert.equal(game.history[0].moves, 0, "the history still opens on the first move");
  assert.equal(game.history[1].undos, 2, "and still carries the count");
});

/* Best scores and tiles -------------------------------------------------------- */

test("a clean game scores into the clean best", () => {
  const game = newGame(null, 0);
  game.reset();
  game.move("left");
  assert.equal(game.best, game.score);
  assert.equal(game.replayedBest, 0);
});

test("the best score reached before a fork carries across to the replayed track", () => {
  const game = replayable();
  const reached = game.best;
  assert.ok(reached > 0);

  game.playFrom(2);
  // The points were really scored, before anything was rewritten: taking a move back
  // does not cost a total that had actually been reached.
  assert.equal(game.replayedBest, reached);
  assert.equal(game.best, reached);
});

test("a replayed game scores into the replayed best and leaves the clean one alone", () => {
  const game = replayable();
  const clean = game.best;
  game.playFrom(2);
  while (!game.gameOver && game.moves < 40) {
    for (const direction of ["left", "down", "right", "up"]) {
      game.move(direction);
    }
  }

  assert.equal(game.best, clean);
  assert.ok(game.replayedBest >= game.score);
  assert.ok(game.replayedBest > clean);
});

test("neither best score falls when history is discarded", () => {
  const game = replayable();
  game.seek(4);
  const [best, replayedBest] = [game.best, game.replayedBest];
  game.playFrom(0);
  assert.ok(game.score < best);
  assert.equal(game.best, best);
  assert.ok(game.replayedBest >= replayedBest);
});

test("the largest tile is the one on the state being looked at", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(game.topTile, 2);
  game.move("left");
  assert.equal(game.topTile, 4);

  // Scrubbing back reads the board it lands on, the same way the score does: what move 0
  // had reached, not what the game went on to.
  game.seek(0);
  assert.equal(game.topTile, 2);
});

test("a new largest tile raises the best tile and reports the change", () => {
  const game = newGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(game.bestTile, 0);
  assert.equal(game.move("left").bestTileChanged, true);
  assert.equal(game.bestTile, 4);

  // A game whose best tile is already past anything on this board raises nothing, however
  // the points go: the two figures are reported apart because they move apart.
  const behind = newGame(
    [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    0,
    1024
  );
  const result = behind.move("left");
  assert.equal(result.bestTileChanged, false);
  assert.equal(result.bestChanged, true);
  assert.equal(behind.bestTile, 1024);
});

test("the best tile reached before a fork carries across to the replayed track", () => {
  const game = replayable();
  const reached = game.bestTile;
  assert.ok(reached > 0);

  game.playFrom(2);
  // Landed before anything was rewritten, so taking a move back does not cost it.
  assert.equal(game.replayedBestTile, reached);
  assert.equal(game.bestTile, reached);
});

test("a replayed game raises the replayed best tile and leaves the clean one alone", () => {
  const game = replayable();
  const clean = game.bestTile;
  game.playFrom(2);
  while (!game.gameOver && game.moves < 60) {
    for (const direction of ["left", "down", "right", "up"]) {
      game.move(direction);
    }
  }

  assert.equal(game.bestTile, clean);
  assert.ok(game.replayedBestTile >= game.topTile);
  assert.ok(game.replayedBestTile > clean);
});

test("a stored best tile that no board could hold is rejected", () => {
  // A count can be any number; a tile cannot. 5 is corruption, not a low figure.
  assert.throws(() => new Game({ bestTile: 5 }), SaveError);
  assert.throws(() => new Game({ replayedBestTile: -2 }), SaveError);
  // Zero is what a track no game has landed a tile on reads.
  assert.equal(new Game({ bestTile: 0 }).bestTile, 0);
});

test("a restored save raises its track's best tile off the boards it carries", () => {
  const played = newGame([
    [8, 8, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  played.move("left");
  assert.equal(played.bestTile, 16);

  // A save written before tiles were tracked at all: the keys beside it read zero, and
  // the boards it carries say otherwise. The boards win -- that tile was really landed.
  const restored = newGame();
  restored.restore(decodeSavedState(played.encode(1), bestsOf(played)));
  assert.equal(restored.bestTile, 16);
  assert.equal(restored.replayedBestTile, 0);
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
  const saved = decodeSavedState(game.encode(9.5), bestsOf(game));
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
  restored.restore(decodeSavedState(played.encode(3), bestsOf(played)));
  assert.equal(restored.cursor, played.cursor);
  assert.deepEqual(restored.timeline, played.timeline);
  assert.equal(restored.nextDirection, played.nextDirection);
  assert.deepEqual(restored.cells, played.cells);
  assert.equal(restored.score, played.score);
  assert.equal(restored.moves, played.moves);
  assert.equal(restored.atLatest, false);
});

test("an interrupted write is rejected rather than half-read", () => {
  assert.throws(() => decodeSavedState(encoded().slice(0, 20), BESTS), SaveError);
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
    assert.throws(() => decodeSavedState(encoded(overrides), BESTS), SaveError);
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
      () => decodeSavedState(encoded({ timeline: [savedState(overrides)] }), BESTS),
      SaveError
    );
  });
}

test("a timeline that does not run one move forward at a time is rejected", () => {
  const skips = [savedState(), savedState({ moves: 9, score: 120 })];
  assert.throws(() => decodeSavedState(encoded({ timeline: skips }), BESTS), SaveError);

  const loses = [savedState(), savedState({ moves: 8, score: 99 })];
  assert.throws(() => decodeSavedState(encoded({ timeline: loses }), BESTS), SaveError);

  const runs = [savedState(), savedState({ moves: 8, score: 120 })];
  assert.doesNotThrow(() => decodeSavedState(encoded({ timeline: runs }), BESTS));
});

test("a score beyond the best score ever recorded is rejected", () => {
  const scored = (score) => encoded({ timeline: [savedState({ score })] });
  const bests = { best: 100, replayedBest: 0 };
  assert.throws(() => decodeSavedState(scored(101), bests), SaveError);
  assert.doesNotThrow(() => decodeSavedState(scored(100), bests));
});

test("a replayed save is measured against the replayed best score", () => {
  // The clean track cannot bound it -- a replayed game stops scoring into that one the
  // moment it forks, so its own total is free to run past it.
  const scored = (score) =>
    encoded({ timeline: [savedState({ score })], replayed_from: 3 });
  const bests = { best: 100, replayedBest: 500 };
  assert.doesNotThrow(() => decodeSavedState(scored(400), bests));
  assert.throws(() => decodeSavedState(scored(501), bests), SaveError);
});

test("a move direction that is not a direction is rejected", () => {
  const bogus = encoded({ timeline: [savedState({ direction: "sideways" })] });
  assert.throws(() => decodeSavedState(bogus, BESTS), SaveError);
});

test("a state saved without its move reads back with none", () => {
  // What a save written before moves were tracked holds, and what the oldest state of a
  // trimmed timeline holds: a state whose next move simply cannot be shown.
  const saved = decodeSavedState(encoded(), BESTS);
  assert.equal(saved.timeline[0].direction, null);

  const game = newGame();
  game.restore(saved);
  assert.equal(game.nextDirection, null);
  // And it survives a round trip rather than turning into something else.
  assert.equal(decodeSavedState(game.encode(1), bestsOf(game)).timeline[0].direction, null);
});

test("the history outlives the timeline through a save", () => {
  const played = newGame();
  played.reset();
  for (let extra = 0; extra < TIMELINE_LIMIT + 50; extra += 1) {
    played.score += 4;
    played.moves += 1;
    played.setOwnBest(played.score);
    played.record("left");
  }
  played.playFrom(played.timeline.length - 3);

  const restored = newGame(null, played.best);
  restored.restore(decodeSavedState(played.encode(60), bestsOf(played)));
  assert.equal(restored.timeline.length, played.timeline.length);
  assert.ok(restored.timeline.length <= TIMELINE_LIMIT);
  assert.deepEqual(restored.history, played.history);
  // The point of keeping it: the record still opens on the first move of the game,
  // long after the boards for that move were trimmed away.
  assert.equal(restored.history[0].moves, 0);
  assert.ok(restored.timeline[0].moves > 0);
});

test("the history costs a fraction of what the timeline does", () => {
  // Why the whole game can be kept when the boards cannot: an entry is a couple of
  // numbers where a state is a board. If this ever stops being true, keeping every
  // move stops being free and the trade-off behind it needs revisiting.
  const game = newGame();
  game.reset();
  for (let extra = 0; extra < TIMELINE_LIMIT; extra += 1) {
    game.score += 4;
    game.moves += 1;
    game.setOwnBest(game.score);
    game.record("left");
  }
  const saved = JSON.parse(game.encode(30));
  const timelineBytes = JSON.stringify(saved.timeline).length;
  const historyBytes = JSON.stringify(saved.history).length;
  assert.ok(
    historyBytes * 10 < timelineBytes,
    `history ${historyBytes} B is not an order of magnitude under timeline ${timelineBytes} B`
  );
});

test("a version 2 save opens on the history its timeline can supply", () => {
  // No history was stored before version 3, so what the timeline holds is all there is.
  // The game opens rather than being called corrupt, and carries its old tallies over.
  const legacy = JSON.stringify({
    version: TIMELINE_ONLY_STATE_VERSION,
    timeline: [
      savedState({ moves: 7, score: 100 }),
      savedState({ moves: 8, score: 108, undos: 2 }),
    ],
    cursor: 1,
    play_seconds: 12.5,
  });
  const saved = decodeSavedState(legacy, BESTS);
  assert.deepEqual(
    saved.history,
    [{ moves: 7, score: 100, undos: 0 }, { moves: 8, score: 108, undos: 2 }]
  );
});

test("undo tallies survive a round trip through the save format", () => {
  const played = replayable();
  played.playFrom(2);
  played.move("right");

  const restored = newGame();
  restored.restore(decodeSavedState(played.encode(2), bestsOf(played)));
  assert.deepEqual(undosOf(restored), undosOf(played));
  assert.ok(undosOf(played).some(Boolean), "the game under test took something back");
});

test("a history saved without any counts reads back with none", () => {
  // Nearly every game: the field is left out where every count would be zero.
  const saved = decodeSavedState(encoded(), BESTS);
  assert.deepEqual(saved.history.map((entry) => entry.undos), [0]);

  const game = newGame();
  game.restore(saved);
  assert.deepEqual(undosOf(game), [0]);
});

for (const [name, undos] of [
  ["is fractional", 1.5],
  ["is negative", -1],
  ["is not a number", "two"],
]) {
  test(`a history whose undo count ${name} is rejected`, () => {
    assert.throws(
      () => decodeSavedState(encoded({ history: { from: 7, score: 100, gains: [], undos: { 7: undos } } }), BESTS),
      SaveError
    );
  });
}

test("a history that does not end where its timeline does is rejected", () => {
  assert.throws(
    () => decodeSavedState(encoded({ history: { from: 7, score: 99, gains: [] } }), BESTS),
    SaveError
  );
});

test("a history that starts after its timeline is rejected", () => {
  // The history is the longer record by construction. One that opens later than the
  // timeline is describing a different game, not a shorter one.
  const timeline = [savedState({ moves: 7, score: 100 }), savedState({ moves: 8, score: 108 })];
  assert.throws(
    () => decodeSavedState(
      encoded({ timeline, history: { from: 8, score: 108, gains: [] } }), BESTS
    ),
    SaveError
  );
});

test("a history whose gain runs the score backwards is rejected", () => {
  assert.throws(
    () => decodeSavedState(
      encoded({ history: { from: 5, score: 120, gains: [-20, 0] } }), BESTS
    ),
    SaveError
  );
});

test("an undo counted against a move outside the history is rejected", () => {
  assert.throws(
    () => decodeSavedState(
      encoded({ history: { from: 7, score: 100, gains: [], undos: { 99: 1 } } }), BESTS
    ),
    SaveError
  );
});

test("a replayed game comes back knowing which move it was played on from", () => {
  const played = replayable();
  played.playFrom(2);
  played.move("right");

  const restored = newGame();
  restored.restore(decodeSavedState(played.encode(2), bestsOf(played)));
  assert.equal(restored.replayedFrom, 2);
  assert.equal(restored.replayed, true);
  assert.deepEqual(restored.timeline, played.timeline);
});

test("a save with no replay point reads back as a clean playthrough", () => {
  // What every save written before play could be resumed from an earlier state holds,
  // and what a game played straight through holds now.
  const saved = decodeSavedState(encoded(), BESTS);
  assert.equal(saved.replayedFrom, null);

  const game = newGame();
  game.restore(saved);
  assert.equal(game.replayed, false);
  assert.equal(decodeSavedState(game.encode(1), bestsOf(game)).replayedFrom, null);
});

for (const [name, replayedFrom] of [
  ["fractional", 1.5],
  ["negative", -1],
  ["past the newest move", 8],
]) {
  test(`a replay point that is ${name} is rejected`, () => {
    // savedState() sits at move 7, so 8 is a game claiming to have resumed from a move
    // it has not reached.
    assert.throws(
      () => decodeSavedState(encoded({ replayed_from: replayedFrom }), BESTS),
      SaveError
    );
  });
}

test("a save from before time travel reads back as a one-state timeline", () => {
  // Version 1 kept the state at the top level and had no history to scrub.
  const legacy = JSON.stringify({
    version: LEGACY_STATE_VERSION,
    ...savedState(),
    play_seconds: 4.5,
  });
  const saved = decodeSavedState(legacy, BESTS);
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
