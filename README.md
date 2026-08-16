# demos

Browser demos served as static files from `site/`.

    just serve   # regenerate the index and serve site/ on :8000
    just test    # Python + Node tests

## Adding a demo

Drop it in `site/<slug>/index.html`. `just generate-index` builds the landing
page from each demo's `<title>` (card heading) and `<meta name="description">`
(card summary); a demo missing either fails the build.
