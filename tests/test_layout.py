"""Unit tests for the pure 2048 sizing in site/imgui-2048/layout.py.

Kept outside site/ so GitHub Pages does not publish them. Stdlib unittest only:
the demo's own dependencies live in the browser, not in this checkout.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "imgui-2048"))

import layout
from board import SIZE
from layout import StyleMetrics

# Viewport widths and heights the sweeps walk: narrow phone through wide desktop.
SWEEP_WIDTHS = range(320, 1601, 40)
SWEEP_HEIGHTS = (420, 700, 1000)

def style_metrics(**overrides):
    """Plausible imgui style values, as game.py reads them from a default-styled frame."""
    values = {
        "padding_x": 8.0,
        "padding_y": 8.0,
        "spacing_y": 4.0,
        "line_height": 18.0,
        "frame_height": 27.0,
    }
    values.update(overrides)
    return StyleMetrics(**values)

def painted_width(cell, gap):
    """The board width draw_board actually covers for a cell and gap."""
    return cell * SIZE + gap * (SIZE - 1)

def window_margin(compact):
    """The margin compute_layout keeps between the window and the viewport edge."""
    return layout.COMPACT_WINDOW_MARGIN if compact else layout.DESKTOP_WINDOW_MARGIN

class HelpPlacementTests(unittest.TestCase):
    def test_compact_gets_the_compact_help(self):
        self.assertEqual(layout.help_placement(True), layout.COMPACT_HELP)

    def test_desktop_gets_the_wrapped_help(self):
        self.assertEqual(layout.help_placement(False), layout.WRAPPED_HELP)

class BoardMetricsTests(unittest.TestCase):
    def test_desktop_uses_the_desktop_gap(self):
        _, gap = layout.board_metrics(400, False)
        self.assertEqual(gap, layout.DESKTOP_BOARD_GAP)

    def test_compact_uses_the_compact_gap(self):
        _, gap = layout.board_metrics(400, True)
        self.assertEqual(gap, layout.COMPACT_BOARD_GAP)

    def test_a_huge_target_stops_at_the_desktop_cell(self):
        cell, _ = layout.board_metrics(10**6, False)
        self.assertEqual(cell, layout.DESKTOP_CELL)

    def test_a_tiny_target_stops_at_the_minimum_cell(self):
        for compact in (False, True):
            cell, _ = layout.board_metrics(1, compact)
            self.assertEqual(cell, layout.MIN_CELL, compact)

    def test_an_exactly_sized_target_is_filled_completely(self):
        gap = layout.DESKTOP_BOARD_GAP
        target = painted_width(layout.DESKTOP_CELL, gap)
        cell, settled_gap = layout.board_metrics(target, False)
        self.assertEqual((cell, settled_gap), (layout.DESKTOP_CELL, gap))
        self.assertEqual(painted_width(cell, settled_gap), target)

    def test_the_painted_board_never_outgrows_the_target_between_the_limits(self):
        # The reason the arithmetic was extracted: truncation must round the cell down,
        # so a board that is neither floored nor capped always fits the space asked for.
        for compact in (False, True):
            for target in range(1, 1200):
                cell, gap = layout.board_metrics(target, compact)
                if layout.MIN_CELL < cell < layout.DESKTOP_CELL:
                    self.assertLessEqual(painted_width(cell, gap), target, (target, compact))

class BoardWidthAgreementTests(unittest.TestCase):
    def test_reserved_board_width_matches_the_painted_one_everywhere(self):
        # The key regression guard: before the extraction the width the window reserved
        # and the width draw_board covered were derived separately and could disagree.
        style = style_metrics()
        for compact in (False, True):
            for height in SWEEP_HEIGHTS:
                for width in SWEEP_WIDTHS:
                    result = layout.compute_layout(width, height, compact, style)
                    self.assertEqual(
                        result.board_width,
                        painted_width(result.cell, result.gap),
                        (width, height, compact),
                    )

class DesktopLayoutTests(unittest.TestCase):
    VIEWPORT = (1440, 1000)

    def layout(self):
        return layout.compute_layout(*self.VIEWPORT, False, style_metrics())

    def test_a_roomy_viewport_gets_full_size_tiles(self):
        result = self.layout()
        self.assertEqual(result.cell, layout.DESKTOP_CELL)
        self.assertEqual(result.gap, layout.DESKTOP_BOARD_GAP)

    def test_the_window_fits_inside_the_viewport_minus_its_margins(self):
        viewport_width, viewport_height = self.VIEWPORT
        margin = layout.DESKTOP_WINDOW_MARGIN
        result = self.layout()
        self.assertLessEqual(result.width, viewport_width - margin * 2)
        self.assertLessEqual(result.height, viewport_height - margin * 2)
        self.assertLessEqual(result.x + result.width, viewport_width - margin)
        self.assertLessEqual(result.y + result.height, viewport_height - margin)

    def test_a_short_viewport_shrinks_the_cell_instead_of_overflowing(self):
        margin = layout.DESKTOP_WINDOW_MARGIN
        style = style_metrics()
        roomy = layout.compute_layout(1440, 1000, False, style)
        short = layout.compute_layout(1440, 600, False, style)
        self.assertLess(short.cell, roomy.cell)
        self.assertGreater(short.cell, layout.MIN_CELL)
        self.assertLessEqual(short.height, 600 - margin * 2)

    def test_the_cell_stops_shrinking_at_the_minimum(self):
        style = style_metrics()
        for height in (450, 400, 350, 300):
            result = layout.compute_layout(1440, height, False, style)
            self.assertEqual(result.cell, layout.MIN_CELL, height)

    def test_shorter_viewports_never_grow_the_cell(self):
        style = style_metrics()
        previous = layout.DESKTOP_CELL
        for height in range(1000, 299, -20):
            cell = layout.compute_layout(1440, height, False, style).cell
            self.assertLessEqual(cell, previous, height)
            previous = cell

class CrampedLayoutTests(unittest.TestCase):
    """A viewport too small for even MIN_CELL still has to produce something usable."""

    VIEWPORT = (200, 200)

    def layout(self):
        return layout.compute_layout(*self.VIEWPORT, False, style_metrics())

    def test_the_cell_holds_at_the_legibility_floor(self):
        # Deliberate tradeoff: MIN_CELL is a floor on legibility, so the board is allowed
        # to outgrow the window and be clipped rather than shrink into an unreadable grid.
        result = self.layout()
        self.assertEqual(result.cell, layout.MIN_CELL)
        self.assertGreater(result.board_width, result.content_width)

    def test_the_window_is_clamped_to_the_available_space(self):
        viewport_width, viewport_height = self.VIEWPORT
        margin = layout.DESKTOP_WINDOW_MARGIN
        result = self.layout()
        self.assertEqual(result.width, viewport_width - margin * 2)
        self.assertEqual(result.height, viewport_height - margin * 2)

    def test_a_degenerate_viewport_still_returns_positive_sizes(self):
        result = layout.compute_layout(1, 1, False, style_metrics())
        self.assertEqual(result.cell, layout.MIN_CELL)
        self.assertGreaterEqual(result.width, 1)
        self.assertGreaterEqual(result.height, 1)
        self.assertGreaterEqual(result.content_width, 1)

class WindowPositionTests(unittest.TestCase):
    def test_a_roomy_window_is_centred(self):
        for compact in (False, True):
            result = layout.compute_layout(1440, 1000, compact, style_metrics())
            self.assertAlmostEqual(result.x, (1440 - result.width) / 2, msg=compact)
            self.assertAlmostEqual(result.y, (1000 - result.height) / 2, msg=compact)

    def test_the_window_never_starts_inside_the_margin(self):
        style = style_metrics()
        for compact in (False, True):
            margin = window_margin(compact)
            for height in SWEEP_HEIGHTS + (120, 200):
                for width in SWEEP_WIDTHS:
                    result = layout.compute_layout(width, height, compact, style)
                    self.assertGreaterEqual(result.x, margin, (width, height, compact))
                    self.assertGreaterEqual(result.y, margin, (width, height, compact))

    def test_a_cramped_viewport_pins_the_window_to_its_own_margin(self):
        style = style_metrics()
        desktop = layout.compute_layout(200, 200, False, style)
        self.assertEqual((desktop.x, desktop.y), (layout.DESKTOP_WINDOW_MARGIN,) * 2)
        compact = layout.compute_layout(200, 200, True, style)
        self.assertEqual((compact.x, compact.y), (layout.COMPACT_WINDOW_MARGIN,) * 2)

class ContentWidthTests(unittest.TestCase):
    def test_content_width_is_the_window_less_its_horizontal_padding(self):
        style = style_metrics(padding_x=11.0)
        for compact in (False, True):
            for width in SWEEP_WIDTHS:
                result = layout.compute_layout(width, 800, compact, style)
                self.assertAlmostEqual(
                    result.content_width,
                    result.width - style.padding_x * 2,
                    msg=(width, compact),
                )

    def test_content_width_is_floored_at_one(self):
        # Padding alone can swallow the whole window; the board still needs a width to
        # centre itself against.
        result = layout.compute_layout(1, 1, False, style_metrics(padding_x=200.0))
        self.assertEqual(result.content_width, 1)

class CompactLayoutTests(unittest.TestCase):
    def test_compact_mode_uses_the_compact_gap_and_margins(self):
        style = style_metrics()
        result = layout.compute_layout(420, 900, True, style)
        self.assertEqual(result.gap, layout.COMPACT_BOARD_GAP)
        self.assertGreaterEqual(result.x, layout.COMPACT_WINDOW_MARGIN)
        self.assertLessEqual(result.width, 420 - layout.COMPACT_WINDOW_MARGIN * 2)

    def test_compact_mode_always_reports_compact_help(self):
        style = style_metrics()
        for width in SWEEP_WIDTHS:
            result = layout.compute_layout(width, 900, True, style)
            self.assertEqual(result.help_placement, layout.COMPACT_HELP, width)

    def test_compact_margins_leave_more_room_than_desktop_ones(self):
        style = style_metrics()
        compact = layout.compute_layout(360, 700, True, style)
        desktop = layout.compute_layout(360, 700, False, style)
        self.assertGreaterEqual(compact.width, desktop.width)

class HelpPlacementIndependenceTests(unittest.TestCase):
    def test_the_reported_placement_depends_only_on_the_compact_flag(self):
        # Placement was once re-derived from the content width, which forced compute_layout
        # to size the board twice. Nothing about the viewport may move it now: if that ever
        # changes, the single-pass chrome height silently reserves the wrong number of lines.
        style = style_metrics()
        for compact in (False, True):
            expected = layout.help_placement(compact)
            for height in SWEEP_HEIGHTS:
                for width in SWEEP_WIDTHS:
                    result = layout.compute_layout(width, height, compact, style)
                    self.assertEqual(
                        result.help_placement, expected, (width, height, compact)
                    )

    def test_every_reported_placement_is_one_game_py_can_draw(self):
        style = style_metrics()
        known = {layout.WRAPPED_HELP, layout.COMPACT_HELP}
        for compact in (False, True):
            for width in SWEEP_WIDTHS:
                result = layout.compute_layout(width, 700, compact, style)
                self.assertIn(result.help_placement, known, (width, compact))

if __name__ == "__main__":
    unittest.main()
