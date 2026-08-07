"""Pure sizing for the 2048 window: where it sits, how big the board is, where help goes.

Imports nothing from the browser or imgui. Callers hand over the viewport size and the
handful of style metrics the arithmetic needs, so the sizing runs -- and is tested --
under plain CPython. game.py keeps the drawing.
"""

from typing import NamedTuple

from board import SIZE

DESKTOP_CELL = 92
# Tiles stop shrinking here and the board is allowed to outgrow a very short viewport:
# an unreadable board is worse than a clipped one.
MIN_CELL = 36
DESKTOP_BOARD_GAP = 8
COMPACT_BOARD_GAP = 6
DESKTOP_BOARD_MARGIN = 14
COMPACT_BOARD_MARGIN = 8
DESKTOP_WINDOW_MARGIN = 14
COMPACT_WINDOW_MARGIN = 6
CONTROL_BUTTON_SIZE = (74, 60)

# Which help text goes below the buttons, decided here so the height reserved for it and
# the way it is drawn cannot disagree. game.py switches on this instead of re-deriving
# the rule.
WRAPPED_HELP = "wrapped"
COMPACT_HELP = "compact"
# Either wording occupies a single line, so the reserved height does not depend on the
# placement.
_HELP_LINES = 1

class StyleMetrics(NamedTuple):
    """The imgui style values the sizing depends on, read once per frame."""

    padding_x: float
    padding_y: float
    spacing_y: float
    line_height: float
    frame_height: float

class Layout(NamedTuple):
    """A placed window and the board inside it, in canvas pixels."""

    x: float
    y: float
    width: float
    height: float
    # The painted board width: cell and gap already snapped, so what draw_board covers is
    # exactly what the window reserved.
    board_width: int
    content_width: float
    cell: int
    gap: int
    help_placement: str

def help_placement(compact):
    return COMPACT_HELP if compact else WRAPPED_HELP

def board_gap(compact):
    return COMPACT_BOARD_GAP if compact else DESKTOP_BOARD_GAP

def board_metrics(target_board_width, compact):
    """Fit the board to a target width. Returns the cell size and gap it settles on.

    The cell is the quantum: the board width follows from it, so a truncated division or
    the MIN_CELL floor can never leave the drawn board wider than the reserved space.
    """
    gap = board_gap(compact)
    cell = int((target_board_width - gap * (SIZE - 1)) / SIZE)
    cell = max(MIN_CELL, min(DESKTOP_CELL, cell))
    return cell, gap

def compute_layout(viewport_width, viewport_height, compact, style):
    margin = COMPACT_WINDOW_MARGIN if compact else DESKTOP_WINDOW_MARGIN
    gap = board_gap(compact)
    board_margin = COMPACT_BOARD_MARGIN if compact else DESKTOP_BOARD_MARGIN
    desired_board_width = DESKTOP_CELL * SIZE + gap * (SIZE - 1)
    available_width = max(1, viewport_width - margin * 2)
    available_height = max(1, viewport_height - margin * 2)

    max_board_by_width = max(1, available_width - style.padding_x * 2 - board_margin * 2)

    controls_height = CONTROL_BUTTON_SIZE[1] * 2 + style.spacing_y
    header_lines = 2 if compact else 1

    # Everything stacked above and below the board. The help costs the same line either
    # way, so this is one number and the board can be sized in a single pass.
    chrome_height = (
        style.padding_y * 2
        + style.line_height * header_lines
        + style.frame_height
        + style.line_height * _HELP_LINES
        + style.line_height * 2
        + controls_height
        + style.spacing_y * 4
        + board_margin * 2
    )

    cell, gap = board_metrics(
        min(
            desired_board_width,
            max_board_by_width,
            max(1, available_height - chrome_height),
        ),
        compact,
    )
    board_width = cell * SIZE + gap * (SIZE - 1)

    window_width = min(board_width + board_margin * 2 + style.padding_x * 2, available_width)
    content_width = max(1, window_width - style.padding_x * 2)
    window_height = min(chrome_height + board_width, available_height)
    return Layout(
        x=max(margin, (viewport_width - window_width) / 2),
        y=max(margin, (viewport_height - window_height) / 2),
        width=window_width,
        height=window_height,
        board_width=board_width,
        content_width=content_width,
        cell=cell,
        gap=gap,
        help_placement=help_placement(compact),
    )
