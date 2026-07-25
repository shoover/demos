"""Unit tests for the pure 2048 rules in site/imgui-2048/board.py.

Kept outside site/ so GitHub Pages does not publish them. Stdlib unittest only:
the demo's own dependencies live in the browser, not in this checkout.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "imgui-2048"))

import board
from board import Game

class FixedRandom:
    """Deterministic spawns: always the first empty cell in row-major order, always a 2."""

    def choice(self, sequence):
        return sequence[0]

    def random(self):
        return 0.99

def new_game(cells=None, best=10**9):
    """A Game with deterministic spawns, optionally starting from a fixed board."""
    game = Game(best=best, rng=FixedRandom())
    if cells is not None:
        game.cells = [row[:] for row in cells]
    return game

def without_spawn(game, result):
    """The settled board with the newly spawned tile removed, so moves assert cleanly."""
    cells = [row[:] for row in game.cells]
    r, c = result.spawned_cell
    cells[r][c] = 0
    return cells

class CompressAndMergeTests(unittest.TestCase):
    def test_empty_line_stays_empty(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([0, 0, 0, 0])
        self.assertEqual(merged, [0, 0, 0, 0])
        self.assertEqual(merge_positions, set())
        self.assertEqual(sources, [])
        self.assertEqual(gained, 0)

    def test_packs_toward_index_zero_without_merging(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([0, 2, 0, 4])
        self.assertEqual(merged, [2, 4, 0, 0])
        self.assertEqual(merge_positions, set())
        self.assertEqual(sources, [[1], [3]])
        self.assertEqual(gained, 0)

    def test_merge_scores_the_combined_tile(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([2, 2, 0, 0])
        self.assertEqual(merged, [4, 0, 0, 0])
        self.assertEqual(merge_positions, {0})
        self.assertEqual(sources, [[0, 1]])
        self.assertEqual(gained, 4)

    def test_two_independent_merges_in_one_line(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([2, 2, 4, 4])
        self.assertEqual(merged, [4, 8, 0, 0])
        self.assertEqual(merge_positions, {0, 1})
        self.assertEqual(sources, [[0, 1], [2, 3]])
        self.assertEqual(gained, 12)

    def test_four_of_a_kind_merges_pairwise(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([2, 2, 2, 2])
        self.assertEqual(merged, [4, 4, 0, 0])
        self.assertEqual(merge_positions, {0, 1})
        self.assertEqual(gained, 8)

    def test_merged_tile_does_not_merge_again_in_the_same_move(self):
        # [4, 2, 2, 0] must not collapse to [8]: the 2s make a 4, and that 4 is done.
        merged, merge_positions, sources, gained = board.compress_and_merge([4, 2, 2, 0])
        self.assertEqual(merged, [4, 4, 0, 0])
        self.assertEqual(merge_positions, {1})
        self.assertEqual(sources, [[0], [1, 2]])
        self.assertEqual(gained, 4)

    def test_leading_pair_merges_and_the_rest_follows(self):
        merged, merge_positions, sources, gained = board.compress_and_merge([2, 2, 4, 0])
        self.assertEqual(merged, [4, 4, 0, 0])
        self.assertEqual(merge_positions, {0})
        self.assertEqual(sources, [[0, 1], [2]])
        self.assertEqual(gained, 4)

class LineCoordinateTests(unittest.TestCase):
    def test_left_lines_are_rows_read_from_the_left_edge(self):
        self.assertEqual(board.line_coordinates("left")[0], [(0, 0), (0, 1), (0, 2), (0, 3)])

    def test_right_lines_are_rows_read_from_the_right_edge(self):
        self.assertEqual(board.line_coordinates("right")[0], [(0, 3), (0, 2), (0, 1), (0, 0)])

    def test_up_lines_are_columns_read_from_the_top(self):
        self.assertEqual(board.line_coordinates("up")[0], [(0, 0), (1, 0), (2, 0), (3, 0)])

    def test_down_lines_are_columns_read_from_the_bottom(self):
        self.assertEqual(board.line_coordinates("down")[0], [(3, 0), (2, 0), (1, 0), (0, 0)])

    def test_every_direction_covers_the_whole_board_once(self):
        for direction in ("left", "right", "up", "down"):
            cells = [cell for line in board.line_coordinates(direction) for cell in line]
            self.assertCountEqual(
                cells,
                [(r, c) for r in range(board.SIZE) for c in range(board.SIZE)],
                direction,
            )

    def test_unknown_direction_raises(self):
        with self.assertRaises(ValueError):
            board.line_coordinates("sideways")

class MoveTests(unittest.TestCase):
    START = [
        [2, 2, 0, 4],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [4, 0, 0, 4],
    ]

    def test_move_left(self):
        game = new_game(self.START)
        result = game.move("left")
        self.assertEqual(
            without_spawn(game, result),
            [
                [4, 4, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [8, 0, 0, 0],
            ],
        )
        self.assertEqual(result.gained, 12)

    def test_move_right(self):
        game = new_game(self.START)
        result = game.move("right")
        self.assertEqual(
            without_spawn(game, result),
            [
                [0, 0, 4, 4],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 8],
            ],
        )
        self.assertEqual(result.gained, 12)

    def test_move_up(self):
        game = new_game(self.START)
        result = game.move("up")
        self.assertEqual(
            without_spawn(game, result),
            [
                [2, 2, 0, 8],
                [4, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
            ],
        )
        self.assertEqual(result.gained, 8)

    def test_move_down(self):
        game = new_game(self.START)
        result = game.move("down")
        self.assertEqual(
            without_spawn(game, result),
            [
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [2, 0, 0, 0],
                [4, 2, 0, 8],
            ],
        )
        self.assertEqual(result.gained, 8)

    def test_move_that_changes_nothing_is_rejected(self):
        game = new_game([
            [2, 4, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ])
        before = [row[:] for row in game.cells]
        self.assertIsNone(game.move("left"))
        self.assertEqual(game.cells, before)
        self.assertEqual(game.moves, 0)

    def test_successful_move_counts_and_spawns_one_tile(self):
        game = new_game(self.START)
        result = game.move("left")
        self.assertEqual(game.moves, 1)
        self.assertIn(game.cells[result.spawned_cell[0]][result.spawned_cell[1]], (2, 4))
        self.assertEqual(sum(1 for row in without_spawn(game, result) for t in row if t), 3)

    def test_sliding_tiles_carry_pre_merge_values_from_both_sources(self):
        game = new_game([
            [2, 2, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ])
        result = game.move("left")
        self.assertEqual(result.merged_cells, {(0, 0)})
        self.assertEqual(
            sorted(result.sliding_tiles),
            [(2, (0, 0), (0, 0)), (2, (0, 1), (0, 0))],
        )

class ScoreTests(unittest.TestCase):
    def test_score_accumulates_across_moves(self):
        game = new_game([
            [2, 2, 0, 0],
            [2, 2, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ])
        game.move("left")
        self.assertEqual(game.score, 8, "both rows merge into a 4")
        game.move("down")
        self.assertEqual(game.score, 8 + 8, "the two 4s then merge into an 8")

    def test_best_score_follows_the_score_and_reports_the_change(self):
        game = new_game([
            [2, 2, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ], best=0)
        result = game.move("left")
        self.assertTrue(result.best_changed)
        self.assertEqual(game.best, 4)

    def test_best_score_is_untouched_while_the_score_trails_it(self):
        game = new_game([
            [2, 2, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ], best=500)
        result = game.move("left")
        self.assertFalse(result.best_changed)
        self.assertEqual(game.best, 500)

class GameOverTests(unittest.TestCase):
    LOCKED = [
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, 2],
    ]

    def test_empty_board_can_move(self):
        self.assertTrue(board.board_can_move([[0] * 4 for _ in range(4)]))

    def test_full_alternating_board_cannot_move(self):
        self.assertFalse(board.board_can_move(self.LOCKED))

    def test_full_board_with_a_vertical_pair_can_move(self):
        cells = [row[:] for row in self.LOCKED]
        cells[1][0] = 2
        self.assertTrue(board.board_can_move(cells))

    def test_full_board_with_a_horizontal_pair_can_move(self):
        cells = [row[:] for row in self.LOCKED]
        cells[0][1] = 2
        self.assertTrue(board.board_can_move(cells))

    def test_move_that_locks_the_board_ends_the_game(self):
        # Sliding row 0 right frees (0, 0), which is where the deterministic spawn
        # lands, filling the board into the alternating pattern with no pair left.
        game = new_game([
            [4, 2, 4, 0],
            [4, 2, 4, 2],
            [2, 4, 2, 4],
            [4, 2, 4, 2],
        ])
        result = game.move("right")
        self.assertIsNotNone(result)
        self.assertEqual(game.cells, self.LOCKED)
        self.assertTrue(game.game_over)

    def test_finished_game_rejects_further_moves(self):
        game = new_game(self.LOCKED)
        game.game_over = True
        self.assertIsNone(game.move("left"))
        self.assertEqual(game.moves, 0)

    def test_spawn_on_a_full_board_raises(self):
        game = new_game(self.LOCKED)
        with self.assertRaises(RuntimeError):
            game.spawn_tile()

class ResetTests(unittest.TestCase):
    def test_reset_clears_state_and_places_two_tiles(self):
        game = new_game([[2] * 4 for _ in range(4)], best=99)
        game.score = 50
        game.moves = 7
        game.game_over = True

        spawned = game.reset()
        self.assertEqual(len(spawned), 2)
        self.assertEqual(len(set(spawned)), 2)
        self.assertEqual(sum(1 for row in game.cells for tile in row if tile), 2)
        self.assertEqual(game.score, 0)
        self.assertEqual(game.moves, 0)
        self.assertFalse(game.game_over)
        self.assertEqual(game.best, 99, "reset must not forget the best score")

class SaveStateTests(unittest.TestCase):
    IN_PLAY = [
        [2, 4, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ]
    LOCKED = GameOverTests.LOCKED

    def state(self, **overrides):
        payload = {
            "version": board.STATE_VERSION,
            "board": self.IN_PLAY,
            "score": 12,
            "moves": 3,
            "game_over": False,
            "play_seconds": 42.5,
        }
        payload.update(overrides)
        return json.dumps(payload)

    def assert_rejected(self, serialized, best=10**9):
        with self.assertRaises(ValueError):
            board.decode_saved_state(serialized, best)

    def test_round_trip_through_encode(self):
        game = new_game(self.IN_PLAY, best=10**9)
        game.score = 12
        game.moves = 3
        saved = board.decode_saved_state(game.encode(42.5), game.best)
        self.assertEqual(saved.cells, self.IN_PLAY)
        self.assertEqual(saved.score, 12)
        self.assertEqual(saved.moves, 3)
        self.assertFalse(saved.game_over)
        self.assertEqual(saved.play_seconds, 42.5)

    def test_restore_reinstates_the_decoded_state(self):
        game = new_game(self.IN_PLAY, best=10**9)
        game.score = 12
        game.moves = 3
        game.game_over = False
        serialized = game.encode(1.0)

        restored = new_game(best=10**9)
        restored.restore(board.decode_saved_state(serialized, restored.best))
        self.assertEqual(restored.encode(1.0), serialized)

    def test_finished_game_round_trip(self):
        saved = board.decode_saved_state(
            self.state(board=self.LOCKED, game_over=True), 10**9
        )
        self.assertTrue(saved.game_over)
        self.assertEqual(saved.cells, self.LOCKED)

    def test_legacy_version_has_no_play_time(self):
        payload = json.loads(self.state())
        del payload["play_seconds"]
        payload["version"] = board.LEGACY_STATE_VERSION
        saved = board.decode_saved_state(json.dumps(payload), 10**9)
        self.assertEqual(saved.play_seconds, 0)

    def test_decoded_board_is_a_copy(self):
        saved = board.decode_saved_state(self.state(), 10**9)
        saved.cells[0][0] = 1024
        self.assertEqual(self.IN_PLAY[0][0], 2, "decode must not alias its input")

    def test_rejects_malformed_json(self):
        self.assert_rejected("{not json")

    def test_rejects_a_non_object_payload(self):
        self.assert_rejected("[1, 2, 3]")

    def test_rejects_an_unknown_version(self):
        self.assert_rejected(self.state(version=99))

    def test_rejects_a_missing_version(self):
        payload = json.loads(self.state())
        del payload["version"]
        self.assert_rejected(json.dumps(payload))

    def test_rejects_a_board_of_the_wrong_shape(self):
        self.assert_rejected(self.state(board=[[0, 0], [0, 0]]))

    def test_rejects_a_board_that_is_not_a_list(self):
        self.assert_rejected(self.state(board="2222"))

    def test_rejects_a_tile_that_is_not_a_power_of_two(self):
        self.assert_rejected(self.state(board=[[6, 0, 0, 0]] + [[0] * 4] * 3))

    def test_rejects_a_tile_of_one(self):
        self.assert_rejected(self.state(board=[[1, 0, 0, 0]] + [[0] * 4] * 3))

    def test_rejects_a_negative_score(self):
        self.assert_rejected(self.state(score=-1))

    def test_rejects_a_boolean_score(self):
        self.assert_rejected(self.state(score=True))

    def test_rejects_a_fractional_score(self):
        self.assert_rejected(self.state(score=12.5))

    def test_rejects_a_negative_move_count(self):
        self.assert_rejected(self.state(moves=-1))

    def test_rejects_a_non_boolean_game_over(self):
        self.assert_rejected(self.state(game_over="no"))

    def test_rejects_negative_play_time(self):
        self.assert_rejected(self.state(play_seconds=-0.5))

    def test_rejects_non_finite_play_time(self):
        self.assert_rejected(self.state(play_seconds=float("inf")))
        self.assert_rejected('{"version":2,"board":[[0,0,0,0],[0,0,0,0],'
                             '[0,0,0,0],[0,0,0,0]],"score":0,"moves":0,'
                             '"game_over":false,"play_seconds":NaN}')

    def test_rejects_a_boolean_play_time(self):
        self.assert_rejected(self.state(play_seconds=True))

    def test_rejects_a_score_above_the_best_score(self):
        # Reachable by clearing only the best-score key: the save survives, and the
        # score it claims is now impossible.
        self.assert_rejected(self.state(score=12), best=0)

    def test_rejects_game_over_on_a_board_with_moves_left(self):
        self.assert_rejected(self.state(game_over=True))

    def test_rejects_a_playable_flag_on_a_locked_board(self):
        self.assert_rejected(self.state(board=self.LOCKED, game_over=False))

if __name__ == "__main__":
    unittest.main()
