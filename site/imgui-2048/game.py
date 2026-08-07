import json
import math
import time
from collections import deque
from typing import NamedTuple
from js import window
from imgui_bundle import imgui, immapp, hello_imgui

from board import SIZE, Game, decode_saved_state
from layout import (
    COMPACT_HELP,
    CONTROL_BUTTON_SIZE,
    StyleMetrics,
    compute_layout,
)

# Everything the page exposes to Python, bound once. index.html builds it.
bridge = window.game2048

SAVE_INTERVAL_SECONDS = 5
SAVE_LATENCY_CAPACITY = 256
SAVE_METRICS_REFRESH_SECONDS = 1
NEW_TILE_ANIM_SECONDS = 0.12
MERGE_TILE_ANIM_SECONDS = 0.12
SLIDE_SECONDS = 0.08
# A held key or a hammered button must not start a move before the previous one has
# landed, so the throttle is a property of the slide rather than of any one input
# device. It lives here because both input paths -- the JS key/touch listeners and the
# on-screen buttons, which are imgui widgets JS never sees -- funnel through apply_move.
INPUT_THROTTLE_SECONDS = SLIDE_SECONDS * 1.5
WINDOW_FLAGS = (
    imgui.WindowFlags_.no_title_bar
    | imgui.WindowFlags_.no_resize
    | imgui.WindowFlags_.no_move
    | imgui.WindowFlags_.no_collapse
    | imgui.WindowFlags_.no_saved_settings
    | imgui.WindowFlags_.no_scrollbar
    | imgui.WindowFlags_.no_scroll_with_mouse
)

def load_best_score():
    value = int(bridge.bestScore())
    if value < 0:
        raise ValueError(f"Invalid stored 2048 best score: {value}")
    return value

def save_best_score(value):
    if value < 0:
        raise ValueError(f"Invalid 2048 best score: {value}")
    bridge.setBestScore(int(value))

def ease_out_cubic(t):
    return 1 - (1 - t) ** 3

def ease_in_out_cubic(t):
    # Slides accelerate out of the old cell and settle into the new one, matching the
    # ease-in-out the original game transitions tile transforms with.
    if t < 0.5:
        return 4 * t * t * t
    return 1 - (-2 * t + 2) ** 3 / 2

class TileAnimations:
    """Tile pops and the in-flight slide, replayed from a MoveResult.

    Holds only presentation state: the board itself has already settled by the time a
    move is handed over here.
    """

    def __init__(self):
        self.scales = {}  # (r, c) -> ("new" | "merge", start_time)
        self.sliding = []  # (value, source_cell, destination_cell)
        # Doubles as the throttle's clock. -inf so the first move of a board is never
        # held back; slide_progress only reads it while tiles are actually in flight.
        self.slide_start = -math.inf

    def clear(self):
        self.scales.clear()
        self.sliding.clear()
        # A fresh board owes nothing to the previous move: accept input immediately.
        self.slide_start = -math.inf

    def ready_for_move(self, now):
        return now - self.slide_start >= INPUT_THROTTLE_SECONDS

    def start_game(self, cells, now):
        self.clear()
        for cell in cells:
            self.scales[cell] = ("new", now)

    def start_move(self, result, now):
        self.scales.clear()
        self.sliding[:] = result.sliding_tiles
        self.slide_start = now
        # Tiles travel first; pop and appear only start once they have landed, so a
        # merge reads as two tiles arriving and becoming one.
        landed = now + SLIDE_SECONDS
        for cell in result.merged_cells:
            self.scales[cell] = ("merge", landed)
        self.scales[result.spawned_cell] = ("new", landed)

    def slide_progress(self, now):
        """Eased 0..1 travel of the in-flight tiles, or None once they have landed."""
        if not self.sliding:
            return None
        elapsed = now - self.slide_start
        if elapsed >= SLIDE_SECONDS:
            self.sliding.clear()
            return None
        return ease_in_out_cubic(elapsed / SLIDE_SECONDS)

    def scale(self, r, c, now):
        anim = self.scales.get((r, c))
        if anim is None:
            return 1.0
        kind, start = anim
        duration = NEW_TILE_ANIM_SECONDS if kind == "new" else MERGE_TILE_ANIM_SECONDS
        elapsed = now - start
        if elapsed >= duration:
            del self.scales[(r, c)]
            return 1.0
        # Negative while a tile waits for the slide to finish; hold it at the first frame
        # rather than running the curve backwards.
        t = max(0.0, elapsed / duration)
        if kind == "new":
            # Grow in from 60% size rather than popping from nothing.
            return 0.6 + ease_out_cubic(t) * 0.4
        # Merge: nudge past full size (1 -> 1.08) then settle back (1.08 -> 1).
        if t < 0.5:
            return 1 + ease_out_cubic(t / 0.5) * 0.08
        return 1.08 - ease_out_cubic((t - 0.5) / 0.5) * 0.08

class SaveTracker:
    """Persists game state through the bridge and reports how long the writes take."""

    def __init__(self):
        self.last_save_time = 0
        self.last_state = None
        self.latencies_ms = deque(maxlen=SAVE_LATENCY_CAPACITY)
        self.percentiles = None
        self.last_metrics_refresh = 0

    def defer(self):
        """Restart the interval without writing: storage already holds this state."""
        self.last_save_time = time.time()

    def save(self, game, play_seconds):
        started_at = time.perf_counter()
        serialized = game.encode(play_seconds)
        bridge.setState(serialized)
        self.latencies_ms.append((time.perf_counter() - started_at) * 1000)
        self.last_save_time = time.time()
        self.last_state = serialized

    def save_if_due(self, game, play_seconds):
        """Interval save, skipped when the snapshot would be byte-identical.

        Play time is the only field that moves without a move being made, so once the
        board is finished -- or merely idle, since the play clock pauses with the tab --
        the interval save would rewrite the same bytes until the tab closes.
        """
        if time.time() - self.last_save_time < SAVE_INTERVAL_SECONDS:
            return
        if game.encode(play_seconds) == self.last_state:
            self.defer()
            return
        self.save(game, play_seconds)

    def refresh_metrics(self):
        now = time.time()
        if now - self.last_metrics_refresh < SAVE_METRICS_REFRESH_SECONDS:
            return
        self.last_metrics_refresh = now

        samples = sorted(self.latencies_ms)
        if not samples:
            self.percentiles = None
            return

        def percentile(fraction):
            position = (len(samples) - 1) * fraction
            lower = math.floor(position)
            upper = math.ceil(position)
            if lower == upper:
                return samples[lower]
            weight = position - lower
            return samples[lower] * (1 - weight) + samples[upper] * weight

        self.percentiles = (percentile(0.50), percentile(0.90), percentile(0.99))

    def summary(self):
        if self.percentiles is None:
            return "collecting"
        p50, p90, p99 = self.percentiles
        return f"{p50:.0f}/{p90:.0f}/{p99:.0f} ms"

class Hud:
    """Status line, plus the one-shot share request the Share button raises."""

    def __init__(self):
        self.message = "Join matching tiles to reach 2048."
        self.share_pending = False

def start_new_game():
    spawned = game.reset()
    animations.start_game(spawned, time.perf_counter())
    bridge.setPlayTime(0, False)
    hud.message = "New game. Use arrow keys, WASD, or the buttons."
    saver.save(game, 0)

def apply_move(direction):
    now = time.perf_counter()
    if not animations.ready_for_move(now):
        return

    result = game.move(direction)
    if result is None:
        return

    animations.start_move(result, now)
    # The clock runs from the first move until the board locks, which is exactly
    # "a move just happened and the game is not over".
    play_seconds = bridge.playTime()
    bridge.setPlayTime(play_seconds, not game.game_over)
    if result.best_changed:
        save_best_score(game.best)
    if game.game_over:
        hud.message = "No moves left. Press R or New Game."
    else:
        hud.message = ""
    saver.save(game, play_seconds)

def load_game_state():
    if not bridge.hasState():
        return False
    saved = decode_saved_state(bridge.state(), game.best)
    game.restore(saved)
    bridge.setPlayTime(
        saved.play_seconds,
        saved.moves > 0 and not saved.game_over,
    )
    return True

def process_keyboard():
    for key in bridge.popInput():
        if key == "restart":
            start_new_game()
        else:
            apply_move(key)

def viewport():
    data = bridge.viewport()
    width = max(1, int(data.width))
    height = max(1, int(data.height))
    return width, height, bool(data.compact)

def window_layout():
    width, height, compact = viewport()
    style = imgui.get_style()
    padding_x, padding_y = vec_xy(style.window_padding)
    _, spacing_y = vec_xy(style.item_spacing)
    return compute_layout(width, height, compact, StyleMetrics(
        padding_x=padding_x,
        padding_y=padding_y,
        spacing_y=spacing_y,
        line_height=imgui.get_text_line_height_with_spacing(),
        frame_height=imgui.get_frame_height_with_spacing(),
    ))

# Packed ABGR, the byte order the draw list takes directly. Converted once at import:
# the alternative is 16 to 32 conversions every frame, each one crossing into C++.
TILE_TEXT_COLOR = 0xffffffff

def _packed(r, g, b):
    # Dear ImGui takes normalized RGBA floats; the draw list wants them packed.
    return imgui.color_convert_float4_to_u32(imgui.ImVec4(r, g, b, 1.0))

# Value 0 is the empty grid cell.
TILE_COLORS = {
    0:    _packed(0.20, 0.22, 0.27),
    2:    _packed(0.40, 0.48, 0.60),
    4:    _packed(0.32, 0.53, 0.70),
    8:    _packed(0.24, 0.62, 0.72),
    16:   _packed(0.20, 0.68, 0.58),
    32:   _packed(0.44, 0.70, 0.34),
    64:   _packed(0.70, 0.66, 0.25),
    128:  _packed(0.78, 0.53, 0.24),
    256:  _packed(0.78, 0.38, 0.28),
    512:  _packed(0.72, 0.28, 0.42),
    1024: _packed(0.60, 0.30, 0.62),
    2048: _packed(0.45, 0.35, 0.85),
}
BEYOND_2048_COLOR = _packed(0.30, 0.24, 0.55)

def vec_xy(value):
    if hasattr(value, "x"):
        return value.x, value.y
    return value[0], value[1]

class TilePainter(NamedTuple):
    """Paints tiles, holding the per-frame imgui handles the tile loops would refetch.

    Tiles are painted rather than laid out: they overlap, move between cells, and scale
    independently of the grid, none of which a widget would agree to do. The board
    reserves its space once, with the dummy at the end of draw_board.
    """

    draw_list: object
    font: object
    base_font_size: float
    rounding: float

    def tile(self, x, y, size, value):
        """Draw one tile square at an absolute screen position. value 0 is a grid cell."""
        self.draw_list.add_rect_filled(
            (x, y),
            (x + size, y + size),
            TILE_COLORS.get(value, BEYOND_2048_COLOR),
            self.rounding,
        )
        if value:
            self.number(value, x, y, size)

    def number(self, value, x, y, size):
        text = str(value)
        if value < 128:
            font_size = size * 0.50
        elif value < 1024:
            font_size = size * 0.43
        else:
            font_size = size * 0.36
        base_width, base_height = vec_xy(imgui.calc_text_size(text))
        scale = font_size / self.base_font_size
        width, height = base_width * scale, base_height * scale
        self.draw_list.add_text(
            self.font,
            font_size,
            (x + (size - width) / 2, y + (size - height) / 2),
            TILE_TEXT_COLOR,
            text,
        )

def draw_board(layout):
    cell, gap = layout.cell, layout.gap
    available_width, _ = vec_xy(imgui.get_content_region_avail())
    indent = max(0, (available_width - layout.board_width) / 2)
    now = time.perf_counter()

    imgui.indent(indent)
    origin_x, origin_y = vec_xy(imgui.get_cursor_screen_pos())
    painter = TilePainter(
        draw_list=imgui.get_window_draw_list(),
        font=imgui.get_font(),
        base_font_size=imgui.get_font_size(),
        rounding=imgui.get_style().frame_rounding,
    )

    # Background grid stays static and full-size; animated tiles draw on top of it.
    for r in range(SIZE):
        for c in range(SIZE):
            painter.tile(
                origin_x + c * (cell + gap),
                origin_y + r * (cell + gap),
                cell,
                0,
            )

    progress = animations.slide_progress(now)
    if progress is not None:
        # Mid-flight: draw the tiles travelling from their old cells rather than the
        # settled board, so a merge shows both tiles converging on the same square.
        # The tile spawned by this move is held back until they land.
        for value, source, destination in animations.sliding:
            from_r, from_c = source
            to_r, to_c = destination
            r = from_r + (to_r - from_r) * progress
            c = from_c + (to_c - from_c) * progress
            painter.tile(
                origin_x + c * (cell + gap),
                origin_y + r * (cell + gap),
                cell,
                value,
            )
    else:
        for r in range(SIZE):
            for c in range(SIZE):
                value = game.cells[r][c]
                if not value:
                    continue
                tile_size = cell * animations.scale(r, c, now)
                if tile_size < 1:
                    continue
                offset = (cell - tile_size) / 2
                painter.tile(
                    origin_x + c * (cell + gap) + offset,
                    origin_y + r * (cell + gap) + offset,
                    tile_size,
                    value,
                )

    imgui.set_cursor_screen_pos((origin_x, origin_y))
    imgui.dummy((layout.board_width, layout.board_width))
    imgui.unindent(indent)

def controls():
    button_width, _ = CONTROL_BUTTON_SIZE
    available_width, _ = vec_xy(imgui.get_content_region_avail())
    spacing_x, _ = vec_xy(imgui.get_style().item_spacing)
    gap = 36
    row_width = button_width * 3 + spacing_x * 2 + gap
    group_indent = max(0, (available_width - row_width) / 2)
    up_indent = (button_width + spacing_x) * 2 + gap

    imgui.indent(group_indent)
    imgui.indent(up_indent)
    if imgui.button("^##up", CONTROL_BUTTON_SIZE):
        apply_move("up")
    imgui.unindent(up_indent)

    if imgui.button("<##left", CONTROL_BUTTON_SIZE):
        apply_move("left")
    imgui.same_line()
    if imgui.button(">##right", CONTROL_BUTTON_SIZE):
        apply_move("right")
    imgui.same_line(0, spacing_x + gap)
    if imgui.button("v##down", CONTROL_BUTTON_SIZE):
        apply_move("down")
    imgui.unindent(group_indent)

def gui():
    process_keyboard()
    # One crossing per frame: every reader below wants the same instant anyway.
    play_seconds = float(bridge.playTime())
    saver.save_if_due(game, play_seconds)
    saver.refresh_metrics()

    layout = window_layout()
    imgui.set_next_window_pos((layout.x, layout.y), imgui.Cond_.always)
    imgui.set_next_window_size((layout.width, layout.height), imgui.Cond_.always)
    imgui.begin("2048 in Python / Dear ImGui / WebAssembly", None, WINDOW_FLAGS)

    imgui.text(
        f"Score: {game.score:,}  |  Moves: {game.moves:,}  |  Best: {game.best:,}"
    )
    score_min_x, score_top = vec_xy(imgui.get_item_rect_min())
    _, score_bottom = vec_xy(imgui.get_item_rect_max())

    if imgui.button("New Game"):
        start_new_game()
    imgui.same_line()
    if imgui.button("Share"):
        hud.share_pending = True
    if layout.help_placement == COMPACT_HELP:
        imgui.text("Swipe to move. R restarts.")
    else:
        imgui.text_wrapped("Keyboard: arrows/WASD, swipe, R to restart")

    imgui.separator()
    _, body_top = vec_xy(imgui.get_cursor_screen_pos())
    draw_board(layout)
    imgui.separator()

    imgui.text(hud.message)

    imgui.text(
        f"FPS: {hello_imgui.frame_rate():.0f}"
        f" | Play time: {play_seconds:.0f}s"
        f" | Save p50/90/99: {saver.summary()}"
    )
    _, body_bottom = vec_xy(imgui.get_item_rect_max())
    controls()

    # Queue the capture for the end of this frame: JS reads the pixels once imgui has
    # rendered them but before the browser composites the canvas away, so these rects
    # describe exactly the frame that gets captured.
    if hud.share_pending:
        hud.share_pending = False
        window_x, _ = vec_xy(imgui.get_window_pos())
        content_width = layout.content_width
        # Still a JSON string: this crosses once per Share click, not per frame, and a
        # nested payload is cheaper to hand over as text than to convert field by field.
        bridge.share(json.dumps({
            "sections": [
                {
                    "x": score_min_x,
                    "y": score_top,
                    "width": content_width,
                    "height": score_bottom - score_top,
                },
                {
                    "x": score_min_x,
                    "y": body_top,
                    "width": content_width,
                    "height": body_bottom - body_top,
                },
            ],
            # A point inside the window padding, left of the content, so the padding
            # around the stacked sections matches the window background exactly.
            "background": {"x": window_x + 3, "y": score_top + 2},
            "filename": f"2048-score-{game.score}.png",
            "title": "2048",
            "text": f"2048: {game.score:,} points in {game.moves:,} moves.",
        }))

    imgui.end()

def start():
    """Restore or begin a game. False means startup stalled on a corrupt save."""
    try:
        restored = load_game_state()
    except ValueError as error:
        # Rejecting the save is right, but raising here only reaches the "Startup
        # failed" overlay, and the next reload reads the same bad key: the page is
        # bricked. Escalate to the user with the reason and an action instead of
        # either dead-ending or quietly overwriting what they had.
        bridge.reportCorruptState(str(error))
        return False

    if restored:
        hud.message = "Saved game restored."
        if game.game_over:
            hud.message += " No moves left. Press R or New Game."
        saver.defer()
    else:
        start_new_game()
    return True

game = Game(best=load_best_score())
animations = TileAnimations()
saver = SaveTracker()
hud = Hud()

if start():
    # Only now is there a game to receive input: keys pressed while Pyodide loaded are
    # dropped rather than queued up to fire all at once on the first frame, and a
    # corrupt save leaves input off while the recovery overlay is up.
    bridge.setAcceptingInput(True)
    immapp.run(
        gui,
        window_title="2048 with imgui-bundle + Pyodide",
        window_size=(720, 760),
        fps_idle=0,
    )
