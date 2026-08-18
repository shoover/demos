"""Tests for scripts/bundle-vanilla-2048.py.

What is checked is the one property the page has to have and cannot be seen to
have by looking at it: that it asks the network for nothing. An Artifact is
served behind a CSP that blocks every outside request, so a stylesheet, module
or font the bundler failed to fold in does not error visibly -- the page comes
up in the wrong face, or with a dead script, and looks like a demo bug.

Stdlib only, and the script is run as a subprocess rather than imported: its
hyphenated name is not importable, and running it is what the justfile does.
"""

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "bundle-vanilla-2048.py"
DEMO = ROOT / "site" / "vanilla-2048"


def bundle(*args):
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory) / "page.html"
        subprocess.run(
            [sys.executable, str(SCRIPT), str(out), *args], check=True, capture_output=True
        )
        return out.read_text()


class BundleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = bundle()
        cls.bench = bundle("--bench")

    def test_asks_the_network_for_nothing(self):
        for name, page in [("demo", self.page), ("bench", self.bench)]:
            with self.subTest(name):
                self.assertNotIn("http://", page)
                self.assertNotIn("https://", page)
                # The one relative reference in the demo's own head, which is the font.
                self.assertNotIn(".woff2\"", page)
                self.assertIn("data:font/woff2;base64,", page)

    def test_carries_no_document_of_its_own(self):
        # The Artifact host supplies the document; a second one nested inside it is not
        # rendered, it is discarded, taking the page's styles with it.
        for tag in ["<!doctype", "<html", "<head>", "<body>"]:
            self.assertNotIn(tag, self.page.lower())

    def test_keeps_every_style_block_with_its_attributes(self):
        # The demo has three, and they are not interchangeable: the script reads the
        # compact one's media query back off the element to decide what compact means,
        # and the narrow one only beats it by landing after it.
        blocks = re.findall(r"<style\b[^>]*>", self.page)
        self.assertEqual(len(blocks), len(re.findall(r"<style\b[^>]*>", (DEMO / "index.html").read_text())))
        self.assertIn('<style id="compact-styles" media="(max-width: 700px)">', self.page)
        self.assertLess(
            self.page.index('id="compact-styles"'),
            self.page.index('media="(max-width: 340px)"'),
            "the narrow type step has to land after the compact block to win",
        )

    def test_folds_in_every_module_and_no_imports(self):
        for marker in [
            "export class Game",          # board.js
            "export const scoreLine",     # format.js
            "export function binGame",    # stats.js
            "function paintScore",        # game.js
        ]:
            self.assertIn(marker, self.page)
        self.assertNotRegex(self.page, r'(?m)^import .*"\./')

    def test_the_bench_is_the_flag_and_nothing_else(self):
        self.assertNotIn("bench", self.page)
        self.assertIn('id="bench-states"', self.bench)
        self.assertIn("BENCH_STATES", self.bench)
        # The bench is additive: the demo's own page is a prefix of the benched one up to
        # the styles the bench appends.
        self.assertIn("<title>Vanilla 2048</title>", self.page)
        self.assertIn("<title>Top Tile Bench</title>", self.bench)


if __name__ == "__main__":
    unittest.main()
