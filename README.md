# demos

Browser demos served as static files from `site/`.

    just serve   # regenerate the index and serve site/ on :8000
    just test    # Python + Node tests

## Adding a demo

Drop it in `site/<slug>/index.html`. `just generate-index` builds the landing
page from each demo's `<title>` (card heading) and `<meta name="description">`
(card summary); a demo missing either fails the build.

## Notes

`docs/` holds design notes for work that was measured but not built, so the
numbers behind a decision outlive the conversation they were taken in.

- [Saving vanilla-2048 more often than every five
  seconds](docs/vanilla-2048-per-move-saves.md)
- [Solving 2048 exactly, and what a 4x4 solve would
  cost](docs/2048-perfect-play.md)
