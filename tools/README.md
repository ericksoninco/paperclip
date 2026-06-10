# tools/

Company-internal tooling for this Paperclip fork.

## review-diff.sh — review a PR's real change set (EDD-363)

**Problem.** This repo is a fork. Feature branches are cut from the local
`master`, but the fork's GitHub `origin/master` can lag local `master` by
weeks. GitHub (and `gh pr diff`) diff a PR against the **stale** `origin/master`,
so every PR renders the entire local-vs-fork delta — e.g. *1175 files /
+319,525 / -7,596* — and `gh pr diff` fails with
`HTTP 406 ... diff exceeded the maximum number of files (300)`. The genuine
change is usually a handful of files.

**Review SOP (one command).** To see a PR's real change set, diff against its
true merge-base with local `master` instead of the GitHub base:

```bash
tools/review-diff.sh <branch>          # summary (--stat)
tools/review-diff.sh <branch> --files  # changed file names
tools/review-diff.sh <branch> --diff   # full patch
tools/review-diff.sh --pr <number>     # resolve branch from a GitHub PR (needs gh)
```

Example — EDD-290 shows **3 files / 797 lines** here vs 1175 files on GitHub.

The helper is drift-proof: it always uses `git merge-base master <branch>`, so
it works correctly even when `origin/master` is stale.

## Keeping the GitHub review path healthy (recurrence prevention)

`review-diff.sh` fixes the **CLI** review path. To also fix the **GitHub web
UI** path, keep the fork's `origin/master` synced with local `master` so PRs
render against an up-to-date base:

```bash
# fast-forward only — safe; aborts if histories ever diverge
git push origin master:master
```

As of EDD-363 this was reconciled once (local `master` 759aa13 fast-forwarded
`origin/master` from 685ee84, 161 commits, 0 lost). It will drift again as
local `master` advances; re-run the push above, or have an agent/routine do it
periodically.
