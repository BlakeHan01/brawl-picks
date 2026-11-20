#!/usr/bin/env bash
# Generated data lives on the `data` branch, not on main, so main's history doesn't grow.
# The branch always holds exactly one commit (replaced on every save).
#
#   scripts/data-branch.sh restore   put the data branch's files into the working tree
#   scripts/data-branch.sh save      replace the data branch with the current files;
#                                    prints changed=true|false
#
# Files: data/ (daily counts, state, brawler classes), site/data/*.json, site/img/.
# These paths are git-ignored on main.
set -euo pipefail
cd "$(dirname "$0")/.."
PATHS=(data site/data site/img)
PREV="${RUNNER_TEMP:-/tmp}/brawl-picks-data-tree"

case "${1:-}" in
  restore)
    if git fetch -q --depth=1 origin data 2>/dev/null; then
      git archive FETCH_HEAD | tar -x
      git rev-parse 'FETCH_HEAD^{tree}' > "$PREV"
      echo "restored from the data branch"
    else
      # First run after the move: take the files from the last main commit that had them.
      : > "$PREV"
      git fetch -q --deepen=100 origin 2>/dev/null || true
      gone=$(git rev-list -1 HEAD -- data/state.json || true)
      if [ -n "$gone" ] && git archive "$gone^" "${PATHS[@]}" 2>/dev/null | tar -x; then
        echo "no data branch yet: seeded from main at ${gone:0:7}^"
      else
        echo "no data branch yet and nothing to seed from: starting empty"
      fi
    fi
    ;;
  save)
    export GIT_INDEX_FILE="${RUNNER_TEMP:-/tmp}/brawl-picks-data.index"
    rm -f "$GIT_INDEX_FILE"
    git read-tree --empty
    existing=()
    for p in "${PATHS[@]}"; do [ -e "$p" ] && existing+=("$p"); done
    git add -f "${existing[@]}"
    tree=$(git write-tree)
    if [ "$tree" = "$(cat "$PREV" 2>/dev/null || true)" ]; then
      echo "changed=false"
      exit 0
    fi
    commit=$(git commit-tree "$tree" -m "data: $(date -u +'%F %H:%M') UTC")
    git push -q -f origin "$commit:refs/heads/data"
    echo "$tree" > "$PREV"
    echo "changed=true"
    ;;
  *)
    echo "usage: $0 restore|save" >&2
    exit 2
    ;;
esac
