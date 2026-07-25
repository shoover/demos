import json
import math
import random
import time
from collections import deque
from js import window
from imgui_bundle import imgui, immapp, hello_imgui

SIZE = 4
STATE_VERSION = 2
LEGACY_STATE_VERSION = 1
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

board = [[0] * SIZE for _ in range(SIZE)]
score = 0
best = load_best_score()
moves = 0
won = False
game_over = False
last_save_time = 0
save_latencies_ms = deque(maxlen=SAVE_LATENCY_CAPACITY)
save_latency_percentiles = None
last_save_metrics_refresh = 0
last_message = "Join matching tiles to reach 2048."
tile_animations = {}  # (r, c) -> ("new" | "merge", start_time)
# (value, (from_r, from_c), (to_r, to_c)) for every tile in flight after a move. Holds
# pre-move values: a merge sends both source tiles to one cell, and the doubled value
# only appears once they land.
sliding_tiles = []
slide_start = 0
share_pending = False

def ease_out_cubic(t):
    return 1 - (1 - t) ** 3

def ease_in_out_cubic(t):
    # Slides accelerate out of the old cell and settle into the new one, matching the
    # ease-in-out the original game transitions tile transforms with.
    if t < 0.5:
        return 4 * t * t * t
    return 1 - (-2 * t + 2) ** 3 / 2

def tile_scale(r, c, now):
    anim = tile_animations.get((r, c))
    if anim is None:
        return 1.0
    kind, start = anim
    duration = NEW_TILE_ANIM_SECONDS if kind == "new" else MERGE_TILE_ANIM_SECONDS
    elapsed = now - start
    if elapsed >= duration:
        del tile_animations[(r, c)]
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

def empty_cells():
    return [(r, c) for r in range(SIZE) for c in range(SIZE) if board[r][c] == 0]

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

def board_can_move(value):
    if any(tile == 0 for row in value for tile in row):
        return True
    for r in range(SIZE):
        for c in range(SIZE):
            if r + 1 < SIZE and value[r][c] == value[r + 1][c]:
                return True
            if c + 1 < SIZE and value[r][c] == value[r][c + 1]:
                return True
    return False

def serialize_game_state():
    return json.dumps({
        "version": STATE_VERSION,
        "board": board,
        "score": score,
        "moves": moves,
        "won": won,
        "game_over": game_over,
        "play_seconds": float(window.__get2048PlayTime()),
    }, separators=(",", ":"))

def save_game_state():
    global last_save_time

    started_at = time.perf_counter()
    serialized = serialize_game_state()
    window.__set2048GameState(serialized)
    save_latencies_ms.append((time.perf_counter() - started_at) * 1000)
    last_save_time = time.time()

def refresh_save_latency_metrics():
    global save_latency_percentiles, last_save_metrics_refresh

    now = time.time()
    if now - last_save_metrics_refresh < SAVE_METRICS_REFRESH_SECONDS:
        return
    last_save_metrics_refresh = now

    samples = sorted(save_latencies_ms)
    if not samples:
        save_latency_percentiles = None
        return

    def percentile(fraction):
        position = (len(samples) - 1) * fraction
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return samples[lower]
        weight = position - lower
        return samples[lower] * (1 - weight) + samples[upper] * weight

    save_latency_percentiles = (
        percentile(0.50),
        percentile(0.90),
        percentile(0.99),
        len(samples),
    )

def load_game_state():
    global board, score, moves, won, game_over

    if not bool(window.__has2048GameState()):
        return False
    serialized = window.__get2048GameState()

    try:
        state = json.loads(str(serialized))
    except json.JSONDecodeError as error:
        raise ValueError("Invalid saved 2048 game state JSON") from error

    if not isinstance(state, dict):
        raise ValueError("Invalid saved 2048 game state")
    version = state.get("version")
    if version not in (LEGACY_STATE_VERSION, STATE_VERSION):
        raise ValueError("Unsupported saved 2048 game state version")

    restored_board = validate_saved_board(state.get("board"))
    restored_score = require_nonnegative_int(state.get("score"), "score")
    restored_moves = require_nonnegative_int(state.get("moves"), "move count")
    restored_won = state.get("won")
    restored_game_over = state.get("game_over")
    play_seconds = (
        0 if version == LEGACY_STATE_VERSION else state.get("play_seconds")
    )

    if not isinstance(restored_won, bool):
        raise ValueError(f"Invalid saved 2048 won state: {restored_won!r}")
    if not isinstance(restored_game_over, bool):
        raise ValueError(
            f"Invalid saved 2048 game-over state: {restored_game_over!r}"
        )
    if (
        isinstance(play_seconds, bool)
        or not isinstance(play_seconds, (int, float))
        or not math.isfinite(play_seconds)
        or play_seconds < 0
    ):
        raise ValueError(
            f"Invalid saved 2048 play time: {play_seconds!r}"
        )
    if restored_score > best:
        raise ValueError(
            f"Saved 2048 score {restored_score} exceeds best score {best}"
        )
    if restored_won and not any(
        tile >= 2048 for row in restored_board for tile in row
    ):
        raise ValueError("Saved 2048 won state has no winning tile")
    if restored_game_over == board_can_move(restored_board):
        raise ValueError("Saved 2048 game-over state does not match the board")

    board = restored_board
    score = restored_score
    moves = restored_moves
    won = restored_won
    game_over = restored_game_over
    window.__set2048PlayTime(
        float(play_seconds),
        restored_moves > 0 and not restored_game_over,
    )
    return True

def add_tile():
    cells = empty_cells()
    if not cells:
        return None
    r, c = random.choice(cells)
    board[r][c] = 4 if random.random() < 0.10 else 2
    return (r, c)

def reset():
    global board, score, moves, won, game_over, last_message
    board = [[0] * SIZE for _ in range(SIZE)]
    score = 0
    moves = 0
    won = False
    game_over = False
    tile_animations.clear()
    sliding_tiles.clear()
    window.__set2048PlayTime(0, False)
    last_message = "New game. Use arrow keys, WASD, or the buttons."
    now = time.perf_counter()
    for _ in range(2):
        cell = add_tile()
        if cell is not None:
            tile_animations[cell] = ("new", now)
    save_game_state()

def compress_and_merge(line):
    """Collapse one line toward index 0.

    Returns (merged, merge_positions, sources). sources[j] lists the indices in the
    input line whose tiles ended up at output index j -- one entry normally, two for a
    merge -- which is what lets each tile be animated from its old cell to its new one.
    """
    global score, best
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
    score += gained
    if score > best:
        best = score
        save_best_score(best)
    return merged, merge_positions, sources

def can_move():
    if empty_cells():
        return True
    for r in range(SIZE):
        for c in range(SIZE):
            if r + 1 < SIZE and board[r][c] == board[r + 1][c]:
                return True
            if c + 1 < SIZE and board[r][c] == board[r][c + 1]:
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
    return None

def move(direction):
    global moves, won, game_over, last_message, slide_start
    if game_over:
        return

    lines = line_coordinates(direction)
    if lines is None:
        return

    before = [row[:] for row in board]
    merge_cells = set()
    in_flight = []

    for coordinates in lines:
        line = [board[r][c] for r, c in coordinates]
        merged, merge_positions, sources = compress_and_merge(line)
        for index, (r, c) in enumerate(coordinates):
            board[r][c] = merged[index]
        merge_cells.update(coordinates[index] for index in merge_positions)
        for index, source_indices in enumerate(sources):
            destination = coordinates[index]
            for source_index in source_indices:
                in_flight.append(
                    (line[source_index], coordinates[source_index], destination)
                )

    if board != before:
        now = time.perf_counter()
        tile_animations.clear()
        sliding_tiles[:] = in_flight
        slide_start = now
        # Tiles travel first; pop and appear only start once they have landed, so a
        # merge reads as two tiles arriving and becoming one.
        landed = now + SLIDE_SECONDS
        for cell in merge_cells:
            tile_animations[cell] = ("merge", landed)
        window.__start2048PlayTime()
        moves += 1
        new_cell = add_tile()
        if new_cell is not None:
            tile_animations[new_cell] = ("new", landed)
        reached_2048 = not won and any(2048 in row for row in board)
        if reached_2048:
            won = True

        if not can_move():
            game_over = True
            window.__pause2048PlayTime()
            last_message = "No moves left. Press R or New Game."
        else:
            last_message = ""
        save_game_state()

def process_keyboard():
    try:
        keys = json.loads(window.__pop2048Keys())
    except Exception:
        keys = []
    for key in keys:
        if key == "restart":
            reset()
        else:
            move(key)

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
    help_lines = 1 if compact or initial_content_width < 500 else 0
    chrome_height = (
        padding_y * 2
        + line_height * header_lines
        + imgui.get_frame_height_with_spacing()
        + line_height * help_lines
        + line_height * 2
        + controls_height
        + spacing_y * 4
        + board_margin * 2
    )

    board_width = min(
        desired_board_width,
        max_board_by_width,
        max(1, available_height - chrome_height),
    )
    window_width = min(
        board_width + board_margin * 2 + padding_x * 2,
        available_width,
    )
    content_width = max(1, window_width - padding_x * 2)
    help_lines = 1 if compact or content_width < 500 else 0
    chrome_height = (
        padding_y * 2
        + line_height * header_lines
        + imgui.get_frame_height_with_spacing()
        + line_height * help_lines
        + line_height * 2
        + controls_height
        + spacing_y * 4
        + board_margin * 2
    )
    window_height = min(chrome_height + board_width, available_height)
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

    slide_elapsed = now - slide_start
    if sliding_tiles and slide_elapsed < SLIDE_SECONDS:
        # Mid-flight: draw the tiles travelling from their old cells rather than the
        # settled board, so a merge shows both tiles converging on the same square.
        # The tile spawned by this move is held back until they land.
        progress = ease_in_out_cubic(slide_elapsed / SLIDE_SECONDS)
        for index, (value, source, destination) in enumerate(sliding_tiles):
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
        sliding_tiles.clear()
        for r in range(SIZE):
            for c in range(SIZE):
                value = board[r][c]
                if not value:
                    continue
                tile_size = cell * tile_scale(r, c, now)
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
        move("up")
    imgui.unindent(up_indent)

    if imgui.button("<##left", CONTROL_BUTTON_SIZE):
        move("left")
    imgui.same_line()
    if imgui.button(">##right", CONTROL_BUTTON_SIZE):
        move("right")
    imgui.same_line(0, spacing_x + gap)
    if imgui.button("v##down", CONTROL_BUTTON_SIZE):
        move("down")
    imgui.unindent(group_indent)

def gui():
    global share_pending

    process_keyboard()
    if time.time() - last_save_time >= SAVE_INTERVAL_SECONDS:
        save_game_state()
    refresh_save_latency_metrics()

    layout = window_layout()
    imgui.set_next_window_pos((layout["x"], layout["y"]), imgui.Cond_.always)
    imgui.set_next_window_size((layout["width"], layout["height"]), imgui.Cond_.always)
    imgui.begin("2048 in Python / Dear ImGui / WebAssembly", None, WINDOW_FLAGS)

    imgui.text(f"Score: {score:,}  |  Moves: {moves:,}  |  Best: {best:,}")
    score_min_x, score_top = vec_xy(imgui.get_item_rect_min())
    _, score_bottom = vec_xy(imgui.get_item_rect_max())

    if imgui.button("New Game"):
        reset()
    imgui.same_line()
    if imgui.button("Share"):
        share_pending = True
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

    imgui.text(last_message)

    if save_latency_percentiles is None:
        save_metrics = "collecting"
    else:
        p50, p90, p99, sample_count = save_latency_percentiles
        save_metrics = f"{p50:.0f}/{p90:.0f}/{p99:.0f} ms"
    imgui.text(
        f"FPS: {hello_imgui.frame_rate():.0f}"
        f" | Play time: {float(window.__get2048PlayTime()):.0f}s"
        f" | Save p50/90/99: {save_metrics}"
    )
    _, body_bottom = vec_xy(imgui.get_item_rect_max())
    controls()

    # Queue the capture for the end of this frame: JS reads the pixels once imgui has
    # rendered them but before the browser composites the canvas away, so these rects
    # describe exactly the frame that gets captured.
    if share_pending:
        share_pending = False
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
            "filename": f"2048-score-{score}.png",
            "title": "2048",
            "text": f"2048: {score:,} points in {moves:,} moves.",
        }))

    imgui.end()

if load_game_state():
    last_message = "Saved game restored."
    if game_over:
        last_message += " No moves left. Press R or New Game."
    last_save_time = time.time()
else:
    reset()
immapp.run(
    gui,
    window_title="2048 with imgui-bundle + Pyodide",
    window_size=(720, 760),
    fps_idle=0,
)
