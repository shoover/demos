#!/bin/sh -e
# Attribute commits to the authenticated GitHub user instead of to Claude.
#
# The managed container used by Claude Code on the web ships a global git
# identity of Claude <noreply@anthropic.com>, so without this every commit
# made in a web session lands mis-attributed. The identity is derived from
# the session's GitHub token rather than hardcoded, so a single checked-in
# hook covers every developer with no per-person setup, and nobody can
# claim another person's identity by editing a shared file.
#
# The noreply address is used rather than the account's public email so
# that attribution never depends on a developer publishing a real address.

# Only act on the container's Claude identity. In a local session the
# developer's own global config is already correct, so leave it alone.
[ "$(git config user.email)" = "noreply@anthropic.com" ] || exit 0

# One request per session, not per commit. `sh -e` plus `jq -e` mean an
# unreachable API aborts the hook with the identity untouched, rather than
# quietly writing an empty name and email.
me=$(curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)

git config user.name "$(printf '%s' "$me" | jq -er '.name // .login')"
git config user.email \
    "$(printf '%s' "$me" | jq -er '"\(.id)+\(.login)@users.noreply.github.com"')"
