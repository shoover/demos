import json
import math
import time
from collections import deque
from js import window
from imgui_bundle import imgui, immapp, hello_imgui

from board import SIZE, Game, decode_saved_state

SAVE_INTERVAL_SECONDS = 5
SAVE_LATENCY_CAPACITY = 256
SAVE_METRICS_REFRESH_SECONDS = 1
DESKTOP_CELL = 92
DESKTOP_BOARD_GAP = 8
BOARD_MARGIN = 14
CONTROL_BUTTON_SIZE = (74, 60)
NEW_TILE_ANIM_SECONDS = 0.12
MERGE_TILE_ANIM_SECONDS = 0.12
SLIDE_SECONDS = 0.08
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
    value = int(window.__get2048BestScore())
    if value < 0:
        raise ValueError(f"Invalid stored 2048 best score: {value}")
    return value

def save_best_score(value):
    if value < 0:
        raise ValueError(f"Invalid 2048 best score: {value}")
    window.__set2048BestScore(int(value))

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
        self.slide_start = 0

    def clear(self):
        self.scales.clear()
        self.sliding.clear()

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

    def save(self, game):
        started_at = time.perf_counter()
        serialized = game.encode(window.__get2048PlayTime())
        window.__set2048GameState(serialized)
        self.latencies_ms.append((time.perf_counter() - started_at) * 1000)
        self.last_save_time = time.time()
        self.last_state = serialized

    def save_if_due(self, game):
        """Interval save, skipped when the snapshot would be byte-identical.

        Play time is the only field that moves without a move being made, so once the
        board is finished -- or merely idle, since the play clock pauses with the tab --
        the interval save would rewrite the same bytes until the tab closes.
        """
        if time.time() - self.last_save_time < SAVE_INTERVAL_SECONDS:
            return
        if game.encode(window.__get2048PlayTime()) == self.last_state:
            self.defer()
            return
        self.save(game)

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

        self.percentiles = (
            percentile(0.50),
            percentile(0.90),
            percentile(0.99),
            len(samples),
        )

    def summary(self):
        if self.percentiles is None:
            return "collecting"
        p50, p90, p99, _ = self.percentiles
        return f"{p50:.0f}/{p90:.0f}/{p99:.0f} ms"

class Hud:
    """Status line, plus the one-shot share request the Share button raises."""

    def __init__(self):
        self.message = "Join matching tiles to reach 2048."
        self.share_pending = False

def start_new_game():
    spawned = game.reset()
    animations.start_game(spawned, time.perf_counter())
    window.__set2048PlayTime(0, False)
    hud.message = "New game. Use arrow keys, WASD, or the buttons."
    saver.save(game)

def apply_move(direction):
    result = game.move(direction)
    if result is None:
        return

    animations.start_move(result, time.perf_counter())
    window.__start2048PlayTime()
    if result.best_changed:
        save_best_score(game.best)
    if game.game_over:
        window.__pause2048PlayTime()
        hud.message = "No moves left. Press R or New Game."
    else:
        hud.message = ""
    saver.save(game)

def load_game_state():
    if not bool(window.__has2048GameState()):
        return False
    saved = decode_saved_state(str(window.__get2048GameState()), game.best)
    game.restore(saved)
    window.__set2048PlayTime(
        saved.play_seconds,
        saved.moves > 0 and not saved.game_over,
    )
    return True

def process_keyboard():
    for key in json.loads(window.__pop2048Keys()):
        if key == "restart":
            start_new_game()
        else:
            apply_move(key)

def viewport():
    data = json.loads(window.__game2048Viewport())
    width = max(1, int(data["width"]))
    height = max(1, int(data["height"]))
    compact = bool(data["compact"]) or width < 700
    return width, height, compact

def window_layout():
    width, height, compact = viewport()
    margin = 6 if compact else 14
    style = imgui.get_style()
    padding_x, padding_y = vec_xy(style.window_padding)
    _, spacing_y = vec_xy(style.item_spacing)
    board_gap = 6 if compact else DESKTOP_BOARD_GAP
    board_margin = 8 if compact else BOARD_MARGIN
    desired_board_width = DESKTOP_CELL * SIZE + board_gap * (SIZE - 1)
    available_width = max(1, width - margin * 2)
    available_height = max(1, height - margin * 2)

    max_board_by_width = max(1, available_width - padding_x * 2 - board_margin * 2)
    initial_board_width = min(desired_board_width, max_board_by_width)
    initial_content_width = initial_board_width + board_margin * 2

    line_height = imgui.get_text_line_height_with_spacing()
    controls_height = CONTROL_BUTTON_SIZE[1] * 2 + spacing_y
    header_lines = 2 if compact else 1

    def chrome_height(help_lines):
        """Everything stacked above and below the board, for a given help-line count."""
        return (
            padding_y * 2
            + line_height * header_lines
            + imgui.get_frame_height_with_spacing()
            + line_height * help_lines
            + line_height * 2
            + controls_height
            + spacing_y * 4
            + board_margin * 2
        )

    def help_lines_for(content_width):
        return 1 if compact or content_width < 500 else 0

    # Chicken and egg: the board is sized by the height the chrome leaves it, but the
    # help text wraps to a second line based on the width that board then implies. Size
    # the board against an estimate from the width-limited board, then recompute the
    # chrome once the final content width is known.
    board_width = min(
        desired_board_width,
        max_board_by_width,
        max(1, available_height - chrome_height(help_lines_for(initial_content_width))),
    )
    window_width = min(
        board_width + board_margin * 2 + padding_x * 2,
        available_width,
    )
    content_width = max(1, window_width - padding_x * 2)
    window_height = min(
        chrome_height(help_lines_for(content_width)) + board_width,
        available_height,
    )
    x = max(margin, (width - window_width) / 2)
    y = max(margin, (height - window_height) / 2)
    return {
        "margin": margin,
        "x": x,
        "y": y,
        "width": window_width,
        "height": window_height,
        "board_width": board_width,
        "content_width": content_width,
        "compact": compact,
    }

def tile_color(value):
    # Dear ImGui expects normalized RGBA floats.
    palette = {
        0:    (0.20, 0.22, 0.27, 1.0),
        2:    (0.40, 0.48, 0.60, 1.0),
        4:    (0.32, 0.53, 0.70, 1.0),
        8:    (0.24, 0.62, 0.72, 1.0),
        16:   (0.20, 0.68, 0.58, 1.0),
        32:   (0.44, 0.70, 0.34, 1.0),
        64:   (0.70, 0.66, 0.25, 1.0),
        128:  (0.78, 0.53, 0.24, 1.0),
        256:  (0.78, 0.38, 0.28, 1.0),
        512:  (0.72, 0.28, 0.42, 1.0),
        1024: (0.60, 0.30, 0.62, 1.0),
        2048: (0.45, 0.35, 0.85, 1.0),
    }
    return palette.get(value, (0.30, 0.24, 0.55, 1.0))

def vec_xy(value):
    if hasattr(value, "x"):
        return value.x, value.y
    return value[0], value[1]

def text_size(text, font_size):
    base_width, base_height = vec_xy(imgui.calc_text_size(text))
    scale = font_size / imgui.get_font_size()
    return base_width * scale, base_height * scale

def draw_large_tile_number(value, cell):
    if not value:
        return

    draw_list = imgui.get_window_draw_list()
    tile_min = imgui.get_item_rect_min()
    tile_max = imgui.get_item_rect_max()
    min_x, min_y = vec_xy(tile_min)
    max_x, max_y = vec_xy(tile_max)

    text = str(value)
    tile_width = max_x - min_x
    tile_height = max_y - min_y
    if value < 128:
        font_size = cell * 0.50
    elif value < 1024:
        font_size = cell * 0.43
    else:
        font_size = cell * 0.36
    width, height = text_size(text, font_size)
    x = min_x + (tile_width - width) / 2
    y = min_y + (tile_height - height) / 2
    draw_list.add_text(imgui.get_font(), font_size, (x, y), 0xffffffff, text)

def board_metrics(target_board_width, compact):
    gap = 6 if compact else DESKTOP_BOARD_GAP
    cell = int((target_board_width - gap * (SIZE - 1)) / SIZE)
    cell = max(36, min(DESKTOP_CELL, cell))
    return cell, gap

def draw_tile(label, x, y, size, value):
    """Draw one tile square at an absolute screen position. value 0 draws a grid cell."""
    imgui.set_cursor_screen_pos((x, y))
    color = tile_color(value)
    imgui.push_style_color(imgui.Col_.button, color)
    imgui.push_style_color(imgui.Col_.button_hovered, color)
    imgui.push_style_color(imgui.Col_.button_active, color)
    imgui.button(label, (size, size))
    draw_large_tile_number(value, size)
    imgui.pop_style_color(3)

def draw_board(layout):
    cell, gap = board_metrics(layout["board_width"], layout["compact"])
    available_width, _ = vec_xy(imgui.get_content_region_avail())
    board_width = cell * SIZE + gap * (SIZE - 1)
    indent = max(0, (available_width - board_width) / 2)
    now = time.perf_counter()

    imgui.indent(indent)
    origin_x, origin_y = vec_xy(imgui.get_cursor_screen_pos())

    # Background grid stays static and full-size; animated tiles draw on top of it.
    for r in range(SIZE):
        for c in range(SIZE):
            draw_tile(
                f"##cell_{r}_{c}",
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
        for index, (value, source, destination) in enumerate(animations.sliding):
            from_r, from_c = source
            to_r, to_c = destination
            r = from_r + (to_r - from_r) * progress
            c = from_c + (to_c - from_c) * progress
            draw_tile(
                f"##slide_{index}",
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
                draw_tile(
                    f"##tile_{r}_{c}",
                    origin_x + c * (cell + gap) + offset,
                    origin_y + r * (cell + gap) + offset,
                    tile_size,
                    value,
                )

    imgui.set_cursor_screen_pos((origin_x, origin_y))
    imgui.dummy((board_width, board_width))
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
    saver.save_if_due(game)
    saver.refresh_metrics()

    layout = window_layout()
    imgui.set_next_window_pos((layout["x"], layout["y"]), imgui.Cond_.always)
    imgui.set_next_window_size((layout["width"], layout["height"]), imgui.Cond_.always)
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
    if not layout["compact"] and layout["content_width"] >= 500:
        imgui.same_line()
        imgui.text("Keyboard: arrows/WASD, swipe, R to restart")
    elif not layout["compact"]:
        imgui.text_wrapped("Keyboard: arrows/WASD, swipe, R to restart")
    else:
        imgui.text("Swipe to move. R restarts.")

    imgui.separator()
    _, body_top = vec_xy(imgui.get_cursor_screen_pos())
    draw_board(layout)
    imgui.separator()

    imgui.text(hud.message)

    imgui.text(
        f"FPS: {hello_imgui.frame_rate():.0f}"
        f" | Play time: {float(window.__get2048PlayTime()):.0f}s"
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
        content_width = layout["content_width"]
        window.__share2048Screenshot(json.dumps({
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

game = Game(best=load_best_score())
animations = TileAnimations()
saver = SaveTracker()
hud = Hud()

if load_game_state():
    hud.message = "Saved game restored."
    if game.game_over:
        hud.message += " No moves left. Press R or New Game."
    saver.defer()
else:
    start_new_game()
immapp.run(
    gui,
    window_title="2048 with imgui-bundle + Pyodide",
    window_size=(720, 760),
    fps_idle=0,
)
