"""Pure 2048 rules: line collapsing, move results, and save-state validation.

Imports nothing from the browser or imgui, so it runs -- and is tested -- under
plain CPython. game.py keeps everything that touches the page: the imgui frame,
animation timing, and the localStorage bridge.
"""

import json
import math
import random
from typing import NamedTuple

SIZE = 4
STATE_VERSION = 2
LEGACY_STATE_VERSION = 1
FOUR_SPAWN_CHANCE = 0.10

class MoveResult(NamedTuple):
    """What a move did, in the terms the animation needs to replay it."""

    merged_cells: set
    # (value, (from_r, from_c), (to_r, to_c)) for every tile in flight. Holds
    # pre-move values: a merge sends both source tiles to one cell, and the doubled
    # value only appears once they land.
    sliding_tiles: list
    spawned_cell: tuple
    gained: int
    best_changed: bool

class SavedState(NamedTuple):
    cells: list
    score: int
    moves: int
    game_over: bool
    play_seconds: float

def is_valid_tile(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and (value == 0 or (value >= 2 and value & (value - 1) == 0))
    )

def require_nonnegative_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"Invalid saved 2048 {name}: {value!r}")
    return value

def validate_saved_board(value):
    if (
        not isinstance(value, list)
        or len(value) != SIZE
        or any(not isinstance(row, list) or len(row) != SIZE for row in value)
        or any(not is_valid_tile(tile) for row in value for tile in row)
    ):
        raise ValueError("Invalid saved 2048 board")
    return [row[:] for row in value]

def empty_cells(cells):
    return [(r, c) for r in range(SIZE) for c in range(SIZE) if cells[r][c] == 0]

def board_can_move(cells):
    if any(tile == 0 for row in cells for tile in row):
        return True
    for r in range(SIZE):
        for c in range(SIZE):
            if r + 1 < SIZE and cells[r][c] == cells[r + 1][c]:
                return True
            if c + 1 < SIZE and cells[r][c] == cells[r][c + 1]:
                return True
    return False

def line_coordinates(direction):
    """Board cells per line, ordered so index 0 is the edge tiles collapse toward.

    Sliding needs each tile's origin and destination as board cells, so every direction
    is expressed as an ordered coordinate list and collapsed by one shared loop.
    """
    if direction == "left":
        return [[(r, c) for c in range(SIZE)] for r in range(SIZE)]
    if direction == "right":
        return [[(r, c) for c in reversed(range(SIZE))] for r in range(SIZE)]
    if direction == "up":
        return [[(r, c) for r in range(SIZE)] for c in range(SIZE)]
    if direction == "down":
        return [[(r, c) for r in reversed(range(SIZE))] for c in range(SIZE)]
    raise ValueError(f"Unknown 2048 move direction: {direction!r}")

def compress_and_merge(line):
    """Collapse one line toward index 0.

    Returns (merged, merge_positions, sources, gained). sources[j] lists the indices in
    the input line whose tiles ended up at output index j -- one entry normally, two for
    a merge -- which is what lets each tile be animated from its old cell to its new one.
    """
    values = [(index, value) for index, value in enumerate(line) if value]
    merged = []
    merge_positions = set()
    sources = []
    gained = 0
    i = 0
    while i < len(values):
        if i + 1 < len(values) and values[i][1] == values[i + 1][1]:
            new_value = values[i][1] * 2
            merged.append(new_value)
            merge_positions.add(len(merged) - 1)
            sources.append([values[i][0], values[i + 1][0]])
            gained += new_value
            i += 2
        else:
            merged.append(values[i][1])
            sources.append([values[i][0]])
            i += 1
    merged += [0] * (SIZE - len(merged))
    return merged, merge_positions, sources, gained

def decode_saved_state(serialized, best):
    """Parse and validate a stored save. Raises ValueError on anything unusable.

    `best` is the persisted best score, which bounds the saved score: a save claiming
    more points than the best score ever recorded is inconsistent with itself.
    """
    try:
        state = json.loads(serialized)
    except json.JSONDecodeError as error:
        raise ValueError("Invalid saved 2048 game state JSON") from error

    if not isinstance(state, dict):
        raise ValueError("Invalid saved 2048 game state")
    version = state.get("version")
    if version not in (LEGACY_STATE_VERSION, STATE_VERSION):
        raise ValueError("Unsupported saved 2048 game state version")

    cells = validate_saved_board(state.get("board"))
    score = require_nonnegative_int(state.get("score"), "score")
    moves = require_nonnegative_int(state.get("moves"), "move count")
    game_over = state.get("game_over")
    play_seconds = 0 if version == LEGACY_STATE_VERSION else state.get("play_seconds")

    if not isinstance(game_over, bool):
        raise ValueError(f"Invalid saved 2048 game-over state: {game_over!r}")
    if (
        isinstance(play_seconds, bool)
        or not isinstance(play_seconds, (int, float))
        or not math.isfinite(play_seconds)
        or play_seconds < 0
    ):
        raise ValueError(f"Invalid saved 2048 play time: {play_seconds!r}")
    if score > best:
        raise ValueError(f"Saved 2048 score {score} exceeds best score {best}")
    if game_over == board_can_move(cells):
        raise ValueError("Saved 2048 game-over state does not match the board")

    return SavedState(cells, score, moves, game_over, float(play_seconds))

class Game:
    """The board and its rules. Knows nothing about how it is drawn or stored.

    `best` is carried here because it is a function of the score, but persisting it is
    the caller's job: every move reports whether the best score changed.
    """

    def __init__(self, best=0, rng=None):
        self.rng = random.Random() if rng is None else rng
        self.best = require_nonnegative_int(best, "best score")
        self.cells = [[0] * SIZE for _ in range(SIZE)]
        self.score = 0
        self.moves = 0
        self.game_over = False

    def spawn_tile(self):
        """Place a new tile on a random empty cell and return that cell.

        A full board is a caller bug, not a case to absorb: reset() spawns onto an
        empty board, and a move that changed the board always leaves room -- collapsing
        never fills cells, and a merge on a full board frees one.
        """
        cells = empty_cells(self.cells)
        if not cells:
            raise RuntimeError("No room for a new 2048 tile")
        r, c = self.rng.choice(cells)
        self.cells[r][c] = 4 if self.rng.random() < FOUR_SPAWN_CHANCE else 2
        return (r, c)

    def reset(self):
        """Start a new game. Returns the cells of the two starting tiles."""
        self.cells = [[0] * SIZE for _ in range(SIZE)]
        self.score = 0
        self.moves = 0
        self.game_over = False
        return [self.spawn_tile() for _ in range(2)]

    def move(self, direction):
        """Collapse the board one direction.

        Returns a MoveResult, or None when the move was rejected: the game is over, or
        nothing on the board would have shifted.
        """
        if self.game_over:
            return None

        before = [row[:] for row in self.cells]
        merged_cells = set()
        sliding_tiles = []
        gained = 0

        for coordinates in line_coordinates(direction):
            line = [self.cells[r][c] for r, c in coordinates]
            merged, merge_positions, sources, line_gained = compress_and_merge(line)
            for index, (r, c) in enumerate(coordinates):
                self.cells[r][c] = merged[index]
            merged_cells.update(coordinates[index] for index in merge_positions)
            gained += line_gained
            for index, source_indices in enumerate(sources):
                destination = coordinates[index]
                for source_index in source_indices:
                    sliding_tiles.append(
                        (line[source_index], coordinates[source_index], destination)
                    )

        if self.cells == before:
            return None

        self.score += gained
        best_changed = self.score > self.best
        if best_changed:
            self.best = self.score
        self.moves += 1
        spawned_cell = self.spawn_tile()
        self.game_over = not board_can_move(self.cells)
        return MoveResult(
            merged_cells, sliding_tiles, spawned_cell, gained, best_changed
        )

    def restore(self, saved):
        self.cells = saved.cells
        self.score = saved.score
        self.moves = saved.moves
        self.game_over = saved.game_over

    def encode(self, play_seconds):
        """Serialize for storage. Play time is measured outside, so it is passed in."""
        return json.dumps({
            "version": STATE_VERSION,
            "board": self.cells,
            "score": self.score,
            "moves": self.moves,
            "game_over": self.game_over,
            "play_seconds": float(play_seconds),
        }, separators=(",", ":"))
