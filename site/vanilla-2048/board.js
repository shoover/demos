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
 */

export const SIZE = 4;
export const STATE_VERSION = 1;
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
 * Parse and validate a stored save. Throws SaveError on anything unusable.
 *
 * `best` is the persisted best score, which bounds the saved score: a save claiming
 * more points than the best score ever recorded is inconsistent with itself.
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
  if (state.version !== STATE_VERSION) {
    throw new SaveError("Unsupported saved 2048 game state version");
  }

  const cells = validateSavedBoard(state.board);
  const score = requireNonNegativeInt(state.score, "score");
  const moves = requireNonNegativeInt(state.moves, "move count");
  const gameOver = state.game_over;
  const playSeconds = state.play_seconds;

  if (typeof gameOver !== "boolean") {
    throw new SaveError(
      `Invalid saved 2048 game-over state: ${JSON.stringify(gameOver)}`
    );
  }
  if (typeof playSeconds !== "number" || !Number.isFinite(playSeconds) || playSeconds < 0) {
    throw new SaveError(
      `Invalid saved 2048 play time: ${JSON.stringify(playSeconds)}`
    );
  }
  if (score > best) {
    throw new SaveError(`Saved 2048 score ${score} exceeds best score ${best}`);
  }
  if (gameOver === boardCanMove(cells)) {
    throw new SaveError("Saved 2048 game-over state does not match the board");
  }

  return { cells, score, moves, gameOver, playSeconds };
}

/**
 * The board and its rules. Knows nothing about how it is drawn or stored.
 *
 * `best` is carried here because it is a function of the score, but persisting it is
 * the caller's job: every move reports whether the best score changed.
 */
export class Game {
  constructor({ best = 0, random = Math.random } = {}) {
    this.random = random;
    this.best = requireNonNegativeInt(best, "best score");
    this.cells = Game.emptyBoard();
    this.score = 0;
    this.moves = 0;
    this.gameOver = false;
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
    return [this.spawnTile(), this.spawnTile()];
  }

  /**
   * Collapse the board one direction.
   *
   * Returns null when the move was rejected: the game is over, or nothing on the
   * board would have shifted. Otherwise returns what the move did, in the terms the
   * animation needs to replay it. `slidingTiles` holds pre-move values, since a merge
   * sends both source tiles to one cell and the doubled value only appears once they
   * land.
   */
  move(direction) {
    if (this.gameOver) {
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
    return { mergedCells, slidingTiles, spawnedCell, gained, bestChanged };
  }

  restore(saved) {
    this.cells = saved.cells;
    this.score = saved.score;
    this.moves = saved.moves;
    this.gameOver = saved.gameOver;
  }

  /** Serialize for storage. Play time is measured outside, so it is passed in. */
  encode(playSeconds) {
    return JSON.stringify({
      version: STATE_VERSION,
      board: this.cells,
      score: this.score,
      moves: this.moves,
      game_over: this.gameOver,
      play_seconds: playSeconds,
    });
  }
}
