#!/bin/sh
# DCO check (GOVERNANCE.md): every commit MUST carry a Signed-off-by
# trailer. There is no CLA; the DCO is the only contribution agreement,
# and this script keeps that true mechanically — governance as code.
set -eu

bad=0
# Merge commits are mechanical joins (GitHub PR merges carry no signoff);
# every real commit — both parents' histories — is still walked and checked.
for commit in $(git rev-list --all --no-merges); do
  count=$(git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$commit" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    short=$(git log -1 --format='%h %s' "$commit")
    echo "MISSING Signed-off-by: $short"
    bad=1
  fi
done

if [ "$bad" -ne 0 ]; then
  echo ""
  echo "Sign your commits: git commit -s (Developer Certificate of Origin)."
  exit 1
fi

echo "DCO: every commit signed off."
