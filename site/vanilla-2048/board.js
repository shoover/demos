/**
 * Pure 2048 rules: line collapsing, move results, and save-state validation.
 *
 * Touches neither the DOM nor storage, so it runs -- and is tested -- under plain
 * node. game.js keeps everything that touches the page: painting, animation timing,
 * and localStorage.
 *
 * Cells are addressed two ways on purpose. The board itself is rows of rows, because
 * that is the shape the save format stores; everything a move reports back is a flat
 * index (r * SIZE + c), because callers only ever use those to key tiles and look up
 * positions.
 *
 * A game keeps every state it has been in, so an earlier board can be looked at again --
 * and played on from, which discards what it had already gone on to do; see the Game
 * class for how the timeline and the cursor into it fit together.
 */

export const SIZE = 4;
export const STATE_VERSION = 3;
// Version 1 stored a single state, from before the game kept a timeline. Version 2 kept
// the timeline but nothing behind it, so a graph could only ever show the moves the
// timeline still held. Both are still read, so a game saved by a previous build reopens
// rather than being called corrupt.
export const LEGACY_STATE_VERSION = 1;
export const TIMELINE_ONLY_STATE_VERSION = 2;
const READABLE_VERSIONS = [STATE_VERSION, TIMELINE_ONLY_STATE_VERSION, LEGACY_STATE_VERSION];
// Boards kept per game. The whole timeline is rewritten on every save, so it has to be
// bounded by something. A full one measures 92 KB, which encodes in 0.6ms and stores in
// 0.4ms -- a fraction of a frame on the move that writes it, and a fraction of the 5 MB
// localStorage usually offers.
//
// This bounds how far back the scrubber reaches, and nothing else. What the graph is
// drawn from is the history below, which is kept whole.
export const TIMELINE_LIMIT = 1000;
const FOUR_SPAWN_CHANCE = 0.1;
const DIRECTIONS = ["up", "down", "left", "right"];

/* Spawn log ----------------------------------------------------------------- */

/**
 * The whole game in one byte a move.
 *
 * A move is deterministic given the board it is played on: collapsing a line is
 * arithmetic, and the only thing the rules cannot derive is the tile dealt afterwards.
 * So a game is fully described by its opening board and, for every move, the direction
 * played and the spawn that answered it -- and every board, score and tile it ever held
 * can be rebuilt by feeding that back through move().
 *
 * Which is why this is not a second copy of the timeline at a smaller size. The timeline
 * stores boards and costs about 120 bytes a move; this stores the two facts a board can
 * be *derived* from and costs one. A game long enough to fill the timeline stores 120 KB
 * of boards and 1 KB of this.
 *
 * Seven bits, laid out so the opening board and the moves can share an array:
 *
 *     bits 6-5  direction index into DIRECTIONS, unused (0) on an opening spawn
 *     bits 4-1  the cell the tile landed on, 0-15
 *     bit  0    the tile dealt: 0 for a 2, 1 for a 4
 *
 * The first two entries are the two tiles reset() deals; entry 2 + n is move n + 1. So
 * the array is always two longer than the move count, which is what lets a take-back
 * truncate it by length alone.
 */
const SPAWN_LOG_OPENING = 2;
const spawnByte = (direction, cell, value) =>
  ((direction === null ? 0 : DIRECTIONS.indexOf(direction)) << 5) |
  (cell << 1) |
  (value === 4 ? 1 : 0);

const spawnCell = (byte) => (byte >> 1) & 0b1111;
const spawnValue = (byte) => ((byte & 1) === 1 ? 4 : 2);
const spawnDirection = (byte) => DIRECTIONS[(byte >> 5) & 0b11];

// Base64 rather than an array of numbers: the log rides along in the JSON save, where a
// number costs three or four characters to write and this costs 1.33.
function encodeSpawnLog(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeSpawnLog(text) {
  if (typeof text !== "string") {
    throw new SaveError(`Invalid saved 2048 spawn log: ${JSON.stringify(text)}`);
  }
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new SaveError("Invalid saved 2048 spawn log encoding");
  }
  const bytes = new Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    const byte = binary.charCodeAt(index);
    // A byte with its high bit set is not something this format can produce, so a save
    // carrying one was not written by it. Caught here rather than at replay, where it
    // would surface as a spawn onto a cell that does not exist.
    if (byte > 0b1111111) {
      throw new SaveError(`Invalid saved 2048 spawn log byte: ${byte}`);
    }
    bytes[index] = byte;
  }
  if (bytes.length < SPAWN_LOG_OPENING) {
    throw new SaveError("Saved 2048 spawn log has no opening board");
  }
  return bytes;
}

/**
 * How a spawn is chosen, injected the way `random` is.
 *
 * The default deals at random, which is the game. Replay passes one that reads the
 * recorded answer instead -- and that is the whole of the difference between playing a
 * game and rebuilding one, which is why move() has no idea which is happening.
 */
const randomSpawn = (empty, random) => [
  empty[Math.floor(random() * empty.length)],
  random() < FOUR_SPAWN_CHANCE ? 4 : 2,
];

/** A rejected save, as opposed to a bug: the page offers recovery for these. */
export class SaveError extends Error {
  constructor(message) {
    super(message);
    this.name = "SaveError";
  }
}

function isValidTile(value) {
  return (
    Number.isSafeInteger(value) &&
    (value === 0 || (value >= 2 && Math.log2(value) % 1 === 0))
  );
}

function requireNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SaveError(`Invalid saved 2048 ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

// A stored tile, which is a power of two -- or zero, for a track no game has landed a
// tile on yet. Checked rather than merely bounded, because a tile is not a count: 5 is
// a number no board can hold, and a stored one is corruption rather than a low figure.
function requireTile(value, name) {
  if (!isValidTile(value)) {
    throw new SaveError(`Invalid saved 2048 ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

export const topTileOf = (cells) => Math.max(...cells.map((row) => Math.max(...row)));

function validateSavedBoard(value) {
  if (
    !Array.isArray(value) ||
    value.length !== SIZE ||
    value.some((row) => !Array.isArray(row) || row.length !== SIZE) ||
    value.some((row) => row.some((tile) => !isValidTile(tile)))
  ) {
    throw new SaveError("Invalid saved 2048 board");
  }
  return value.map((row) => row.slice());
}

export function emptyCells(cells) {
  const empty = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (cells[r][c] === 0) {
        empty.push(r * SIZE + c);
      }
    }
  }
  return empty;
}

export function boardCanMove(cells) {
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const value = cells[r][c];
      if (value === 0) {
        return true;
      }
      if (r + 1 < SIZE && value === cells[r + 1][c]) {
        return true;
      }
      if (c + 1 < SIZE && value === cells[r][c + 1]) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Board cells per line, ordered so index 0 is the edge tiles collapse toward.
 *
 * Sliding needs each tile's origin and destination, so every direction is expressed
 * as an ordered list of cell indices and collapsed by one shared loop.
 */
export function lineCoordinates(direction) {
  const lines = [];
  for (let line = 0; line < SIZE; line += 1) {
    const cells = [];
    for (let step = 0; step < SIZE; step += 1) {
      const forward = direction === "left" || direction === "up";
      const offset = forward ? step : SIZE - 1 - step;
      const horizontal = direction === "left" || direction === "right";
      cells.push(horizontal ? line * SIZE + offset : offset * SIZE + line);
    }
    lines.push(cells);
  }
  return lines;
}

/**
 * Collapse one line toward index 0.
 *
 * `sources[j]` lists the indices in the input line whose tiles ended up at output
 * index j -- one entry normally, two for a merge -- which is what lets each tile be
 * animated from its old cell to its new one.
 */
export function compressAndMerge(line) {
  const values = [];
  line.forEach((value, index) => {
    if (value) {
      values.push({ index, value });
    }
  });

  const merged = [];
  const mergePositions = new Set();
  const sources = [];
  let gained = 0;

  for (let i = 0; i < values.length; ) {
    if (i + 1 < values.length && values[i].value === values[i + 1].value) {
      const value = values[i].value * 2;
      mergePositions.add(merged.length);
      merged.push(value);
      sources.push([values[i].index, values[i + 1].index]);
      gained += value;
      i += 2;
    } else {
      merged.push(values[i].value);
      sources.push([values[i].index]);
      i += 1;
    }
  }
  while (merged.length < SIZE) {
    merged.push(0);
  }
  return { merged, mergePositions, sources, gained };
}

/**
 * Where a move landed: the cells it merged into, and the cell it spawned onto.
 *
 * Worked out from the boards either side of the move rather than recorded alongside
 * them, so a game reopened from a save -- which carries boards and directions and
 * nothing else -- arrives with the same burst as one being played.
 *
 * `previous` is the board the move was played from, `cells` the board it produced. The
 * spawn is found by collapsing `previous` again and taking the cell the collapse left
 * empty that `cells` has filled; a save whose two boards are not a move apart names
 * whatever cells they disagree about, which is a burst on the wrong tiles rather than
 * anything worse.
 */
export function arrivalCells(previous, direction, cells) {
  const merged = new Set();
  const appeared = new Set();
  if (direction === null) {
    return { merged, appeared };
  }

  const collapsed = Game.emptyBoard();
  for (const coordinates of lineCoordinates(direction)) {
    const line = coordinates.map(
      (cell) => previous[Math.floor(cell / SIZE)][cell % SIZE]
    );
    const { merged: values, mergePositions } = compressAndMerge(line);
    coordinates.forEach((cell, index) => {
      collapsed[Math.floor(cell / SIZE)][cell % SIZE] = values[index];
    });
    for (const index of mergePositions) {
      merged.add(coordinates[index]);
    }
  }

  for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
    const [row, col] = [Math.floor(cell / SIZE), cell % SIZE];
    if (collapsed[row][col] === 0 && cells[row][col] !== 0) {
      appeared.add(cell);
    }
  }
  return { merged, appeared };
}

/**
 * One point on the timeline: a board, the counters that belong with it, the move that
 * led to it, and how many times play has been taken back to it.
 *
 * The direction is carried by the state a move produced rather than by the state it was
 * played from, so recording one never has to reach back and amend the state before it.
 * What a reader usually wants is the other way round -- the move played *from* a state,
 * which is the direction on the state after it; Game.nextDirection does that lookup.
 *
 * Copied on the way in, so a recorded state can never share a row with the live board
 * and be played on after the fact.
 *
 * Carries no undo tally. The count belongs to a move, and a move outlives the board that
 * reached it: the timeline is trimmed at TIMELINE_LIMIT, so a tally kept here is thrown
 * away with the oldest states while the move it counted is still on the graph. It lives
 * on the history instead, which is not trimmed.
 */
function captureState({ cells, score, moves, gameOver }, direction = null) {
  return {
    cells: cells.map((row) => row.slice()),
    score,
    moves,
    gameOver,
    direction,
  };
}

/**
 * One move's worth of the record the graph is drawn from: what the score stood at, and
 * how many times play has been taken back to it.
 *
 * This is the whole game and stays that way -- one entry per move from the opening board
 * on, however long the game runs. It is affordable because it holds no board: a state
 * costs 92 bytes to store, an entry here costs about five, so a game long enough to fill
 * the timeline twice over still writes less than the timeline does.
 */
function historyEntry(moves, score, undos = 0) {
  return { moves, score, undos };
}

/**
 * Validate one stored state, in the terms captureState produces.
 *
 * `previous` is the state before it on the timeline, or null for the first one. States
 * are one move apart and a move never loses points, so a timeline that skips or runs
 * backwards is corrupt however plausible each state looks on its own.
 */
function decodeState(entry, best, previous) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SaveError("Invalid saved 2048 game state");
  }

  const cells = validateSavedBoard(entry.board);
  const score = requireNonNegativeInt(entry.score, "score");
  const moves = requireNonNegativeInt(entry.moves, "move count");
  const gameOver = entry.game_over;
  // Absent as well as null: nothing led to the first state of a game, a trimmed
  // timeline opens on a state whose move was dropped with the states before it, and a
  // save written before directions were tracked has none of them at all. All three are
  // the same thing to a reader -- a state whose next move cannot be shown.
  const direction = entry.direction ?? null;
  if (direction !== null && !DIRECTIONS.includes(direction)) {
    throw new SaveError(
      `Invalid saved 2048 move direction: ${JSON.stringify(direction)}`
    );
  }
  if (typeof gameOver !== "boolean") {
    throw new SaveError(
      `Invalid saved 2048 game-over state: ${JSON.stringify(gameOver)}`
    );
  }
  if (score > best) {
    throw new SaveError(`Saved 2048 score ${score} exceeds best score ${best}`);
  }
  if (gameOver === boardCanMove(cells)) {
    throw new SaveError("Saved 2048 game-over state does not match the board");
  }
  if (previous !== null && (moves !== previous.moves + 1 || score < previous.score)) {
    throw new SaveError(`Saved 2048 timeline does not run forward at move ${moves}`);
  }

  // Exactly what captureState holds, so a timeline read back from a save and one the
  // game recorded itself are the same thing. The undo tally is not here: it belongs to
  // the move rather than to the board, and lives on the history.
  return { cells, score, moves, gameOver, direction };
}

/**
 * The states a save carries, oldest first, whichever version wrote it.
 *
 * A version 1 save predates the timeline and stored a single state at the top level. It
 * reads back as a one-state timeline, which is what a game whose history has been
 * trimmed to its newest state looks like anyway.
 */
function savedStates(state) {
  if (state.version === LEGACY_STATE_VERSION) {
    return [state];
  }
  if (!Array.isArray(state.timeline) || state.timeline.length === 0) {
    throw new SaveError("Invalid saved 2048 timeline");
  }
  return state.timeline;
}

/**
 * The score history a save carries, oldest move first.
 *
 * Stored as the points each move gained rather than as the totals themselves, because
 * gains are what the graph's second series is and the totals are their running sum:
 * writing the totals would mean storing a figure that grows to seven digits a thousand
 * times over, when what changed each move fits in two.
 *
 * A version 1 or 2 save has no history behind its timeline. What the timeline holds is
 * then the whole of what is known -- the earlier moves went with the states that carried
 * them -- so it reads back as a history that starts where the timeline does. That game's
 * graph opens on the moves it has, exactly as it did before, and every move played from
 * here on is recorded.
 */
function decodeHistory(state, timeline) {
  if (state.version !== STATE_VERSION) {
    // A version 2 save kept its undo tallies on the timeline's states, which is where
    // they were before they had anywhere better to be. Read them off the stored entries
    // rather than off the decoded states, which no longer carry them.
    const stored = savedStates(state);
    return timeline.map((entry, index) =>
      historyEntry(
        entry.moves,
        entry.score,
        requireNonNegativeInt(stored[index].undos ?? 0, "undo count")
      )
    );
  }

  const stored = state.history;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new SaveError("Invalid saved 2048 history");
  }
  const from = requireNonNegativeInt(stored.from, "history start");
  let score = requireNonNegativeInt(stored.score, "history opening score");
  if (!Array.isArray(stored.gains)) {
    throw new SaveError("Invalid saved 2048 history gains");
  }

  // Keyed by move rather than by position, so a tally names the move it belongs to and
  // survives being read back against a history that starts somewhere else.
  const undos = new Map();
  for (const [move, count] of Object.entries(stored.undos ?? {})) {
    const at = requireNonNegativeInt(Number(move), "history undo move");
    undos.set(at, requireNonNegativeInt(count, "history undo count"));
  }

  const history = [historyEntry(from, score, undos.get(from) ?? 0)];
  for (const [index, gain] of stored.gains.entries()) {
    // A move never loses points, so a negative gain is a corrupt save rather than a
    // score that went down.
    score += requireNonNegativeInt(gain, "history gain");
    const moves = from + index + 1;
    history.push(historyEntry(moves, score, undos.get(moves) ?? 0));
  }

  // The history and the timeline are two records of one game, so they have to agree
  // about it: the history has to reach at least as far back as the timeline does, and
  // both have to end on the same move with the same score.
  const latest = timeline[timeline.length - 1];
  const last = history[history.length - 1];
  if (from > timeline[0].moves) {
    throw new SaveError(
      `Saved 2048 history starts at move ${from}, after its timeline's ${timeline[0].moves}`
    );
  }
  if (last.moves !== latest.moves || last.score !== latest.score) {
    throw new SaveError(
      `Saved 2048 history ends at move ${last.moves} scoring ${last.score}, ` +
      `its timeline at move ${latest.moves} scoring ${latest.score}`
    );
  }
  for (const at of undos.keys()) {
    if (at < from || at > last.moves) {
      throw new SaveError(`Saved 2048 history undo names move ${at}, outside its history`);
    }
  }

  return history;
}

/**
 * Parse and validate a stored save. Throws SaveError on anything unusable.
 *
 * The persisted best scores bound every saved score: a save claiming more points than
 * was ever recorded is inconsistent with itself. Which of the two bounds it is measured
 * against is the save's own business, since the save says whether it was replayed.
 *
 * Returns the whole timeline, which of its states was being viewed, where play was last
 * resumed from, and how often it has been taken back -- the scrub position, the replay
 * point and the undo tallies are all part of what a reload has to put back.
 */
export function decodeSavedState(serialized, { best, replayedBest }) {
  let state;
  try {
    state = JSON.parse(serialized);
  } catch (error) {
    throw new SaveError("Invalid saved 2048 game state JSON");
  }

  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new SaveError("Invalid saved 2048 game state");
  }
  if (!READABLE_VERSIONS.includes(state.version)) {
    throw new SaveError("Unsupported saved 2048 game state version");
  }

  const playSeconds = state.play_seconds;
  if (typeof playSeconds !== "number" || !Number.isFinite(playSeconds) || playSeconds < 0) {
    throw new SaveError(
      `Invalid saved 2048 play time: ${JSON.stringify(playSeconds)}`
    );
  }

  // Absent as well as null: every save of a game that has been played straight through,
  // and every save written before play could be resumed from an earlier state at all.
  const replayedFrom = state.replayed_from ?? null;
  if (replayedFrom !== null) {
    requireNonNegativeInt(replayedFrom, "replay point");
  }

  // Each game is bounded by the track it was scoring into. A replayed one is bounded by
  // its own track over its whole length, earliest states included, because the clean
  // best crossed over at the fork and had already bounded everything before it.
  const timeline = [];
  for (const entry of savedStates(state)) {
    timeline.push(
      decodeState(entry, replayedFrom === null ? best : replayedBest, timeline.at(-1) ?? null)
    );
  }

  const latestMoves = timeline[timeline.length - 1].moves;
  if (replayedFrom !== null && replayedFrom > latestMoves) {
    throw new SaveError(
      `Saved 2048 replay point ${replayedFrom} is past move ${latestMoves}`
    );
  }

  const cursor =
    state.version === LEGACY_STATE_VERSION
      ? timeline.length - 1
      : requireNonNegativeInt(state.cursor, "timeline cursor");
  if (cursor >= timeline.length) {
    throw new SaveError(
      `Saved 2048 timeline cursor ${cursor} is past its ${timeline.length} states`
    );
  }

  const history = decodeHistory(state, timeline);
  return {
    timeline,
    history,
    cursor,
    playSeconds,
    replayedFrom,
    spawns: decodeSpawns(state, history, latestMoves),
  };
}

/**
 * The spawn log a save carries, or null where it carries none.
 *
 * The log is the one record here that claims to be the *whole* game, so it is the one
 * that has to be checked against the game's own length: two opening tiles and a spawn a
 * move. A log that disagrees would replay into a different game than the save holds --
 * the same board reached by other tiles -- and the disagreement would surface as a graph
 * that quietly did not match the score line above it.
 *
 * A history that does not start at move 0 rules a log out for the same reason. Both are
 * only reachable through a save that predates the log: the timeline is trimmed and the
 * history is not, so a game recorded by this build always has both from its first board.
 */
function decodeSpawns(state, history, latestMoves) {
  if (state.spawns === undefined || state.spawns === null) {
    return null;
  }
  const spawns = decodeSpawnLog(state.spawns);
  if (history[0].moves !== 0) {
    throw new SaveError(
      `Saved 2048 spawn log arrived with a history starting at move ${history[0].moves}`
    );
  }
  if (spawns.length !== latestMoves + SPAWN_LOG_OPENING) {
    throw new SaveError(
      `Saved 2048 spawn log holds ${spawns.length - SPAWN_LOG_OPENING} moves, ` +
        `its game ${latestMoves}`
    );
  }
  return spawns;
}

/**
 * Rebuild a game from its spawn log: every board, score, tile and move it ever held.
 *
 * The rules do the work. Nothing here re-implements a move -- it deals the recorded
 * tiles and calls the same move() the game was played through, which is the only reason
 * a reconstruction can be trusted to agree with the game it came from. A second
 * implementation would agree right up until the day it stopped.
 *
 * What it cannot rebuild is the undo tallies. Those count decisions rather than moves,
 * and the log holds the line of play that survived them; a take-back leaves no trace in
 * a record of what was actually dealt. They come off the archived row instead, which is
 * where they were written down when the game ended.
 *
 * Returns a Game seeked to its last state. Throws SaveError on a log the rules reject,
 * which is what a truncated or corrupt one looks like from here.
 */
export function replaySpawns(spawns) {
  let at = 0;
  // Checked against the cells actually free rather than trusted: the rules hand over the
  // list they would have dealt from, and a log naming a cell that is not on it is
  // describing some other game. Unchecked, it would land a tile on top of one already
  // there and rebuild a board that was never played.
  const dealRecorded = (empty) => {
    const byte = spawns[at];
    at += 1;
    const cell = spawnCell(byte);
    if (!empty.includes(cell)) {
      throw new SaveError(`2048 spawn log deals onto occupied cell ${cell} at entry ${at - 1}`);
    }
    return [cell, spawnValue(byte)];
  };
  const game = new Game({
    // Bounds nothing: the scores being rebuilt were already bounded by the save this log
    // came out of, and this is not the game the player is playing.
    best: Number.MAX_SAFE_INTEGER,
    replayedBest: Number.MAX_SAFE_INTEGER,
    spawn: dealRecorded,
  });
  game.reset();
  for (let move = SPAWN_LOG_OPENING; move < spawns.length; move += 1) {
    const direction = spawnDirection(spawns[move]);
    if (game.gameOver) {
      throw new SaveError(`2048 spawn log plays on past a finished board at move ${move - 1}`);
    }
    if (game.move(direction) === null) {
      throw new SaveError(
        `2048 spawn log plays ${direction} at move ${move - 1}, which moves nothing`
      );
    }
  }
  return game;
}

/**
 * The board and its rules. Knows nothing about how it is drawn or stored.
 *
 * The best scores are carried here because they are a function of the score, but
 * persisting them is the caller's job: every move reports whether one changed.
 *
 * Two records of the same game are kept, because they are wanted for different things
 * and cost different amounts. `timeline` holds boards, so it is what the scrubber walks
 * and what an earlier position is played from -- and it is expensive, so it is capped.
 * `history` holds one entry per move: the score it reached and the undos taken back to
 * it, no board. That is what the graph is drawn from, it is cheap enough to keep whole,
 * and so the graph shows the entire game however far back the scrubber can no longer go.
 *
 * The newest TIMELINE_LIMIT states are kept, oldest first, in `timeline`; `cells` and
 * the counters beside it are always the state at `cursor`. Seeking moves the cursor
 * back through the timeline to look at an earlier board. Play resumes from the newest
 * state, and from any other only by way of playFrom, which makes the state it resumes
 * at the newest one by discarding what came after it.
 */
export class Game {
  constructor({
    best = 0,
    replayedBest = 0,
    bestTile = 0,
    replayedBestTile = 0,
    random = Math.random,
    spawn = randomSpawn,
  } = {}) {
    this.random = random;
    this.spawn = spawn;
    this.best = requireNonNegativeInt(best, "best score");
    this.replayedBest = requireNonNegativeInt(replayedBest, "replayed best score");
    // The largest tile ever landed, split across the same two tracks as the score and
    // for the same reason: a 2048 reached by rerolling an unlucky spawn is not the one a
    // straight playthrough reached. A tile is not a second reading of the score either
    // -- the two peak in different games, since points keep accruing after the board has
    // stopped doubling -- so each track carries its own, raised on its own.
    this.bestTile = requireTile(bestTile, "best tile");
    this.replayedBestTile = requireTile(replayedBestTile, "replayed best tile");
    // The move count play was last resumed at, or null for a game played straight
    // through. A move count rather than a timeline position, because positions shift
    // when the oldest states are trimmed and this has to still name the same move --
    // and because naming the move is what it is for.
    this.replayedFrom = null;
    this.cells = Game.emptyBoard();
    this.score = 0;
    this.moves = 0;
    this.gameOver = false;
    // Every spawn this game has been dealt, oldest first: the two opening tiles and then
    // one a move. Null means this game cannot be replayed and never will be -- a save
    // written before the log existed restores into that, and there is nothing to
    // reconstruct the moves it already made from. It is not started midway, because a
    // log missing its first thousand moves cannot rebuild the board the rest are played
    // against.
    //
    // Null here at construction for that same reason and not as a placeholder: what a
    // constructor makes is an empty board that has been dealt nothing, and the two calls
    // that give a game its opening -- reset and restore -- are the two that give it a
    // log. A game that has been through neither has no first board to record.
    this.spawns = null;
    // Recorded straight away, so the cursor indexes a real state from construction on
    // and no caller has to special-case a game that has not been played yet.
    this.timeline = [captureState(this)];
    // The opening board is move 0 and belongs on the graph like any other: it is where
    // the points line starts from.
    this.history = [historyEntry(0, 0)];
    this.cursor = 0;
  }

  /**
   * The largest tile on the board as it now stands.
   *
   * Read off the cells rather than tallied as moves land, so it follows the state on
   * screen the way the score does: scrubbing back to move 20 shows the tile move 20 had
   * reached, not the one the game went on to make.
   */
  get topTile() {
    return topTileOf(this.cells);
  }

  /** Whether the state on screen is the newest one -- the only one that can be played. */
  get atLatest() {
    return this.cursor === this.timeline.length - 1;
  }

  /** Whether this game has been played on from an earlier state. */
  get replayed() {
    return this.replayedFrom !== null;
  }

  /**
   * The best score this game is measured against: the replayed track once it has been
   * played on from an earlier state, the clean track until then.
   *
   * Two tracks rather than one because the game rerolls its spawns. Replaying a move
   * deals a different tile, so an unlucky one can simply be taken back, and a score
   * reached that way is not the achievement a straight playthrough is. One figure would
   * quietly let the first stand in for the second.
   */
  get ownBest() {
    return this.replayed ? this.replayedBest : this.best;
  }

  /** The best tile this game is measured against, on the track ownBest names. */
  get ownBestTile() {
    return this.replayed ? this.replayedBestTile : this.bestTile;
  }

  /** Raise this game's own track. Which one that is, only the game knows. */
  setOwnBest(score) {
    if (this.replayed) {
      this.replayedBest = score;
    } else {
      this.best = score;
    }
  }

  setOwnBestTile(tile) {
    if (this.replayed) {
      this.replayedBestTile = tile;
    } else {
      this.bestTile = tile;
    }
  }

  get latest() {
    return this.timeline[this.timeline.length - 1];
  }

  /**
   * The move played from the state on screen, or null if none is known: the newest
   * state has nothing after it, and an old save may not have recorded what came next.
   */
  get nextDirection() {
    const next = this.timeline[this.cursor + 1];
    return next === undefined ? null : next.direction;
  }

  /**
   * How the state on screen came to be: the cells its move merged into and the cell it
   * spawned onto, which is what a repaint bursts to show a move arriving.
   *
   * Both empty when nothing on the timeline led here -- the opening board of a game, the
   * oldest state of a timeline trimmed at its limit, or a state from a save written
   * before directions were tracked. A state that cannot say what reached it is drawn at
   * rest, the same way its arrow is left off.
   */
  get arrival() {
    const previous = this.timeline[this.cursor - 1];
    if (previous === undefined) {
      return { merged: new Set(), appeared: new Set() };
    }
    const state = this.timeline[this.cursor];
    return arrivalCells(previous.cells, state.direction, state.cells);
  }

  static emptyBoard() {
    return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  }

  /**
   * Place a new tile on an empty cell and return that cell's index.
   *
   * A full board is a caller bug, not a case to absorb: reset() spawns onto an empty
   * board, and a move that changed the board always leaves room -- collapsing never
   * fills cells, and a merge on a full board frees one.
   *
   * `direction` is the move that earned the spawn, for the log; the opening two tiles
   * were earned by no move and pass none. It has no bearing on where the tile lands.
   */
  spawnTile(direction = null) {
    const empty = emptyCells(this.cells);
    if (empty.length === 0) {
      throw new Error("No room for a new 2048 tile");
    }
    const [index, value] = this.spawn(empty, this.random);
    this.cells[Math.floor(index / SIZE)][index % SIZE] = value;
    if (this.spawns !== null) {
      this.spawns.push(spawnByte(direction, index, value));
    }
    return index;
  }

  /** Start a new game. Returns the cell indices of the two starting tiles. */
  reset() {
    this.cells = Game.emptyBoard();
    this.score = 0;
    this.moves = 0;
    this.gameOver = false;
    // A fresh game is a clean one however the last was played: what was replayed was
    // that game's history, and this one has none yet.
    this.replayedFrom = null;
    // Emptied before the opening tiles are dealt, so they are the first two entries --
    // and so a game that restored without a log gets one, since this game is being
    // recorded from its own first board and that is the whole requirement.
    this.spawns = [];
    const spawned = [this.spawnTile(), this.spawnTile()];
    // A new game is a new timeline: the old one belonged to a game that is over.
    this.timeline = [captureState(this)];
    this.history = [historyEntry(0, 0)];
    this.cursor = 0;
    return spawned;
  }

  /**
   * Record the state as it now stands, under the move that reached it, and leave the
   * cursor on it.
   *
   * Trimming from the front is what bounds the save; the states dropped are the oldest
   * ones, so the scrubber loses its earliest reach rather than its most recent. The
   * history is appended to and never trimmed, so what the graph can draw is not what
   * the scrubber can reach.
   */
  record(direction = null) {
    this.timeline.push(captureState(this, direction));
    if (this.timeline.length > TIMELINE_LIMIT) {
      this.timeline.shift();
    }
    this.cursor = this.timeline.length - 1;
    this.history.push(historyEntry(this.moves, this.score));
  }

  /** Where `moves` sits in the history, which need not start at move 0 after a restore. */
  historyIndex(moves) {
    return moves - this.history[0].moves;
  }

  /**
   * Show the state at `index`, clamped to the timeline. Returns the index landed on.
   *
   * The state is copied out rather than aliased, so the board a caller then paints --
   * or a later move collapses -- cannot write back into the history it came from.
   */
  seek(index) {
    this.cursor = Math.min(Math.max(Math.trunc(index), 0), this.timeline.length - 1);
    const state = this.timeline[this.cursor];
    this.cells = state.cells.map((row) => row.slice());
    this.score = state.score;
    this.moves = state.moves;
    this.gameOver = state.gameOver;
    return this.cursor;
  }

  /**
   * Resume play from the state at `index`, discarding everything after it. Returns how
   * many states that was; zero means the newest state was already the one asked for and
   * nothing happened.
   *
   * Truncating rather than branching is what keeps this cheap. A prefix of a timeline is
   * a timeline -- its states are still one move apart and its scores still run forward,
   * which is exactly what the save validator checks -- so playing on appends to a
   * shorter history rather than opening a second one, and move() needs no changes at
   * all: the cursor is at the newest state again, so its guard simply stops firing.
   *
   * What that costs is the discarded moves, which are gone from the next save. What it
   * buys is one timeline, one scrubber axis, and one save format.
   *
   * Undo is this and nothing else -- playFrom(cursor - 1) -- which is why there is no
   * separate stack of moves to unwind: the history already is one.
   */
  playFrom(index) {
    const landed = this.seek(index);
    const discarded = this.timeline.length - 1 - landed;
    if (discarded === 0) {
      return 0;
    }

    // One, whether it took back a move or twenty: what is counted is the decision to go
    // back, not how far it reached. How far is already on the axis -- the line simply
    // resumes from an earlier move -- so counting the moves here would draw the same
    // fact twice and make one long reach back look like a game full of second thoughts.
    //
    // The counts on the states being discarded come down with them rather than going
    // with them. Undo pressed twice in a row is the ordinary way to reach that: the
    // first press counts against a state the second one then takes back, and dropping
    // it would erase the record of the first press.
    const at = this.historyIndex(this.moves);
    const undone = this.history
      .slice(at + 1)
      .reduce((sum, entry) => sum + entry.undos, 1);
    this.timeline.length = landed + 1;
    this.history.length = at + 1;
    // The log is truncated with them, so what it holds stays the line of play that
    // actually stands: it is two longer than the move count by construction, and the
    // move being resumed from is this.moves. The spawns being dropped are the ones
    // behind the discarded boards, and replaying the game must deal the tiles the game
    // ends up having been dealt, not the ones it took back.
    if (this.spawns !== null) {
      this.spawns.length = this.moves + SPAWN_LOG_OPENING;
    }
    this.history[at].undos += undone;
    // The clean best comes across rather than being left behind: those points were
    // really scored, before this game had rewritten anything, so taking a move back must
    // not cost a total that had actually been reached. It also puts the replayed track
    // above every score in the timeline at the moment of the fork, which is what lets
    // the whole of a replayed save be measured against that one track.
    this.replayedBest = Math.max(this.replayedBest, this.best);
    // The tile track forks the same way and for the same reason: the tile was really
    // landed before anything was rewritten, so going back must not cost it either.
    this.replayedBestTile = Math.max(this.replayedBestTile, this.bestTile);
    this.replayedFrom = this.moves;
    return discarded;
  }

  /**
   * Collapse the board one direction.
   *
   * Returns null when the move was rejected: an earlier state is being viewed, the
   * game is over, or nothing on the board would have shifted. Otherwise returns what
   * the move did, in the terms the animation needs to replay it. `slidingTiles` holds
   * pre-move values, since a merge sends both source tiles to one cell and the doubled
   * value only appears once they land.
   */
  move(direction) {
    // Play resumes only from the newest state. Branching would go here instead: fork a
    // timeline from the cursor rather than refuse the move.
    if (!this.atLatest || this.gameOver) {
      return null;
    }
    if (!DIRECTIONS.includes(direction)) {
      throw new Error(`Unknown 2048 move direction: ${direction}`);
    }

    const before = this.cells.map((row) => row.slice());
    const mergedCells = new Set();
    const slidingTiles = [];
    let gained = 0;
    let changed = false;

    for (const coordinates of lineCoordinates(direction)) {
      const line = coordinates.map((cell) => before[Math.floor(cell / SIZE)][cell % SIZE]);
      const { merged, mergePositions, sources, gained: lineGained } =
        compressAndMerge(line);

      coordinates.forEach((cell, index) => {
        this.cells[Math.floor(cell / SIZE)][cell % SIZE] = merged[index];
        changed = changed || merged[index] !== line[index];
      });
      for (const index of mergePositions) {
        mergedCells.add(coordinates[index]);
      }
      gained += lineGained;
      sources.forEach((sourceIndices, index) => {
        for (const source of sourceIndices) {
          slidingTiles.push({
            value: line[source],
            from: coordinates[source],
            to: coordinates[index],
          });
        }
      });
    }

    if (!changed) {
      return null;
    }

    this.score += gained;
    const bestChanged = this.score > this.ownBest;
    if (bestChanged) {
      this.setOwnBest(this.score);
    }
    this.moves += 1;
    const spawnedCell = this.spawnTile(direction);
    // Read after the spawn, so what is claimed is the board as it stands rather than as
    // the merge left it: the tile just dealt is on it, and in the opening moves that
    // tile is sometimes the largest one there.
    //
    // Reported separately from the score's own change because the two move apart: a
    // merge that makes a new largest tile is not usually the move that takes the lead on
    // points, and a game can raise one track's figure for thousands of moves without
    // touching the other.
    const bestTileChanged = this.topTile > this.ownBestTile;
    if (bestTileChanged) {
      this.setOwnBestTile(this.topTile);
    }
    this.gameOver = !boardCanMove(this.cells);
    this.record(direction);
    return { mergedCells, slidingTiles, spawnedCell, gained, bestChanged, bestTileChanged };
  }

  restore(saved) {
    this.timeline = saved.timeline.map((state) => captureState(state, state.direction));
    this.history = saved.history.map((entry) =>
      historyEntry(entry.moves, entry.score, entry.undos)
    );
    this.replayedFrom = saved.replayedFrom ?? null;
    // Null where the save carried none, and stays null for the rest of this game: see
    // the field's own note in the constructor. New Game is what clears it, because a new
    // game is recorded from its opening board.
    this.spawns = saved.spawns;
    this.seek(saved.cursor);
    // The boards are their own proof. Whatever the largest tile on this save is, it was
    // really landed, into the track the save says it was played on -- so that track's
    // best tile is at least that high however the stored figure reads, and there is
    // nothing to check the two against each other for. It is also what opens a game
    // saved before any of this existed with its best tile already right, rather than at
    // zero until the next merge happens to raise it.
    this.setOwnBestTile(Math.max(this.ownBestTile, topTileOf(this.latest.cells)));
  }

  /** Serialize for storage. Play time is measured outside, so it is passed in. */
  encode(playSeconds) {
    return JSON.stringify({
      version: STATE_VERSION,
      timeline: this.timeline.map((state) => ({
        board: state.cells,
        score: state.score,
        moves: state.moves,
        game_over: state.gameOver,
        direction: state.direction,
      })),
      history: {
        from: this.history[0].moves,
        score: this.history[0].score,
        gains: this.history.slice(1).map((entry, index) => entry.score - this.history[index].score),
        // Left out where there are none, which is nearly every move of nearly every
        // game: the history is rewritten whole on every save, so a field that is zero
        // thousands of times over is worth not writing.
        ...(this.history.some((entry) => entry.undos > 0) && {
          undos: Object.fromEntries(
            this.history.filter((entry) => entry.undos > 0).map((entry) => [entry.moves, entry.undos])
          ),
        }),
      },
      cursor: this.cursor,
      // Added to the format rather than versioned into it, the same way replayed_from
      // below was and for the same reason. It is also why the absence of this field is
      // not corruption: every save written before the log existed lacks it, and what
      // that means -- a game that cannot be replayed -- is exactly what a game restored
      // from one of those has to be.
      ...(this.spawns !== null && { spawns: encodeSpawnLog(this.spawns) }),
      // Added to the format rather than versioned into it: a reader that does not know
      // the field ignores it and still opens the game, which is what an older build
      // deployed elsewhere would otherwise be unable to do.
      replayed_from: this.replayedFrom,
      play_seconds: playSeconds,
    });
  }
}
