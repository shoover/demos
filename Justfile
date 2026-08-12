port := env_var_or_default("PORT", "8000")

generate-index:
    ./scripts/generate-index.py

serve: generate-index
    python3 -m http.server --directory site {{port}}

test: test-py test-js

# Stdlib unittest only: the demos' dependencies are loaded by the browser.
test-py:
    python3 -m unittest discover --start-directory tests

# Node's built-in test runner only, for the same reason. The glob is deliberate:
# discovery mode would try to run the Python tests sitting next to these.
test-js:
    node --test tests/*.mjs
