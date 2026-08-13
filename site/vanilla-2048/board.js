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
 * A game keeps every state it has been in, so an earlier board can be looked at again;
 * see the Game class for how the timeline and the cursor into it fit together.
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
 * `best` is the persisted best score, which bounds every saved score: a save claiming
 * more points than the best score ever recorded is inconsistent with itself.
 *
 * Returns the whole timeline and which of its states was being viewed, since the scrub
 * position is part of what a reload has to put back.
 */
export function decodeSavedState(serialized, best) {
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

  const timeline = [];
  for (const entry of savedStates(state)) {
    timeline.push(decodeState(entry, best, timeline.at(-1) ?? null));
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

  return { timeline, cursor, playSeconds };
}

/**
 * The board and its rules. Knows nothing about how it is drawn or stored.
 *
 * `best` is carried here because it is a function of the score, but persisting it is
 * the caller's job: every move reports whether the best score changed.
 *
 * Every state the game has been in is kept, oldest first, in `timeline`; `cells` and
 * the counters beside it are always the state at `cursor`. Seeking moves the cursor
 * back through the timeline to look at an earlier board; play only ever resumes from
 * the newest state, which is the one the cursor sits on until it is moved.
 */
export class Game {
  constructor({ best = 0, random = Math.random } = {}) {
    this.random = random;
    this.best = requireNonNegativeInt(best, "best score");
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
    const bestChanged = this.score > this.best;
    if (bestChanged) {
      this.best = this.score;
    }
    this.moves += 1;
    const spawnedCell = this.spawnTile();
    this.gameOver = !boardCanMove(this.cells);
    this.record(direction);
    return { mergedCells, slidingTiles, spawnedCell, gained, bestChanged };
  }

  restore(saved) {
    this.timeline = saved.timeline.map((state) => captureState(state, state.direction));
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
      play_seconds: playSeconds,
    });
  }
}
