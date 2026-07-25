port := env_var_or_default("PORT", "8000")

generate-index:
    ./scripts/generate-index.py

serve: generate-index
    python3 -m http.server --directory site {{port}}

# Stdlib unittest only: the demos' dependencies are loaded by the browser.
test:
    python3 -m unittest discover --start-directory tests
