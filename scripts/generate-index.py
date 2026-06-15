#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
from __future__ import annotations

from dataclasses import dataclass
from html import escape
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "index.html"


class TitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_title = False
        self._parts: list[str] = []

    @property
    def title(self) -> str:
        return " ".join("".join(self._parts).split())

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._parts.append(data)


@dataclass(frozen=True)
class Demo:
    slug: str
    title: str

    @property
    def href(self) -> str:
        return f"{self.slug}/"


def fallback_title(slug: str) -> str:
    return " ".join(part for part in slug.replace("_", "-").split("-") if part).title()


def read_title(index_path: Path) -> str | None:
    parser = TitleParser()
    parser.feed(index_path.read_text(encoding="utf-8"))
    return parser.title or None


def discover_demos() -> list[Demo]:
    demos: list[Demo] = []

    for child in ROOT.iterdir():
        index_path = child / "index.html"
        if not child.is_dir() or not index_path.is_file():
            continue

        demos.append(
            Demo(
                slug=child.name,
                title=read_title(index_path) or fallback_title(child.name),
            )
        )

    return sorted(demos, key=lambda demo: demo.title.casefold())


def render(demos: list[Demo]) -> str:
    items = "\n".join(
        f"""      <li>
        <a href="{escape(demo.href)}">
          <span>{escape(demo.title)}</span>
          <code>{escape(demo.slug)}</code>
        </a>
      </li>"""
        for demo in demos
    )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demos</title>
  <style>
    :root {{
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
      background: #f7f7f4;
      color: #1f2523;
    }}

    * {{
      box-sizing: border-box;
    }}

    body {{
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(20, 90, 85, 0.09), transparent 260px),
        #f7f7f4;
    }}

    main {{
      width: min(880px, calc(100% - 32px));
      margin: 0 auto;
      padding: 56px 0;
    }}

    header {{
      margin-bottom: 28px;
    }}

    h1 {{
      margin: 0;
      font-size: clamp(2rem, 6vw, 4rem);
      line-height: 1;
      letter-spacing: 0;
    }}

    ul {{
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }}

    a {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 16px 18px;
      border: 1px solid rgba(31, 37, 35, 0.14);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.78);
      color: inherit;
      text-decoration: none;
      box-shadow: 0 1px 2px rgba(31, 37, 35, 0.04);
    }}

    a:hover,
    a:focus-visible {{
      border-color: rgba(20, 90, 85, 0.42);
      outline: none;
      box-shadow: 0 0 0 4px rgba(20, 90, 85, 0.12);
    }}

    span {{
      min-width: 0;
      font-weight: 700;
    }}

    code {{
      flex: 0 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
      color: #59625d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.875rem;
    }}

    @media (max-width: 560px) {{
      main {{
        width: min(100% - 24px, 880px);
        padding: 32px 0;
      }}

      a {{
        align-items: flex-start;
        flex-direction: column;
        gap: 6px;
      }}
    }}

    @media (prefers-color-scheme: dark) {{
      :root {{
        background: #111614;
        color: #edf2ef;
      }}

      body {{
        background:
          linear-gradient(180deg, rgba(73, 177, 164, 0.14), transparent 260px),
          #111614;
      }}

      code {{
        color: #aab8b2;
      }}

      a {{
        border-color: rgba(237, 242, 239, 0.13);
        background: rgba(255, 255, 255, 0.055);
        box-shadow: none;
      }}

      a:hover,
      a:focus-visible {{
        border-color: rgba(73, 177, 164, 0.58);
        box-shadow: 0 0 0 4px rgba(73, 177, 164, 0.15);
      }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Demos</h1>
    </header>
    <ul>
{items}
    </ul>
  </main>
</body>
</html>
"""


def main() -> None:
    OUTPUT.write_text(render(discover_demos()), encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
