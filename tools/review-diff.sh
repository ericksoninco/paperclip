#!/usr/bin/env bash
#
# review-diff.sh — show a branch/PR's REAL change set.
#
# Why this exists (EDD-363):
#   This repo is a fork. Feature branches are cut from the local `master`, but
#   the fork's GitHub `origin/master` can lag local `master` by weeks. GitHub
#   (and `gh pr diff`) diff a PR against the stale `origin/master`, so every PR
#   renders the entire local-vs-fork delta — e.g. "1175 files / +319k" and
#   `gh pr diff` returns "HTTP 406 ... diff exceeded the maximum number of
#   files (300)". The genuine change is usually a handful of files.
#
#   This helper diffs a branch against its TRUE merge-base with the local base
#   branch (default `master`), so reviewers see only the real change set in one
#   command, regardless of how stale the fork is.
#
# Usage:
#   tools/review-diff.sh <branch|ref>            # summary (--stat) vs true merge-base
#   tools/review-diff.sh <branch> --diff         # full patch
#   tools/review-diff.sh <branch> --files        # changed file names only
#   tools/review-diff.sh --pr <number>           # resolve branch from a GitHub PR (needs gh)
#   tools/review-diff.sh --base <ref> <branch>   # override base (default: master)
#
# Env:
#   REVIEW_BASE   override the base branch (default: master)
#
set -euo pipefail

BASE="${REVIEW_BASE:-master}"
MODE="stat"
TARGET=""
PR_NUMBER=""

die() { echo "review-diff: $*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --diff|--patch)   MODE="diff" ;;
    --files|--name)   MODE="files" ;;
    --stat)           MODE="stat" ;;
    --base)           shift; [ "$#" -gt 0 ] || die "--base needs a ref"; BASE="$1" ;;
    --pr)             shift; [ "$#" -gt 0 ] || die "--pr needs a number"; PR_NUMBER="$1" ;;
    -h|--help)        usage 0 ;;
    --)               shift; break ;;
    -*)               die "unknown option: $1 (try --help)" ;;
    *)                TARGET="$1" ;;
  esac
  shift
done

# Resolve a PR number to its head branch via gh, if requested.
if [ -n "$PR_NUMBER" ]; then
  command -v gh >/dev/null 2>&1 || die "--pr requires the GitHub CLI (gh)"
  TARGET="$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)" \
    || die "could not resolve PR #$PR_NUMBER head branch"
fi

[ -n "$TARGET" ] || usage 1

# Resolve the target to a real ref: try as-is, then origin/<target>.
if git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null; then
  REF="$TARGET"
elif git rev-parse --verify --quiet "origin/$TARGET^{commit}" >/dev/null; then
  REF="origin/$TARGET"
else
  die "cannot find ref '$TARGET' (tried '$TARGET' and 'origin/$TARGET')"
fi

# Resolve the base similarly.
if git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  BASE_REF="$BASE"
elif git rev-parse --verify --quiet "origin/$BASE^{commit}" >/dev/null; then
  BASE_REF="origin/$BASE"
else
  die "cannot find base ref '$BASE'"
fi

MB="$(git merge-base "$BASE_REF" "$REF")" || die "no common ancestor between '$BASE_REF' and '$REF'"

echo "Base branch : $BASE_REF ($(git rev-parse --short "$BASE_REF"))"
echo "Reviewing   : $REF ($(git rev-parse --short "$REF"))"
echo "Merge-base  : $(git rev-parse --short "$MB") — $(git show -s --format='%ci %s' "$MB")"
echo

case "$MODE" in
  stat)  git --no-pager diff --stat "$MB" "$REF" ;;
  files) git --no-pager diff --name-status "$MB" "$REF" ;;
  diff)  git --no-pager diff "$MB" "$REF" ;;
esac
