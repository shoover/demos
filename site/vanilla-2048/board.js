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
export const STATE_VERSION = 2;
// Version 1 stored a single state, from before the game kept a timeline. Still read,
// so a game saved by the previous build reopens rather than being called corrupt.
export const LEGACY_STATE_VERSION = 1;
// States kept per game. The whole timeline is rewritten on every save, so it has to be
// bounded by something. A full one measures 92 KB, which encodes in 0.6ms and stores in
// 0.4ms -- a fraction of a frame on the move that writes it, and a fraction of the 5 MB
// localStorage usually offers.
export const TIMELINE_LIMIT = 1000;
const FOUR_SPAWN_CHANCE = 0.1;
const DIRECTIONS = ["up", "down", "left", "right"];

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
 * One point on the timeline: a board, the counters that belong with it, and the move
 * that led to it.
 *
 * The direction is carried by the state a move produced rather than by the state it was
 * played from, so recording one never has to reach back and amend the state before it.
 * What a reader usually wants is the other way round -- the move played *from* a state,
 * which is the direction on the state after it; Game.nextDirection does that lookup.
 *
 * Copied on the way in, so a recorded state can never share a row with the live board
 * and be played on after the fact.
 */
function captureState({ cells, score, moves, gameOver }, direction = null) {
  return { cells: cells.map((row) => row.slice()), score, moves, gameOver, direction };
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
 * Parse and validate a stored save. Throws SaveError on anything unusable.
 *
 * The persisted best scores bound every saved score: a save claiming more points than
 * was ever recorded is inconsistent with itself. Which of the two bounds it is measured
 * against is the save's own business, since the save says whether it was replayed.
 *
 * Returns the whole timeline, which of its states was being viewed, and where play was
 * last resumed from -- the scrub position and the replay point are both part of what a
 * reload has to put back.
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
  if (state.version !== STATE_VERSION && state.version !== LEGACY_STATE_VERSION) {
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

  return { timeline, cursor, playSeconds, replayedFrom };
}

/**
 * The board and its rules. Knows nothing about how it is drawn or stored.
 *
 * The best scores are carried here because they are a function of the score, but
 * persisting them is the caller's job: every move reports whether one changed.
 *
 * Every state the game has been in is kept, oldest first, in `timeline`; `cells` and
 * the counters beside it are always the state at `cursor`. Seeking moves the cursor
 * back through the timeline to look at an earlier board. Play resumes from the newest
 * state, and from any other only by way of playFrom, which makes the state it resumes
 * at the newest one by discarding what came after it.
 */
export class Game {
  constructor({ best = 0, replayedBest = 0, random = Math.random } = {}) {
    this.random = random;
    this.best = requireNonNegativeInt(best, "best score");
    this.replayedBest = requireNonNegativeInt(replayedBest, "replayed best score");
    // The move count play was last resumed at, or null for a game played straight
    // through. A move count rather than a timeline position, because positions shift
    // when the oldest states are trimmed and this has to still name the same move --
    // and because naming the move is what it is for.
    this.replayedFrom = null;
    this.cells = Game.emptyBoard();
    this.score = 0;
    this.moves = 0;
    this.gameOver = false;
    // Recorded straight away, so the cursor indexes a real state from construction on
    // and no caller has to special-case a game that has not been played yet.
    this.timeline = [captureState(this)];
    this.cursor = 0;
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

  /** Raise this game's own track. Which one that is, only the game knows. */
  setOwnBest(score) {
    if (this.replayed) {
      this.replayedBest = score;
    } else {
      this.best = score;
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
   * Place a new tile on a random empty cell and return that cell's index.
   *
   * A full board is a caller bug, not a case to absorb: reset() spawns onto an empty
   * board, and a move that changed the board always leaves room -- collapsing never
   * fills cells, and a merge on a full board frees one.
   */
  spawnTile() {
    const empty = emptyCells(this.cells);
    if (empty.length === 0) {
      throw new Error("No room for a new 2048 tile");
    }
    const index = empty[Math.floor(this.random() * empty.length)];
    this.cells[Math.floor(index / SIZE)][index % SIZE] =
      this.random() < FOUR_SPAWN_CHANCE ? 4 : 2;
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
    const spawned = [this.spawnTile(), this.spawnTile()];
    // A new game is a new timeline: the old one belonged to a game that is over.
    this.timeline = [captureState(this)];
    this.cursor = 0;
    return spawned;
  }

  /**
   * Record the state as it now stands, under the move that reached it, and leave the
   * cursor on it.
   *
   * Trimming from the front is what bounds the save; the states dropped are the oldest
   * ones, so the scrubber loses its earliest reach rather than its most recent.
   */
  record(direction = null) {
    this.timeline.push(captureState(this, direction));
    if (this.timeline.length > TIMELINE_LIMIT) {
      this.timeline.shift();
    }
    this.cursor = this.timeline.length - 1;
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

    this.timeline.length = landed + 1;
    // The clean best comes across rather than being left behind: those points were
    // really scored, before this game had rewritten anything, so taking a move back must
    // not cost a total that had actually been reached. It also puts the replayed track
    // above every score in the timeline at the moment of the fork, which is what lets
    // the whole of a replayed save be measured against that one track.
    this.replayedBest = Math.max(this.replayedBest, this.best);
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
    const spawnedCell = this.spawnTile();
    this.gameOver = !boardCanMove(this.cells);
    this.record(direction);
    return { mergedCells, slidingTiles, spawnedCell, gained, bestChanged };
  }

  restore(saved) {
    this.timeline = saved.timeline.map((state) => captureState(state, state.direction));
    this.replayedFrom = saved.replayedFrom ?? null;
    this.seek(saved.cursor);
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
      cursor: this.cursor,
      // Added to the format rather than versioned into it: a reader that does not know
      // the field ignores it and still opens the game, which is what an older build
      // deployed elsewhere would otherwise be unable to do.
      replayed_from: this.replayedFrom,
      play_seconds: playSeconds,
    });
  }
}
