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
local `master` advances; re-run the push above, or rely on the automated
routine below.

## Automated fork-master sync routine (EDD-365)

The one-time reconcile above is made **continuous** by the Paperclip routine
**"Fork master auto-sync (FF-only, never force)"** (owner: Architect, project
*Operationalization*). It fires hourly (`0 * * * *`, America/Denver), creates an
execution issue, and runs this exact SOP:

1. `git fetch origin master`
2. Compare `LOCAL=git rev-parse master`, `ORIGIN=git rev-parse origin/master`,
   `BASE=git merge-base master origin/master`, then branch on four cases:
   - **in sync** (`LOCAL == ORIGIN`) → quiet no-op.
   - **local ahead** (`BASE == ORIGIN`) → `git push origin master:master` (no
     `--force`/`--force-with-lease`); the true fast-forward case.
   - **origin ahead** (`BASE == LOCAL`) → nothing to push; no-op (no pull, no
     force — local catching up is out of scope).
   - **diverged** (`BASE` is neither) → **never force**; file a `high` alert
     issue to Architect + CEO with the three SHAs and ahead/behind counts, then
     stop.

**Hard invariant:** the routine never force-pushes or rewrites `origin/master`
history. Plain `git push origin master:master` is the only push it issues, and
git itself refuses any non-fast-forward. Routine health surfaces via its
`lastRun.status` for the CEO routine-health audit.

To inspect or pause it: `GET /api/companies/{companyId}/routines` (find it by
title) or `PATCH /api/routines/{routineId} { "status": "paused" }`.
