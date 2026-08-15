#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Stamps a cache-busting version onto local JS module references.

Run against the built `site/` directory right before it is uploaded to GitHub
Pages (see .github/workflows/static.yml). A module script keeps the same URL
across deploys -- `./game.js` today is `./game.js` after tomorrow's push --
and Safari on iOS in particular will keep serving a client's disk-cached copy
of it past a deploy, sometimes pairing a stale game.js with a fresh index.html
or a stale board.js with a fresh game.js. Either mismatch tends to fail
silently: listeners never attach, so the board renders but stops responding
to input.

A query string is a new cache key everywhere that matters, so appending one
derived from the deploy (the commit SHA) forces every client onto the new
files. Only local module references (a relative src/import path) are
rewritten -- nothing served from another origin needs or wants this.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE_ROOT = ROOT / "site"

MODULE_SCRIPT_RE = re.compile(r"<script\b[^>]*>", re.IGNORECASE)
SRC_ATTR_RE = re.compile(r'\bsrc="([^"?#]+\.js)"')
IMPORT_RE = re.compile(r'((?:from|import)\s+["\'])(\.[^"\']+\.js)(["\'])')


def stamp_html(path: Path, version: str) -> list[Path]:
    text = path.read_text(encoding="utf-8")
    entries: list[Path] = []

    def stamp_tag(match: re.Match[str]) -> str:
        tag = match.group(0)
        if 'type="module"' not in tag:
            return tag
        src_match = SRC_ATTR_RE.search(tag)
        if src_match is None:
            return tag
        entries.append((path.parent / src_match.group(1)).resolve())
        start, end = src_match.span(1)
        return tag[:end] + f"?v={version}" + tag[end:]

    stamped = MODULE_SCRIPT_RE.sub(stamp_tag, text)
    if stamped != text:
        path.write_text(stamped, encoding="utf-8")
    return entries


def stamp_js(path: Path, version: str) -> list[Path]:
    text = path.read_text(encoding="utf-8")
    imports = [(path.parent / m.group(2)).resolve() for m in IMPORT_RE.finditer(text)]
    stamped = IMPORT_RE.sub(rf"\g<1>\g<2>?v={version}\g<3>", text)
    if stamped != text:
        path.write_text(stamped, encoding="utf-8")
    return imports


def stamp_site(version: str) -> None:
    seen: set[Path] = set()
    for index_path in sorted(SITE_ROOT.glob("*/index.html")):
        queue = stamp_html(index_path, version)
        while queue:
            js_path = queue.pop()
            if js_path in seen or not js_path.is_file():
                continue
            seen.add(js_path)
            queue.extend(stamp_js(js_path, version))


def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1]:
        sys.exit("usage: stamp-asset-versions.py <version>")
    stamp_site(sys.argv[1])


if __name__ == "__main__":
    main()
