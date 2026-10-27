---
title: "Benchmarking Tenstorrent hardware every night from a repo that owns none of it"
date: 2026-10-27
description: "A dashboard that times 258 TTNN eltwise ops on real Tenstorrent cards every night, driven entirely from GitHub Actions in a repo with no hardware and no write access to the one that has it. Building it took an afternoon. Keeping it honest took three months of failures that all lied about their cause — a merge conflict that wasn't one, a library a refactor quietly unhooked, and a recovery job that confidently ingested a run from three weeks ago."
slug: "daily-ttnn-perf-monitoring"
---

I maintain a dashboard — [ttnn-eltwise-performance.aswincloud.com](https://ttnn-eltwise-performance.aswincloud.com) — that answers one question every morning: **did any TTNN eltwise op on Tenstorrent hardware get slower last night?** TTNN is the op library on top of [tt-metal](https://github.com/tenstorrent/tt-metal). "Eltwise" means `add`, `exp`, `relu`, `sigmoid` and about 250 friends. Each one gets its device-kernel time measured on a real card, every day, and charted.

The awkward part is where the pieces live. The hardware runners belong to `tenstorrent/tt-metal`. My [dashboard repo](https://github.com/Aswincloud/ttnn-performance-dashboard) has no hardware and cannot write to tt-metal. So the whole pipeline is one repo reaching into another: dispatch a job over there, wait for it, collect what it left behind, and land it over here as a pull request.

This post covers how that works, with the real commands. It also covers the parts I actually learned something from, which are all failures. Every one of them, at first, told me the wrong thing about its own cause.

## The shape of the thing

One GitHub Actions workflow, two crons:

```yaml
on:
  schedule:
    - cron: "30 19 * * *"   # 01:00 IST — the main run
    - cron: "30 23 * * *"   # 05:00 IST — the safety-net (more on this later)
```

The main run does five things in order:

1. **Rebase** my tt-metal branch onto upstream `main`, so the build tooling stays current.
2. **Dispatch** tt-metal's own `test-dispatch.yaml` workflow on that branch.
3. **Poll** that run until it finishes, which takes about 100 minutes.
4. **Download** its artifacts and merge them into one result file per configuration.
5. **Commit** the results to a branch and open a PR. A bot approves it and the merge queue lands it.

Nothing on the tt-metal side belongs to the dashboard except one branch, `Aswinmcw/test_eltwise_perf`. That branch carries a single modified file: the matrix inside `test-dispatch.yaml`.

## The dispatch, verbatim

This is the call the workflow makes. Every flag here earned its place:

```bash
# $SHARD / $SHARD_TOTAL are single-quoted on purpose: they must NOT expand
# on our runner. tt-metal's matrix sets them per cell at run time.
CMD='set -euo pipefail
uv pip install ttperf
curl -fsSL '"${RAW_BASE}"'/test_eltwise_operations.py -o /work/test_eltwise_operations.py
curl -fsSL '"${RAW_BASE}"'/perf_measurement_script.py -o /work/perf_measurement_script.py
cd /work && python perf_measurement_script.py --shard "$SHARD/$SHARD_TOTAL"'

gh workflow run test-dispatch.yaml -R tenstorrent/tt-metal \
  --ref Aswinmcw/test_eltwise_perf \
  -f arch=wormhole_b0 \
  -f 'runner-label=["tt-ubuntu-2204-N150-viommu-stable"]' \
  -f tracy=true \
  -f command="$CMD"
```

A few details that are not obvious:

- **The test scripts are not vendored into tt-metal.** They are `curl`ed from my repo's `main` at run time, so editing a test never needs a tt-metal commit. That convenience has a price, which I'll get to.
- **`tracy=true` is mandatory.** Every number on the dashboard comes from [`ttperf`](https://pypi.org/project/ttperf/), my wrapper around tt-metal's Tracy device profiler. Each op gets three runs, and I regex one line out of the profiler output: `DEVICE KERNEL DURATION [ns] total: …`. With `tracy=false`, tt-metal builds with `--disable-profiler`. That doesn't give worse numbers. It gives none.
- **`arch` and `runner-label` are placeholders.** The schema requires them, but my branch's matrix decides the real hardware per cell.
- **`description` and `commit` are deliberately left unset.** More on why in a moment.

## The matrix: one build, 25 cells

Building tt-metal takes about 12 minutes, and the device arch is only a runtime setting. So one build fans out to every configuration:

```yaml
matrix:
  board: [n150, p100a]
  dtype: [bf16, fp32]
  shape: [32x32, 256x256]
  shard: [1, 2, 3, 4, 5]
  exclude:                       # Blackhole only runs one combo
    - { board: p100a, dtype: fp32 }
    - { board: p100a, shape: 256x256 }
  include:
    - { board: n150,  label: tt-ubuntu-2204-N150-viommu-stable,  arch: wormhole_b0 }
    - { board: p100a, label: tt-ubuntu-2204-P100a-viommu-stable, arch: blackhole }
    - { dtype: bf16, perf_dtype: bfloat16 }
    - { dtype: fp32, perf_dtype: float32 }
    - { shape: 32x32,   perf_shape: "1,1,32,32" }
    - { shape: 256x256, perf_shape: "1,1,256,256" }
```

That is 20 Wormhole N150 cells plus 5 Blackhole P100a cells. Each cell is one of five shards of the 258-op list, and a cell only learns its configuration through environment variables (`PERF_DTYPE`, `PERF_SHAPE`, `ARCH_NAME`). The test file reads them, so a single test file serves every combination.

Two things in here bit me:

- **The runner label has to stay in `matrix.label`, never hardcoded at `runs-on`.** The container setup further down checks `contains(matrix.label, 'viommu')` to pick its mounts. When I briefly hardcoded the runner while refactoring, that check would have evaluated to empty and quietly mounted host paths that don't exist on a viommu pod. YAML can't warn you about a missing value it was only ever going to substring-match.
- **Sharding is a stride, not a block.** Each shard takes every 5th test, not a contiguous fifth. Slow ops spread out evenly, and the five shards finish within minutes of each other.

## Finding the run you just started

`gh workflow run` returns no ID. It just says "dispatched." So which of the hundreds of runs on that branch is mine?

My first version picked the newest run created after a timestamp. That breaks as soon as anyone, including me, dispatches by hand at the same time. The version that survived takes a snapshot of run IDs before dispatching and diffs it afterwards:

```bash
BEFORE_IDS=$(list_runs | sort -u)
gh workflow run test-dispatch.yaml ...
# poll until exactly one ID appears that wasn't there before
NEW_IDS=$(comm -13 <(printf '%s\n' "$BEFORE_IDS") <(list_runs | sort -u))
# 2+ new IDs → fail loudly. Never guess whose run is whose.
```

This is also why `description` stays unset. Tagging runs with a description is the obvious approach. A set difference is the correct one, because it doesn't depend on anything the run says about itself.

That snapshot also produced one of the more instructive failures here. It's further down.

## Failure 1: the merge conflict that wasn't

For two days in August, both nightly pipelines failed. Slack said:

> tt-metal branch rebase conflicted with origin/main — no dispatch made.

So I went looking for a conflict. There wasn't one. A plain clone rebased all 13 commits onto `main` without a single conflict. The real error was one line up in the log:

```
fatal: remote error: upload-pack: not our ref 9a7048e5…
```

The workflow cloned tt-metal with `--filter=blob:none` to save time. A blobless clone downloads file contents lazily, *during* the rebase, over the network. That lazy fetch was what failed. The workflow, though, labelled **any** non-zero exit from `git rebase` as a conflict. So the alert didn't just fail to help; it pointed me at the wrong problem.

The fix had two halves, and the second matters more:

```bash
git clone --no-checkout "$AUTH" ttm   # full clone: ~1.5 GB, under a minute
# A real conflict leaves unmerged paths. A transport failure doesn't.
if ! OUT=$(git rebase origin/main 2>&1); then
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    KIND=rebase-conflict    # genuinely needs a human
  else
    KIND=rebase-failed      # network or clone problem; a re-run clears it
  fi
fi
```

A full clone made the rebase purely local, so it can't fail that way any more. But the cheaper lesson was the second half: **an error label is a claim about the cause, and a wrong one costs more than no label at all.** "Conflict" sent me reading diffs for an hour. "Failed, no conflicting files" would have sent me to the re-run button.

## Failure 2: the library a refactor quietly unhooked

In late August every run started dying at the wheel build:

```
ValueError: Cannot repair wheel, because required library
            "libtracy.so.0.13.3" could not be located
```

My first theory was "upstream main is broken." I said so with some confidence. I was wrong, and a quick look proved it: other people's `test-dispatch` runs on `main` were green that same night.

The difference was one flag, and the clue was a file size. In their builds, `libtracy.so` was **12K**. In mine it was **491K**. With `tracy=false`, tt-metal builds a stub that nothing links against. With `tracy=true`, the real library is an actual dependency of the wheel, so `auditwheel` has to find it while packaging. It used to find it through a build-directory entry in `INSTALL_RPATH`. An upstream cleanup, sensibly, removed that entry. As far as I could tell, we were the only consumer building with tracy on. So nobody else noticed, and there was nothing upstream to find.

The fix was already in tt-metal's own repo. `build-artifact.yaml` has two ways to build a wheel. The second one passes the library path to `auditwheel` explicitly:

```bash
LD_LIBRARY_PATH=/work/build/lib auditwheel repair ...
```

That's exactly why tt-metal's own profiler pipeline pairs `tracy: true` with it. So the fix on my branch was one line:

```diff
-      build-wheel: true
+      build-inplace-wheel: true
```

It was also faster, since that path skips a second full compile. What I took away: when "it's broken upstream" turns out to be broken only for *you*, diff your setup against someone it works for. Theirs was green; the 12K-versus-491K file size was the whole answer.

## Failure 3: one flaky cell throws away the whole day

The tt-metal run is all-or-nothing. If any one cell fails, the whole run reports `failure`. One night in August, 19 of 20 cells passed and the day was thrown away anyway, because a single shard hit a hardware hiccup. I clicked "Re-run failed jobs" by hand, it passed, and I decided I wasn't clicking that button every week.

The poll step now does it once, automatically. But only for a *partial* failure:

```bash
if [ "$RETRIES_LEFT" -gt 0 ] && [ "$OK_CELLS" -gt 0 ] && [ "$BAD_CELLS" -gt 0 ]; then
  gh run rerun "$RUN_ID" -R tenstorrent/tt-metal --failed
  # wait for run_attempt to tick over BEFORE polling again
fi
```

The condition is the important part. If **zero** cells passed, the build itself broke, like in Failure 2. Retrying a broken build just burns another 12 minutes. A retry only makes sense when the failure looks random.

I checked first that a partial re-run keeps the artifacts from the cells that passed. It does: all 19 survived into attempt two. There's also a subtle trap after the re-run is accepted. For a few seconds, the API still reports the old `completed/failure`. A poller that resumes straight away reads that stale status, decides the retry failed, and gives up. So it waits for `run_attempt` to increment first.

## Failure 4: the recovery job that ingested the past

This one is the reason the safety-net cron exists, and also the reason it once failed.

**Why it exists:** in July, GitHub cancelled my workflow's runner partway through polling. The tt-metal run kept going and succeeded, but nothing was waiting to collect it. Worse, my alert steps used `if: failure()`. A cancellation is `cancelled()`, not `failure()`, so those steps were *skipped*. The day's data vanished without a sound. Three fixes followed: alerts now fire on `failure() || cancelled()`; there's a manual `mode=recover` to ingest an already-finished run; and a 05:00 IST cron checks whether today's data actually landed and, if not, ingests the newest successful tt-metal run.

**Why it failed:** this month the main run died with `dispatch-ambiguous`, listing **37 "new" runs**: every run that branch had ever had. The listing *before* dispatch had failed, and a `|| true` meant to prevent crashes turned that failure into an empty list. Diffing against an empty list makes everything look new.

Then the safety-net woke up to recover. It asked for the newest successful run and took the first item in the list, `.[0]`. It got a run from **three weeks earlier**, older than the Blackhole combo itself. Downloading the Blackhole artifact from that old run matched nothing, `gh` exited 1, and the step died before any of my own error handling ran. The Slack alert came with an empty reason.

So two separate mistakes landed on the same night:

```bash
# Before: trust the API's list order
-q '.[0].databaseId'
# After: sort by creation time explicitly
--json databaseId,createdAt -q 'sort_by(.createdAt) | reverse | .[0].databaseId'
```

Then two more guards. The safety-net now refuses any run older than 30 hours, because its whole job is to rescue *tonight*. And the snapshot before dispatch now retries, then refuses to dispatch at all if it can't list the existing runs. For a step whose only job is telling runs apart, an empty list isn't a safe default. It's the worst possible answer.

## The guard I'm most glad I built before I needed it

All of these failures were loud. The scary one was a failure that would have stayed silent.

The dashboard decides where a result goes, say `fp32/256x256`, purely from the artifact's **name**. But what actually got measured depends on the environment variables reaching a test file that is curled from `main` at run time. Those two halves change independently. If the matrix ever sets `PERF_DTYPE=float32` while the curled file doesn't read it yet, bfloat16 numbers get filed under float32. Nothing in the data would show it.

So every result now records what it actually measured:

```json
"perf_dtype": "float32",
"perf_shape": "1,1,256,256",
"perf_arch": "blackhole"
```

The shard merge refuses to combine shards that disagree on any of those fields. And just before committing, the pipeline compares them with the directory the file is about to go into:

```bash
if [ "$NORM_DT" != "$DT" ] || [ "$GOT_SHAPE" != "$WANT_SHAPE" ]; then
  echo "FAIL_KIND=combo-provenance-mismatch"   # refuse the whole day
  exit 1
fi
```

I've never seen it fire. That's fine, because that's the point. Its value is that a mislabelled number is now impossible rather than merely unlikely. A loud failure costs me one morning. A quiet mislabel would poison every future comparison against that day.

The same reasoning decided the rollout order when I added the float32 axis. The dashboard change went in *first*, and I confirmed `raw.githubusercontent.com` was actually serving the new test file before I touched the matrix. The other order would have measured bfloat16 twice and stored half of it under the wrong name.

## Credentials, briefly

It runs on four kinds of credentials, each scoped to one job:

- **`TT_METAL_PAT`**, a classic personal access token with `repo` and `workflow` scopes. It's used for everything that touches tt-metal, because the dashboard repo's own `GITHUB_TOKEN` can't reach another org.
- **A GitHub App** that authors the results PR, so data commits show up as a bot rather than as me.
- **`WRITE_ACCESS_PAT`**, a separate account allowed to bypass code-owner review. It approves the bot's PR. The auto-approve workflow deliberately ignores bot authors, so something has to do this explicitly.
- **`SLACK_BOT_TOKEN`**, which posts failures with a human-readable reason for each failure kind. As Failures 1 and 4 showed, getting that reason *right* is most of the value.

Checkout runs with `persist-credentials: false`. Otherwise the read-only `GITHUB_TOKEN` is left in git config, overrides the App token on push, and the PR push fails with a 403.

## Takeaway

The pipeline was an afternoon's work. Dispatch a workflow, wait, download, commit: none of it is clever. It has run about 200 times, with 185 successes. The interesting part is the 15 failures, and how many of them initially told me something false:

- a **conflict** that was a network fetch,
- an **upstream break** that only affected my build flag,
- a run **cancellation** the alerts were built to skip,
- a **"newest" run** that was three weeks old.

Each time, the fix that mattered wasn't the patch. It was making the system's account of itself honest: labels that name the real cause, recovery that refuses stale input, and data that records what it actually measured. The numbers on the dashboard are only worth anything if the pipeline behind them can't quietly be wrong. The [code is public](https://github.com/Aswincloud/ttnn-performance-dashboard) if you want the unedited version of every command above.
