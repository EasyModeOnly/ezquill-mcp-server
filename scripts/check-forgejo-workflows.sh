#!/usr/bin/env bash
#
# Keep the Forgejo copies of our workflows identical to the GitHub ones
# (ezQuill epic #53; copied from saltpig's, task #2933 there).
#
# The local Forgejo (montidata-02) is this repo's primary home and runs CI on
# the home runners; GitHub is its push mirror and runs the deploys. Forgejo
# reads .forgejo/workflows when that directory exists and then ignores
# .github/workflows entirely, which is what keeps the deploy workflows (no
# secrets there) from firing on every push to its main. So the workflows we DO
# want there have to live in .forgejo/workflows too, and two shorter routes
# don't work on Forgejo 15:
#
#   - a symlink: Forgejo reads the link text as the workflow and fails it;
#   - a wrapper that `uses:` the GitHub workflow: inside a called workflow
#     Forgejo reports event_name=workflow_call (GitHub keeps the caller's
#     event), which breaks any pull_request gate in the called workflow.
#
# Hence byte-for-byte copies, and this check so they can't drift: every file
# in .forgejo/workflows must match the same-named file in .github/workflows.
#
# Usage: scripts/check-forgejo-workflows.sh [--fix]
#   --fix   re-copy each .github/workflows file over its .forgejo copy.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FIX=0
if [[ "${1:-}" == "--fix" ]]; then
  FIX=1
fi

FORGEJO_DIR=.forgejo/workflows
GITHUB_DIR=.github/workflows

if [[ ! -d "$FORGEJO_DIR" ]]; then
  echo "check-forgejo-workflows: no $FORGEJO_DIR, nothing to check."
  exit 0
fi

status=0
for copy in "$FORGEJO_DIR"/*.yml; do
  [[ -e "$copy" ]] || continue
  name="$(basename "$copy")"
  source="$GITHUB_DIR/$name"
  if [[ ! -f "$source" ]]; then
    echo "check-forgejo-workflows: $copy has no $source to mirror." >&2
    status=1
    continue
  fi
  if [[ -L "$copy" ]]; then
    echo "check-forgejo-workflows: $copy is a symlink; Forgejo can't read those." >&2
    status=1
    continue
  fi
  if ! cmp -s "$source" "$copy"; then
    if (( FIX )); then
      cp "$source" "$copy"
      echo "check-forgejo-workflows: re-copied $source -> $copy"
    else
      echo "check-forgejo-workflows: $copy differs from $source." >&2
      echo "  Run scripts/check-forgejo-workflows.sh --fix and commit the result." >&2
      status=1
    fi
  fi
done

if (( status == 0 )); then
  echo "check-forgejo-workflows: OK"
fi
exit "$status"
