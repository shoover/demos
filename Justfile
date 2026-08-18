port := env_var_or_default("PORT", "8000")

generate-index:
    ./scripts/generate-index.py

serve: generate-index
    python3 -m http.server --directory site {{port}}

# One self-contained page, for publishing the demo as an Artifact: no request to
# anywhere, since an Artifact is served behind a CSP that blocks every one of them.
bundle out="build/vanilla-2048.html":
    ./scripts/bundle-vanilla-2048.py {{out}}

# The same page, plus the strip that loads the states a game would take a thousand
# moves to reach. What a score line or a tile colour is reviewed against.
bundle-bench out="build/vanilla-2048-bench.html":
    ./scripts/bundle-vanilla-2048.py --bench {{out}}

test: test-py test-js

# Stdlib unittest only: the demos' dependencies are loaded by the browser.
test-py:
    python3 -m unittest discover --start-directory tests

# Node's built-in test runner only, for the same reason. The glob is deliberate:
# discovery mode would try to run the Python tests sitting next to these.
test-js:
    node --test tests/*.mjs
