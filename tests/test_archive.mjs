/**
 * Unit tests for the finished-game records in site/vanilla-2048/archive.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_LIMIT,
  ArchiveError,
  ENDED_DISCARDED,
  ENDED_GAME_OVER,
  TREND_GAMES,
  addGame,
  archiveStats,
  decodeArchive,
  encodeArchive,
  gameTrend,
  MINI_MILESTONE_TILES,
  isClean,
  isSize,
  milestones,
  summarize,
} from "../site/vanilla-2048/archive.js";

/** A plausible finished game, with only what a test is about spelled out. */
function game(overrides = {}) {
  return summarize({
    id: "g1",
    endedAt: 1_700_000_000_000,
    ending: ENDED_GAME_OVER,
    score: 1000,
    topTile: 128,
    moves: 200,
    undos: 0,
    seconds: 300,
    ...overrides,
  });
}

test("a row carries what the list and the figures read", () => {
  const row = game({ id: "abc", score: 4096, topTile: 512, moves: 640, undos: 3 });
  assert.equal(row.id, "abc");
  assert.equal(row.score, 4096);
  assert.equal(row.tile, 512);
  assert.equal(row.moves, 640);
  assert.equal(row.undos, 3);
  assert.equal(row.end, ENDED_GAME_OVER);
});

test("play time is rounded to the second on the way in", () => {
  // The clock carries a fraction that would otherwise be written out in full, once per
  // row, for a figure that is only ever totalled and printed as a clock.
  assert.equal(game({ seconds: 128.4159 }).secs, 128);
  assert.equal(game({ seconds: 128.5 }).secs, 129);
});

test("a game played straight through is clean, one played on from is not", () => {
  assert.equal(isClean(game()), true);
  assert.equal(isClean(game({ replayedFrom: 40 })), false);
  assert.equal(game({ replayedFrom: 40 }).from, 40);
});

test("a row rejects figures no game could have produced", () => {
  assert.throws(() => game({ score: -1 }), ArchiveError);
  assert.throws(() => game({ moves: 1.5 }), ArchiveError);
  assert.throws(() => game({ seconds: Number.NaN }), ArchiveError);
  assert.throws(() => game({ id: "" }), ArchiveError);
  assert.throws(() => game({ ending: "abandoned" }), ArchiveError);
});

test("an archive round-trips through storage", () => {
  const rows = [game({ id: "a" }), game({ id: "b", replayedFrom: 12, undos: 2 })];
  assert.deepEqual(decodeArchive(encodeArchive(rows)), rows);
});

test("no stored archive reads as no games, not as an error", () => {
  // The state every browser is in before the first game ends.
  assert.deepEqual(decodeArchive(null), []);
});

test("an archive that will not parse is rejected rather than half-read", () => {
  assert.throws(() => decodeArchive("{"), ArchiveError);
  assert.throws(() => decodeArchive("[]"), ArchiveError);
  assert.throws(() => decodeArchive('{"version":99,"games":[]}'), ArchiveError);
  assert.throws(() => decodeArchive('{"version":1,"games":{}}'), ArchiveError);
});

test("a row stored wrong is caught on the way back out", () => {
  // The archive is the one record that accumulates, so a row written wrong by some past
  // build would otherwise sit in the middle of it skewing every figure computed over it.
  const rows = [game()];
  const stored = JSON.parse(encodeArchive(rows));
  stored.games[0].score = -5;
  assert.throws(() => decodeArchive(JSON.stringify(stored)), ArchiveError);
});

test("a finished game joins the front of the list", () => {
  const first = game({ id: "a" });
  const second = game({ id: "b" });
  assert.deepEqual(addGame(addGame([], first), second), [second, first]);
});

test("a game told twice replaces its row rather than joining it", () => {
  // A board that locks is filed, and the same locked board is what a reload finds; a
  // finished game can also be taken back and played on, which files it again.
  const over = game({ id: "a", score: 1000 });
  const later = game({ id: "a", score: 2500, ending: ENDED_DISCARDED });
  const rows = addGame(addGame([], over), later);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 2500);
  assert.equal(rows[0].end, ENDED_DISCARDED);
});

test("the oldest games fall off the end of a full archive", () => {
  let rows = [];
  for (let index = 0; index < ARCHIVE_LIMIT + 10; index += 1) {
    rows = addGame(rows, game({ id: `g${index}`, score: index }));
  }
  assert.equal(rows.length, ARCHIVE_LIMIT);
  // Newest first, so what survives is the newest ARCHIVE_LIMIT games.
  assert.equal(rows[0].score, ARCHIVE_LIMIT + 9);
  assert.equal(rows[rows.length - 1].score, 10);
});

test("the figures are computed over whatever rows they are handed", () => {
  const rows = [
    game({ id: "a", score: 1000, moves: 100, seconds: 60, undos: 0 }),
    game({ id: "b", score: 3000, moves: 200, seconds: 120, undos: 4 }),
    game({ id: "c", score: 2000, moves: 300, seconds: 180, undos: 2 }),
  ];
  const stats = archiveStats(rows);
  assert.equal(stats.games, 3);
  assert.equal(stats.bestScore, 3000);
  assert.equal(stats.medianScore, 2000);
  assert.equal(stats.meanScore, 2000);
  assert.equal(stats.totalMoves, 600);
  assert.equal(stats.totalSeconds, 360);
  assert.equal(stats.totalUndos, 6);
  assert.equal(stats.gamesWithoutUndo, 1);
  assert.equal(stats.pointsPerMove, 10);
});

test("the median sits in the middle of an even list", () => {
  const scores = [10, 20, 30, 40].map((score, index) => game({ id: `g${index}`, score }));
  assert.equal(archiveStats(scores).medianScore, 25);
});

test("the mean runs above the median on a skewed archive", () => {
  // Which is the shape 2048 scores actually have -- a run of ordinary games and the
  // occasional one that went well -- and the reason both figures are printed.
  const rows = [100, 120, 140, 160, 9000].map((score, index) =>
    game({ id: `g${index}`, score })
  );
  const stats = archiveStats(rows);
  assert.equal(stats.medianScore, 140);
  assert.ok(stats.meanScore > stats.medianScore * 4);
});

test("an empty set of games has figures rather than errors", () => {
  // The panel asks for these before the first game ends, and on a track with nothing in
  // it yet, so they have to come back as zeroes rather than as NaN or a throw.
  const stats = archiveStats([]);
  assert.equal(stats.games, 0);
  assert.equal(stats.bestScore, 0);
  assert.equal(stats.medianScore, 0);
  assert.equal(stats.meanScore, 0);
  assert.equal(stats.bestTile, 0);
  assert.equal(stats.pointsPerMove, 0);
});

test("finished and discarded games are counted apart", () => {
  const rows = [
    game({ id: "a", ending: ENDED_GAME_OVER }),
    game({ id: "b", ending: ENDED_DISCARDED }),
    game({ id: "c", ending: ENDED_DISCARDED }),
  ];
  const stats = archiveStats(rows);
  assert.equal(stats.finished, 1);
  assert.equal(stats.discarded, 2);
});

test("milestones nest, because a game that reached 2048 reached 1024", () => {
  const rows = [
    game({ id: "a", topTile: 2048 }),
    game({ id: "b", topTile: 512 }),
    game({ id: "c", topTile: 512 }),
    game({ id: "d", topTile: 64 }),
  ];
  assert.deepEqual(
    milestones(rows).map((milestone) => [milestone.tile, milestone.games]),
    [[2048, 1], [1024, 1], [512, 3], [256, 3], [128, 3]]
  );
});

test("a row carries when the game began, and null when that was never recorded", () => {
  assert.equal(game({ startedAt: 1_699_999_000_000 }).st, 1_699_999_000_000);
  // Every game finished before start times were recorded. The list says it does not know
  // rather than subtracting the play clock from the end time, which stops with the tab
  // and would claim a game played over a lunch break began minutes before it ended.
  assert.equal(game().st, null);
});

test("a start time round-trips, and a row without one stays without one", () => {
  const rows = [game({ id: "a", startedAt: 1_699_999_000_000 }), game({ id: "b" })];
  const back = decodeArchive(encodeArchive(rows));
  assert.deepEqual(back, rows);
  assert.equal(back[0].st, 1_699_999_000_000);
  assert.equal(back[1].st, null);
});

test("a start time that is not a time is rejected", () => {
  assert.throws(() => game({ startedAt: -1 }), ArchiveError);
  assert.throws(() => game({ startedAt: 1.5 }), ArchiveError);
});

test("a game whose moves were kept says so", () => {
  assert.equal(game({ recorded: true }).rec, true);
  assert.equal(game().rec, false);
  assert.equal(archiveStats([game({ recorded: true }), game({ id: "b" })]).recorded, 1);
});

/* The trend window ----------------------------------------------------------- */

test("the trend runs oldest first, which is the way a chart is read", () => {
  // The archive is newest first, because that is how a list is scanned. A chart is read
  // left to right as time passing, so this is the one place the order turns around.
  const rows = [game({ id: "new", score: 300 }), game({ id: "mid", score: 200 }), game({ id: "old", score: 100 })];
  assert.deepEqual(gameTrend(rows).games.map((row) => row.id), ["old", "mid", "new"]);
});

test("the trend keeps the newest games and drops the rest", () => {
  const rows = Array.from({ length: 80 }, (unused, index) =>
    game({ id: `g${index}`, score: index })
  );
  const trend = gameTrend(rows, 50);
  assert.equal(trend.games.length, 50);
  // Newest fifty of an archive that is newest first: rows 0..49, turned around.
  assert.equal(trend.games[0].id, "g49");
  assert.equal(trend.games[49].id, "g0");
});

test("the trend takes every game when there are fewer than it holds", () => {
  const rows = [game({ id: "a" }), game({ id: "b" })];
  assert.equal(gameTrend(rows, TREND_GAMES).games.length, 2);
});

test("the score scale is the highest score in the window", () => {
  const rows = [1000, 4000, 2000].map((score, index) => game({ id: `g${index}`, score }));
  assert.equal(gameTrend(rows).maxScore, 4000);
});

test("the tile scale is the range of tiles reached, in exponents", () => {
  // Drawn in exponents because tiles double: 512 is one step past 256, not twice it, and
  // an even spacing is what lets a short lane show the difference.
  const rows = [128, 512, 256].map((tile, index) => game({ id: `g${index}`, topTile: tile }));
  const trend = gameTrend(rows);
  assert.equal(trend.minTileExponent, 7);
  assert.equal(trend.maxTileExponent, 9);
  assert.equal(trend.tiled, 3);
});

test("a window where every game reached the same tile has no range", () => {
  // The lane has nothing to spread across, and says so with an equal pair rather than a
  // span of zero the drawing would divide by.
  const rows = [game({ id: "a", topTile: 256 }), game({ id: "b", topTile: 256 })];
  const trend = gameTrend(rows);
  assert.equal(trend.minTileExponent, trend.maxTileExponent);
  assert.equal(trend.maxTileExponent, 8);
});

test("a game with no tile on record is left out of the tile scale but keeps its score", () => {
  // Games archived before tiles were tracked. They still have a score, so they still
  // have a bar; having no answer to one question is not having no answer to the other.
  const rows = [
    game({ id: "a", topTile: 0, score: 900 }),
    game({ id: "b", topTile: 256, score: 400 }),
  ];
  const trend = gameTrend(rows);
  assert.equal(trend.tiled, 1);
  assert.equal(trend.minTileExponent, 8);
  assert.equal(trend.maxTileExponent, 8);
  // The untiled game is still the tallest bar in the score lane.
  assert.equal(trend.maxScore, 900);
  assert.equal(trend.games.length, 2);
});

test("a trend over no games has scales rather than errors", () => {
  // Asked for on a track with nothing in it yet, so it has to come back as zeroes.
  const trend = gameTrend([]);
  assert.deepEqual(trend.games, []);
  assert.equal(trend.maxScore, 0);
  assert.equal(trend.tiled, 0);
  assert.equal(trend.maxTileExponent, 0);
});

test("a trend length that cannot be drawn to is refused", () => {
  assert.throws(() => gameTrend([game()], 0), ArchiveError);
  assert.throws(() => gameTrend([game()], 2.5), ArchiveError);
});

test("the trend does not disturb the archive it reads", () => {
  // It reverses, and reverse() is in place on the array it is called on.
  const rows = [game({ id: "a" }), game({ id: "b" })];
  gameTrend(rows);
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
});

/* Board size ---------------------------------------------------------------- */

test("a row carries the board it was played on", () => {
  assert.equal(game().n, 4);
  assert.equal(game({ size: 3 }).n, 3);
});

test("a row stored before sizes were kept reads back as a 4x4 game", () => {
  const stored = JSON.parse(encodeArchive([game()]));
  delete stored.games[0].n;
  const [row] = decodeArchive(JSON.stringify(stored));
  assert.equal(row.n, 4);
});

test("a size that is not a whole number is refused", () => {
  assert.throws(() => game({ size: -1 }), ArchiveError);
  assert.throws(() => game({ size: "3" }), ArchiveError);
});

test("the size filter splits a mixed list", () => {
  const rows = [
    game({ id: "a", size: 4 }),
    game({ id: "b", size: 3 }),
    game({ id: "c", size: 3 }),
  ];
  assert.deepEqual(rows.filter(isSize(3)).map((row) => row.id), ["b", "c"]);
  assert.deepEqual(rows.filter(isSize(4)).map((row) => row.id), ["a"]);
});

test("milestones can be asked in mini's own thresholds", () => {
  const rows = [game({ topTile: 512 }), game({ topTile: 64 }), game({ topTile: 16 })];
  assert.deepEqual(
    milestones(rows, MINI_MILESTONE_TILES),
    [
      { tile: 512, games: 1 },
      { tile: 256, games: 1 },
      { tile: 128, games: 1 },
      { tile: 64, games: 2 },
      { tile: 32, games: 2 },
    ]
  );
});
