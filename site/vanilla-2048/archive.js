/**
 * The games that are over: one row each, and the figures read across all of them.
 *
 * A row is what a finished game leaves behind once its board is gone -- what it was
 * worth, how long it took, how often it was taken back -- and the archive is the list of
 * them. The boards themselves are not here and neither are the moves: a game that was
 * recorded keeps its spawn log, which is stored beside this under the row's id and is
 * large enough to be worth keeping out of a record that is read whole on every open.
 *
 * Touches neither the DOM nor storage, so it runs -- and is tested -- under plain node,
 * the same way board.js's rules and stats.js's binning do. game.js reads the rows out of
 * localStorage and paints what these functions return.
 */

// Rows kept, newest first. A game runs minutes, so this is a long time at the table --
// and it is what bounds a record that is rewritten whole every time a game ends: a full
// archive is about 120 KB, against the 5 MB localStorage usually offers, which leaves
// the game's own save the room it has always had.
export const ARCHIVE_LIMIT = 1000;

export const ARCHIVE_VERSION = 1;

/**
 * A rejected archive, as opposed to a bug.
 *
 * Its own type rather than board.js's SaveError, because the two are recovered from
 * differently and only one of them stops the game. A save that will not parse leaves
 * nothing to play; an archive that will not parse leaves the game entirely playable and
 * costs only the list, so it is reported where the list would have been rather than in
 * front of the board.
 */
export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

// How a game stopped being played. A board with no moves left is the game ending on its
// own terms; a discarded one was still playable and was thrown away, by New Game or by
// never being returned to. Both are worth keeping -- an abandoned game still took the
// time it took -- but they are not the same event, and averaging them together would
// let a habit of restarting bad openings read as a collapse in scoring.
export const ENDED_GAME_OVER = "over";
export const ENDED_DISCARDED = "discarded";
const ENDINGS = [ENDED_GAME_OVER, ENDED_DISCARDED];

// Named apart from board.js's identical-looking check, which rejects into SaveError
// rather than ArchiveError -- and, more to the point, because the bundled build
// concatenates every module into one scope, where two top-level functions of one name
// are a syntax error rather than a shadowing.
function requireWholeNumber(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveError(`Invalid archived 2048 ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * One finished game, in the terms the list and the figures read.
 *
 * Takes plain numbers rather than a Game, so this module stays independent of the rules
 * the way stats.js is: what it is handed is a game that has already ended, and by then
 * the board is not the point.
 *
 * `replayedFrom` is the move play was last resumed at, or null for a game played
 * straight through, and it is carried for the reason the score line carries its own
 * asterisk: the two are not the same achievement. Everything computed over these rows
 * can be read for one track or the other, and the caller decides which by what it
 * filters before it gets here.
 *
 * Field names are short because a thousand of these are serialized together and read
 * back on every open. It is the one place in this demo where that is worth doing: the
 * row is written once by machine and read once by machine, and nothing about it is
 * clearer at four times the size.
 */
export function summarize({
  id,
  startedAt = null,
  endedAt,
  ending,
  score,
  topTile,
  moves,
  undos,
  seconds,
  replayedFrom = null,
  recorded = false,
}) {
  if (typeof id !== "string" || id === "") {
    throw new ArchiveError(`Invalid archived 2048 game id: ${JSON.stringify(id)}`);
  }
  if (!ENDINGS.includes(ending)) {
    throw new ArchiveError(`Unknown archived 2048 ending: ${JSON.stringify(ending)}`);
  }
  return {
    id,
    at: requireWholeNumber(endedAt, "end time"),
    // When the first move was played, or null for a game finished before this was
    // recorded. Kept beside the end time rather than replacing it, because the two
    // answer different questions and only one of them can be missing: every row has an
    // end time -- it is the moment the row was written -- and the list is ordered by it.
    st: startedAt === null ? null : requireWholeNumber(startedAt, "start time"),
    end: ending,
    score: requireWholeNumber(score, "score"),
    tile: requireWholeNumber(topTile, "top tile"),
    moves: requireWholeNumber(moves, "move count"),
    undos: requireWholeNumber(undos, "undo count"),
    // Rounded to the second on the way in. It is stored to be totalled across a thousand
    // games and printed as a clock, and neither of those wants the fraction the play
    // clock carries -- which would otherwise be written out in full, sixteen digits of
    // it, once per row.
    secs: Math.round(requireFiniteSeconds(seconds)),
    from: replayedFrom === null ? null : requireWholeNumber(replayedFrom, "replay point"),
    // Whether the moves themselves were kept. Games archived before the log existed were
    // not recorded and never can be, so the list says so rather than offering a replay
    // that has nothing behind it.
    rec: recorded === true,
  };
}

function requireFiniteSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new ArchiveError(`Invalid archived 2048 play time: ${JSON.stringify(seconds)}`);
  }
  return seconds;
}

/** Whether a row is a game played straight through, rather than one played on from. */
export const isClean = (row) => row.from === null;

export function encodeArchive(rows) {
  return JSON.stringify({ version: ARCHIVE_VERSION, games: rows });
}

/**
 * Parse and validate a stored archive, newest game first.
 *
 * Every row is validated through summarize, so a row that comes out of storage is a row
 * that could have gone into it. That matters more here than it would for a single save:
 * the archive is the one record that accumulates, so a row written wrong by some past
 * build would otherwise sit in the middle of it skewing every figure below, and nothing
 * would ever look at it closely again.
 */
export function decodeArchive(serialized) {
  if (serialized === null) {
    return [];
  }
  let stored;
  try {
    stored = JSON.parse(serialized);
  } catch {
    throw new ArchiveError("Invalid archived 2048 games JSON");
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new ArchiveError("Invalid archived 2048 games");
  }
  if (stored.version !== ARCHIVE_VERSION) {
    throw new ArchiveError(`Unsupported archived 2048 games version: ${stored.version}`);
  }
  if (!Array.isArray(stored.games)) {
    throw new ArchiveError("Invalid archived 2048 games list");
  }
  return stored.games.map((row) =>
    summarize({
      id: row.id,
      startedAt: row.st ?? null,
      endedAt: row.at,
      ending: row.end,
      score: row.score,
      topTile: row.tile,
      moves: row.moves,
      undos: row.undos,
      seconds: row.secs,
      replayedFrom: row.from ?? null,
      recorded: row.rec,
    })
  );
}

/**
 * Add a finished game to the archive, newest first, and drop what falls off the end.
 *
 * Newest first because that is the order the list is read in and the order it is capped
 * in: the games that fall off ARCHIVE_LIMIT are the oldest, which is the only end that
 * can be dropped without the list changing meaning.
 *
 * A row whose id is already in the archive replaces it rather than joining it. That is
 * not defensive: a game ends once, but the page can be told so twice -- a board that
 * locks is saved, and the same locked board is what a reload finds unarchived -- and an
 * id is what makes the second telling recognisable as the same game.
 */
export function addGame(rows, row) {
  return [row, ...rows.filter((existing) => existing.id !== row.id)].slice(0, ARCHIVE_LIMIT);
}

const median = (values) => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * The figures read across a set of games.
 *
 * The caller filters first: these are computed over whatever rows it hands in, so the
 * same function answers "all games", "clean games" and "the last twenty" without
 * knowing that is what it is doing.
 *
 * Both a median and a mean, which is not redundancy. 2048 scores are skewed -- a run of
 * ordinary games and the occasional one that went well -- so the mean sits above almost
 * every game in the list and the median sits in the middle of them, and which is wanted
 * depends on the question. What is a typical game worth is the median; what is the whole
 * archive worth per game is the mean. Printing one alone would answer the other question
 * wrongly, and the pair costs a line.
 *
 * Undos are reported two ways for the same reason: a total says how much taking back
 * happens, and the count of games with none says how often it happens at all. A handful
 * of heavily-rewound games and a habit of one undo per game give the same total.
 */
export function archiveStats(rows) {
  const scores = rows.map((row) => row.score);
  const finished = rows.filter((row) => row.end === ENDED_GAME_OVER);
  const totalMoves = sum(rows.map((row) => row.moves));
  return {
    games: rows.length,
    finished: finished.length,
    discarded: rows.length - finished.length,
    clean: rows.filter(isClean).length,
    bestScore: rows.length === 0 ? 0 : Math.max(...scores),
    medianScore: median(scores),
    meanScore: rows.length === 0 ? 0 : Math.round(sum(scores) / rows.length),
    bestTile: rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.tile)),
    totalMoves,
    totalSeconds: sum(rows.map((row) => row.secs)),
    totalUndos: sum(rows.map((row) => row.undos)),
    gamesWithoutUndo: rows.filter((row) => row.undos === 0).length,
    // What a move is worth, over everything played. The one figure here that is a rate
    // rather than a level, and the one that barely moves between players: it is set by
    // how far the board gets, not by how long anyone sits at it.
    pointsPerMove: totalMoves === 0 ? 0 : sum(scores) / totalMoves,
    recorded: rows.filter((row) => row.rec).length,
  };
}

/**
 * How many games reached each milestone tile, largest first.
 *
 * Milestones rather than a tally of every tile that ever appeared: what is being asked
 * is how often a game gets somewhere, and the answer is a handful of thresholds a player
 * already thinks in. A game that reached 2048 also reached 1024, so these are counts at
 * or above each tile and they nest -- which is what makes the column read down as a
 * funnel rather than as a histogram whose bars do not add up to anything.
 */
// Games on the trend chart. Enough that a run of them has a shape -- a stretch of even
// games, a week where the scores climbed -- and few enough that each still gets a bar
// wide enough to point at: fifty across the panel is about seven pixels a game.
export const TREND_GAMES = 50;

/**
 * The last `limit` games, oldest first, with the scales the trend chart is drawn against.
 *
 * Oldest first, which is the one place in this module that does not read newest first:
 * the list is scanned down from the most recent game, but a chart is read left to right
 * as time passing, and a chart of games that ran backwards would be misread by everyone
 * who has ever seen a chart.
 *
 * Two scales, because the two series are not the same kind of number. A score is a count
 * and is measured from zero -- a game worth half as much draws half as tall, and that
 * comparison is the whole reason to put scores side by side. A tile is a *level*: they
 * are powers of two, a game reaching 512 is one step past 256 rather than twice it, and
 * the steps are what a player thinks in. So the tile lane is scaled between the lowest
 * and highest tile actually reached rather than from zero, and it is scaled in exponents
 * -- which is what puts those steps an even distance apart and lets a lane a few dozen
 * pixels tall show the difference between a run of 256s and the game that broke 512.
 *
 * A game whose tile was never recorded carries zero, which is not a level and is not
 * plotted. It still has a score, so it keeps its bar: the two lanes are two questions
 * about a game, and having no answer to one is not having no answer to the other.
 */
export function gameTrend(rows, limit = TREND_GAMES) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ArchiveError(`Invalid 2048 trend length: ${limit}`);
  }
  const games = rows.slice(0, limit).reverse();
  const tiles = games.map((row) => row.tile).filter((tile) => tile > 0);
  return {
    games,
    maxScore: games.length === 0 ? 0 : Math.max(...games.map((row) => row.score)),
    // Exponents rather than the tiles themselves, since that is the axis the lane is
    // drawn on. A window in which every game reached the same tile has no range at all,
    // and says so with a pair that is equal rather than with a zero span the drawing
    // would have to divide by.
    minTileExponent: tiles.length === 0 ? 0 : Math.log2(Math.min(...tiles)),
    maxTileExponent: tiles.length === 0 ? 0 : Math.log2(Math.max(...tiles)),
    tiled: tiles.length,
  };
}

export const MILESTONE_TILES = [2048, 1024, 512, 256, 128];

export function milestones(rows) {
  return MILESTONE_TILES.map((tile) => ({
    tile,
    games: rows.filter((row) => row.tile >= tile).length,
  }));
}
