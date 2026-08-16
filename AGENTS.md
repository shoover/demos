Browser demos served as static files from `site/`, with tests and build
helpers alongside.

# Repo organization

- `site/`: the demos themselves, one directory each, plus a generated
  `index.html`
- `scripts/generate-index.py`: regenerates `site/index.html`
- `tests/`: stdlib-only tests (Python `unittest`, Node's built-in runner);
  demo dependencies are loaded by the browser, not installed here

# Development flow

- Use `just` recipes: `generate-index`, `serve`, `test` (`test-py`, `test-js`).
- Run `just test` before commit.
- Commit: Conventional Commits (`feature|fix|refactor|test|ci|tools|docs`)
  scoped to the demo touched, e.g. `feature(2048-js): ...`. Omit the scope for
  repo-wide changes.
  - Capitalized, succint summary of the feature or fixed issue
  - Blank line
  - Succint bullets documenting decisions, tradeoffs, and implementation details.
  - No co-author or generated-by trailers. The user is responsible for their
    work.

# Style

- Wrap orgmode/markdown docs at 80 characters.
- Think critically, fix root causes. No fallback paths papering over
  uncertainty. Handle known cases and fail fast otherwise.
