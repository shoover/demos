#!/usr/bin/env python3
"""Fold the vanilla-2048 demo into one self-contained page.

An Artifact is a single file behind a strict CSP: no script, style, font or
image may be fetched from anywhere, and the host supplies the document around
what is written here -- so no doctype, no <html>, no <head>, no <body>. This
reads the demo exactly as it is served and writes that page.

The modules are concatenated in dependency order with their import lines
dropped, which works because they already share one graph and one namespace:
board.js is imported by the rest, and nothing imports game.js. Their `export`
keywords are left alone, being legal in an inline module script and read by
nobody. The font rides along as a data URI.

With --bench, the strip in scripts/bench is folded in too: four states that
would each take a thousand moves to reach, loaded into the live game in one
click. Nothing under site/ knows it exists, and a bundle without the flag is
the demo and nothing else.
"""

import argparse
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEMO = ROOT / "site" / "vanilla-2048"
BENCH = ROOT / "scripts" / "bench"
FONT = "droid-sans-latin.woff2"

# Dependency order. board.js is the graph's root and game.js its only leaf, so
# this is the order the browser would resolve them in anyway.
MODULES = ["board.js", "format.js", "stats.js", "game.js"]


def read_page():
    return (DEMO / "index.html").read_text()


def styles(page):
    """Every <style> in the head, tags and attributes and all.

    The tags are kept rather than the rules alone because the blocks are not
    interchangeable: one carries a media query the script reads back off itself
    to decide what "compact" means, and their order is what decides which rule
    wins on a screen both queries match.
    """
    head = page.split("</head>", 1)[0]
    found = re.findall(r"  <style\b.*?</style>", head, re.S)
    if not found:
        raise SystemExit("No <style> blocks in the demo's head")
    inlined = base64.b64encode((DEMO / FONT).read_bytes()).decode()
    return [
        block.replace(
            f'url("./{FONT}") format("woff2")',
            f'url("data:font/woff2;base64,{inlined}") format("woff2")',
        )
        for block in found
    ]


def body(page):
    """The body, up to the script tag that the concatenated modules replace."""
    match = re.search(r"<body>\n(.*?)\n  <script type=\"module\"", page, re.S)
    if match is None:
        raise SystemExit("No <body> ... <script type=\"module\"> in the demo")
    return match.group(1)


def script():
    """The modules, in dependency order, with their imports of each other cut."""
    return "\n".join(
        re.sub(r'^import .*?;\n', "", (DEMO / name).read_text(), flags=re.M | re.S)
        for name in MODULES
    )


def bundle(title, with_bench):
    page = read_page()
    parts = [f"<title>{title}</title>"]
    parts.extend(styles(page))
    if with_bench:
        parts.append(f"<style>\n{(BENCH / 'bench.css').read_text()}</style>")
    parts.append(body(page))
    if with_bench:
        parts.append((BENCH / "bench.html").read_text().rstrip("\n"))
    bench_script = (BENCH / "bench.js").read_text() if with_bench else ""
    parts.append(f'<script type="module">\n{script()}\n{bench_script}</script>')
    return "\n".join(parts) + "\n"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out", type=pathlib.Path, help="page to write")
    parser.add_argument(
        "--bench",
        action="store_true",
        help="fold in the state-loading strip from scripts/bench",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="the Artifact's name; defaults to the demo's own, or the bench's",
    )
    args = parser.parse_args(argv)

    title = args.title or ("Top Tile Bench" if args.bench else "Vanilla 2048")
    page = bundle(title, args.bench)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(page)
    print(f"Wrote {args.out} ({len(page.encode()) / 1024:.0f} KB)")


if __name__ == "__main__":
    main(sys.argv[1:])
