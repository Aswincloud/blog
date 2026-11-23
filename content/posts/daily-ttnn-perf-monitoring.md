---
title: "Benchmarking Tenstorrent hardware every night from a repo that owns none of it"
date: 2026-10-27
lastmod: 2026-11-23
description: "A dashboard that times about 290 TTNN eltwise ops on real Tenstorrent cards every night. It runs from a public repo with no hardware, and since a security cleanup, no credential that can touch the repo that has the hardware. How four systems are wired together, why the credential split ended up the way it did, how a run went from 100 minutes to 20, and the failures that all lied about their cause."
slug: "daily-ttnn-perf-monitoring"
---

Every morning, [ttnn-eltwise-performance.aswincloud.com](https://ttnn-eltwise-performance.aswincloud.com) answers one question: **did any TTNN eltwise op on Tenstorrent hardware get slower last night?** TTNN is the op library on top of [tt-metal](https://github.com/tenstorrent/tt-metal). "Eltwise" means `add`, `exp`, `relu`, `div`, `gelu_bw` and about 290 others. Each one has its device-kernel time measured on a real card, on two boards, two dtypes and two shapes, and the results are charted.

The awkward part is where the pieces live:

- **The hardware runners** belong to `tenstorrent/tt-metal`.
- **My [dashboard repo](https://github.com/Aswincloud/ttnn-performance-dashboard)** is public, has no hardware, and since November holds no credential that can write to tt-metal.
- **The site and the email alerts** run on Cloudflare.
- **The one thing allowed to start a run** is a cron job on a machine under my desk.

This post covers how those four pieces are wired together, with the real commands. It also covers the parts I actually learned something from, which are all failures. Nearly every one of them initially pointed me at the wrong cause.

## The problem

Performance regressions in an op library are quiet. A kernel change makes `tanh_bw` 2× slower, every test still passes, and nobody notices until a model is slower and someone bisects for a week. What you want is a boring time series: every op, every night, on real silicon, with the commit next to each number.

There were three obstacles:

1. **No hardware of my own in CI.** The runners with N150 and P100a cards are tt-metal's. Jobs only run there if tt-metal's own workflow starts them.
2. **No write access from the dashboard side.** Starting a workflow on tt-metal is a write. A GitHub Actions job in my repo has a token for *my* repo only.
3. **It has to be trustworthy unattended.** A dashboard that's silently wrong is worse than none. Every number has to come from the configuration it claims to.

## How it's wired

<figure class="flow">
<svg viewBox="0 0 760 470" role="img" aria-label="Architecture: a dispatch box rebases and dispatches on tt-metal and starts the dashboard monitor; tt-metal jobs curl test scripts from the dashboard repo; the dashboard repo downloads artifacts and lands a PR, which Cloudflare deploys; the Worker serves the dashboard and emails alerts.">
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0,0 L10,5 L0,10 z"/></marker>
    <marker id="ahh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow hot" d="M0,0 L10,5 L0,10 z"/></marker>
  </defs>
  <!-- zones -->
  <rect class="zone" x="10" y="64" width="180" height="150" rx="10"/>
  <text class="zone-t" x="24" y="86">Dispatch box</text>
  <rect class="zone" x="240" y="64" width="250" height="250" rx="10"/>
  <text class="zone-t" x="254" y="86">tenstorrent/tt-metal</text>
  <rect class="zone" x="540" y="64" width="210" height="250" rx="10"/>
  <text class="zone-t" x="554" y="86">dashboard repo</text>
  <rect class="zone" x="240" y="350" width="510" height="110" rx="10"/>
  <text class="zone-t" x="254" y="372">Cloudflare</text>
  <!-- nodes -->
  <rect class="node hot" x="24" y="104" width="152" height="56" rx="8"/>
  <text class="node-t" x="36" y="127">perf-ci-dispatch.sh</text>
  <text class="node-s" x="36" y="146">cron 01:00 · gh</text>
  <rect class="node" x="256" y="104" width="218" height="46" rx="8"/>
  <text class="node-t" x="270" y="124">our branch</text>
  <text class="node-s" x="270" y="141">Aswinmcw/test_eltwise_perf</text>
  <rect class="node" x="256" y="178" width="218" height="52" rx="8"/>
  <text class="node-t" x="270" y="199">test-dispatch.yaml</text>
  <text class="node-s" x="270" y="218">1 build → 8 card jobs</text>
  <rect class="node" x="256" y="258" width="218" height="40" rx="8"/>
  <text class="node-t" x="270" y="283">8 artifacts (JSON)</text>
  <rect class="node" x="556" y="104" width="178" height="46" rx="8"/>
  <text class="node-t" x="570" y="124">test scripts</text>
  <text class="node-s" x="570" y="141">raw.githubusercontent</text>
  <rect class="node hot" x="556" y="178" width="178" height="52" rx="8"/>
  <text class="node-t" x="570" y="199">monitor workflow</text>
  <text class="node-s" x="570" y="218">github.token, read</text>
  <rect class="node" x="556" y="258" width="178" height="40" rx="8"/>
  <text class="node-t" x="570" y="283">data PR → main</text>
  <rect class="node" x="556" y="388" width="178" height="56" rx="8"/>
  <text class="node-t" x="570" y="410">Worker</text>
  <text class="node-s" x="570" y="429">SPA · JSON · /api</text>
  <rect class="node" x="256" y="388" width="178" height="56" rx="8"/>
  <text class="node-t" x="270" y="410">D1 + daily cron</text>
  <text class="node-s" x="270" y="429">alert subscribers</text>
  <!-- edges: privileged (green) -->
  <path class="edge hot" d="M176,120 L256,120" marker-end="url(#ahh)"/>
  <path class="edge hot" d="M176,146 C216,146 216,204 256,204" marker-end="url(#ahh)"/>
  <path class="edge hot" d="M100,104 L100,36 L645,36 L645,178" marker-end="url(#ahh)"/>
  <!-- edges: inside tt-metal -->
  <path class="edge" d="M365,150 L365,178" marker-end="url(#ah)"/>
  <path class="edge" d="M365,230 L365,258" marker-end="url(#ah)"/>
  <!-- edges: reads -->
  <path class="edge dash" d="M474,196 C515,196 515,127 556,127" marker-end="url(#ah)"/>
  <path class="edge hot flowing" d="M474,278 C515,278 515,214 556,214" marker-end="url(#ahh)"/>
  <path class="edge" d="M645,230 L645,258" marker-end="url(#ah)"/>
  <path class="edge" d="M645,298 L645,388" marker-end="url(#ah)"/>
  <path class="edge" d="M434,416 L556,416" marker-start="url(#ah)" marker-end="url(#ah)"/>
  <!-- step badges -->
  <g><circle class="num" cx="216" cy="120" r="10"/><text class="num-t" x="216" y="124">1</text></g>
  <g><circle class="num" cx="216" cy="176" r="10"/><text class="num-t" x="216" y="180">2</text></g>
  <g><circle class="num" cx="370" cy="36" r="10"/><text class="num-t" x="370" y="40">3</text></g>
  <g><circle class="num" cx="515" cy="160" r="10"/><text class="num-t" x="515" y="164">4</text></g>
  <g><circle class="num" cx="515" cy="246" r="10"/><text class="num-t" x="515" y="250">5</text></g>
  <g><circle class="num" cx="645" cy="343" r="10"/><text class="num-t" x="645" y="347">6</text></g>
  <g><circle class="num" cx="495" cy="416" r="10"/><text class="num-t" x="495" y="420">7</text></g>
  <!-- legend -->
  <text class="lbl" x="24" y="246">1  rebase + push</text>
  <text class="lbl" x="24" y="264">2  dispatch (→ run id)</text>
  <text class="lbl" x="24" y="282">3  start monitor(run_id)</text>
  <text class="lbl" x="24" y="300">4  jobs curl the tests</text>
  <text class="lbl" x="24" y="318">5  download results</text>
  <text class="lbl" x="24" y="336">6  merge → auto-deploy</text>
  <text class="lbl" x="24" y="354">7  serve + email alerts</text>
</svg>
<figcaption>Green is the privileged path. Only the box under my desk can write to tt-metal; everything else reads something public.</figcaption>
</figure>

Here is what happens each night:

1. **01:00 IST, on the box.** A plain crontab runs `perf-ci-dispatch.sh`. It rebases my tt-metal branch onto upstream `main` and pushes it.
2. **Still on the box,** it dispatches tt-metal's `test-dispatch.yaml` on that branch. The dispatch API returns the new run's ID directly.
3. **Still on the box,** it starts my repo's `daily-eltwise-perf.yml` with `mode=monitor run_id=<id>`. That's the hand-off, and the box is done.
4. **On tt-metal's runners,** one build of tt-metal fans out to eight hardware jobs. Each job `curl`s the test file and the harness from my repo's `main`.
5. **In my repo,** the monitor polls the run, downloads the eight result files, checks that each one measured what its name says, and commits them on a branch.
6. **A bot opens and approves the PR,** and the merge queue lands it. Cloudflare Workers Builds deploys every push to `main`.
7. **The Worker** serves the dashboard and the JSON. Its daily cron emails anyone whose thresholds were crossed.

At 05:00 IST a read-only **freshness check** confirms that all eight combos have a result from the last 24 hours. If any don't, it opens an issue and posts to Slack. Either the data is there by breakfast, or something tells me it isn't.

## The credential split, and why it's shaped this way

Until November, all of this ran from a single GitHub Actions workflow in my repo, using one classic personal access token, `TT_METAL_PAT`, that could push to and dispatch on tt-metal.

<figure class="flow">
<svg viewBox="0 0 760 170" role="img" aria-label="Before: the dashboard repo held a PAT that pushed to and dispatched on tt-metal. After the PAT ban that path is cut.">
  <defs>
    <marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0,0 L10,5 L0,10 z"/></marker>
  </defs>
  <rect class="zone" x="10" y="20" width="260" height="130" rx="10"/>
  <text class="zone-t" x="24" y="42">dashboard repo (public)</text>
  <rect class="node" x="26" y="60" width="228" height="70" rx="8"/>
  <text class="node-t" x="40" y="86">daily workflow</text>
  <text class="node-s" x="40" y="108">secrets.TT_METAL_PAT</text>
  <rect class="zone" x="490" y="20" width="260" height="130" rx="10"/>
  <text class="zone-t" x="504" y="42">tenstorrent/tt-metal</text>
  <rect class="node" x="506" y="60" width="228" height="70" rx="8"/>
  <text class="node-t" x="520" y="86">push · dispatch · rerun</text>
  <text class="node-s" x="520" y="108">all writes</text>
  <path class="edge bad" d="M254,95 L506,95" marker-end="url(#ah2)"/>
  <line class="x" x1="368" y1="80" x2="392" y2="110"/><line class="x" x1="392" y1="80" x2="368" y2="110"/>
  <text class="lbl" x="300" y="135">PATs banned, Nov 2026</text>
</svg>
<figcaption>The old shape: a long-lived personal token in a public repo's secrets, with write access to someone else's repo.</figcaption>
</figure>

Then tt-metal had a security incident. As part of the cleanup, **personal access tokens were banned for tenstorrent repos**, and mine died on 8 November. The dashboard went dark for eight days.

I couldn't move the schedule onto tt-metal's `main`: that's their repo, and a cron there isn't mine to add. A GitHub App or a fine-grained token would need an admin to approve it during an incident response. So I asked a narrower question: *which steps actually need to write to tt-metal?*

Only three:
- the rebase push,
- the dispatch,
- re-running failed jobs.

Everything else (run status, the job list, the artifact zips) is a **read** of a public repo. A repo's own `github.token` is enough for those.

So the pipeline is split by privilege:

| Runs where | Does | Credential |
|---|---|---|
| a cron on a machine I control | rebase, push, dispatch, `--rerun` | my local `gh` login, which never leaves the machine |
| GitHub Actions in the public repo | poll, download, verify, open the PR | `github.token`, read-only on tt-metal |
| Cloudflare | serve, email | Worker secrets |

The box opens no inbound connections. It pushes out and dispatches, then starts my workflow with the run ID. The public repo now holds no tenstorrent credential at all, which is how it should have been from the start.

The dispatch on the box is a single API call with every input fixed in the script, because tt-metal's `command` input runs arbitrary shell on their hardware:

```bash
TT_COMMAND='set -euo pipefail
curl -fsSL '"$RAW_BASE"'/test_eltwise_operations.py -o /work/test_eltwise_operations.py
curl -fsSL '"$RAW_BASE"'/perf_measurement_script.py -o /work/perf_measurement_script.py
cd /work && python perf_measurement_script.py --in-process --shard "$SHARD/$SHARD_TOTAL"'

jq -n --arg ref "$TT_BRANCH" --arg cmd "$TT_COMMAND" '{
  ref: $ref,
  return_run_details: true,            # the API answers with the new run id
  inputs: { arch: "wormhole_b0", "runner-label": "[\"tt-ubuntu-2204-N150-viommu-stable\"]",
            tracy: "true", command: $cmd } }' \
| gh api -X POST repos/tenstorrent/tt-metal/actions/workflows/test-dispatch.yaml/dispatches --input -
```

`return_run_details: true` is newer than most of this pipeline. For months I found my run by snapshotting the run list before dispatching and diffing it afterwards. That snapshot caused one of the failures below. Now the API simply returns the run's ID, and the snapshot is only a fallback.

## The matrix: one build, eight jobs

Building tt-metal takes about 12 minutes, and the device arch is only a runtime setting. So one build fans out to every combination:

```yaml
matrix:
  board: [n150, p100a]
  dtype: [bf16, fp32]
  shape: [32x32, 256x256]
  shard: [1]
  include:
    - { board: n150,  label: tt-ubuntu-2204-N150-viommu-stable,  arch: wormhole_b0 }
    - { board: p100a, label: tt-ubuntu-2204-P100a-viommu-stable, arch: blackhole }
    - { dtype: bf16, perf_dtype: bfloat16 }
    - { dtype: fp32, perf_dtype: float32 }
    - { shape: 32x32,   perf_shape: "1,1,32,32" }
    - { shape: 256x256, perf_shape: "1,1,256,256" }
```

A job learns its configuration only through environment variables (`ARCH_NAME`, `PERF_DTYPE`, `PERF_SHAPE`), so a single test file serves all eight. The runner label stays in `matrix.label` rather than being hardcoded in `runs-on`. The container setup substring-matches it to pick viommu mounts, and a missing label quietly mounts host paths that don't exist.

## From 100 minutes to 20

Until November each combo needed **five shards**, and a run took about 100 minutes. The reason was how the timing was taken. Every timed iteration of every op started a fresh Python process under tt-metal's Tracy profiler, which opens the device, runs, writes a profiler log, and closes the device. Three runs × 258 ops is 774 device opens per combo.

The harness now has an `--in-process` mode. It runs the whole suite in **one** pytest session, opens the device once, and reads each op's kernel time straight from tt-metal's device profiler:

```python
ttnn.ReadDeviceProfiler(device)
for programs in ttnn.get_latest_programs_perf_data().values():
    for p in programs:
        total += p.program_analyses_results["DEVICE KERNEL DURATION [ns]"].duration
```

A whole combo now finishes in about a minute on one runner. Sharding only multiplied setup cost, so it's down to one job per combo. That freed enough runner time to stop rationing Blackhole: P100a used to run a single combo, and now it runs all four, like N150. The run has gone from about 100 minutes to about 20, and most of what's left is queueing for runners.

Two details worth keeping:

- **A correctness flake no longer deletes a timing.** Ops like `prod` on random inputs sometimes miss their PCC threshold. The old profiler wrapper never looked at pytest's exit code, so those still got timed. The in-process mode does the same deliberately: if the op ran on the device, its timing is kept and flagged in `correctness_check_failures`. Only an op that never reached the device counts as failed.
- **Some ops have no kernel to time.** `real`, `imag`, `complex_tensor`, `frac_bw` and `assign_bw` all pass their tests, but launch nothing on the device; they view, pack, or return the gradient as is. They had been skipped for months under a comment that said "known failing", which was wrong. They're still skipped, now with the real reason.

## Failure 1: the merge conflict that wasn't

For two days in August, both nightly pipelines failed. Slack said:

> tt-metal branch rebase conflicted with origin/main — no dispatch made.

There was no conflict. A plain clone rebased all 13 commits cleanly. The real error was one line up in the log:

```
fatal: remote error: upload-pack: not our ref 9a7048e5…
```

The rebase ran in a `--filter=blob:none` clone. A blobless clone fetches file contents lazily, *during* the rebase, and that fetch was what failed. But the workflow labelled **any** non-zero exit from `git rebase` as a conflict. The alert didn't just fail to help; it sent me looking for the wrong problem.

```bash
# A real conflict leaves unmerged paths. A transport failure doesn't.
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  KIND=rebase-conflict    # genuinely needs a human
else
  KIND=rebase-failed      # network or clone problem; a re-run clears it
fi
```

The box script now rebases inside a worktree of a full local clone, so it can't fail this way any more. The lesson I keep from it: **an error label is a claim about the cause, and a wrong one costs more than no label at all.**

## Failure 2: the library a refactor quietly unhooked

In late August every run started dying at the wheel build:

```
ValueError: Cannot repair wheel, because required library
            "libtracy.so.0.13.3" could not be located
```

My first theory was that upstream `main` was broken. It wasn't: other people's runs were green that same night. The clue was a file size. In their builds `libtracy.so` was **12K**, and in mine it was **491K**. With `tracy=false`, tt-metal builds a stub that nothing links against. With `tracy=true`, which I need because every number comes from the device profiler, the real library is a dependency that `auditwheel` must find. An upstream cleanup had removed the build-dir `RPATH` it used to find it by. The fix was already in tt-metal, in the other wheel path, which tt-metal's own profiler pipeline uses:

```diff
-      build-wheel: true
+      build-inplace-wheel: true
```

When "it's broken upstream" turns out to be broken only for *you*, diff your setup against someone it works for.

## Failure 3: one flaky job throws away the whole day

The tt-metal run is all-or-nothing. One night, 19 of 20 jobs passed and the whole day was discarded. Re-running only the failed jobs is safe, because the passing jobs' artifacts survive into the next attempt. It's worth doing only for a *partial* failure: if nothing passed, the build broke, and a retry just burns the build time again.

This is now `perf-ci-dispatch.sh --rerun <id>` on the box. A rerun is a write to tt-metal, and the public repo deliberately can't do writes any more. One trap stays the same. For a few seconds after a rerun is accepted, the API still reports the old `completed/failure`. Wait for `run_attempt` to tick over before believing anything.

## Failure 4: the recovery job that ingested the past

In July, GitHub cancelled my workflow partway through polling. The tt-metal run succeeded, but nothing collected it. My alert steps used `if: failure()`, and a cancellation is `cancelled()`, so the steps were *skipped*. The day's data vanished silently. That gave me alerts on `failure() || cancelled()`, a manual `mode=recover`, and a 05:00 safety-net that automatically ingested the newest successful run.

Then the safety-net ingested a run from **three weeks earlier**. That night, the run listing taken before the dispatch had failed. A `|| true` turned the failure into an empty list, so every run looked new and dispatch aborted. The safety-net then took `.[0]` of the run list, assuming it was the newest. It wasn't.

```bash
-q '.[0].databaseId'                                          # before: trust API order
--json databaseId,createdAt -q 'sort_by(.createdAt) | reverse | .[0].databaseId'
```

That safety-net is gone now. With a precise run ID handed over from the box, nothing ever has to guess which run is tonight's. The 05:00 job became a **read-only freshness check**. It ingests nothing; it only asks whether all eight combos have a result from the last 24 hours. Automatic recovery that can be wrong turned out to be worth less than an alert that can't be.

## The guard I'm most glad I built before I needed it

The dashboard decides where a result goes, say `p100a/fp32/256x256`, from the artifact's **name**. But what was actually measured depends on environment variables reaching a test file `curl`ed from `main` at run time. Those two halves change independently. So every result records what it really measured:

```json
"perf_dtype": "float32", "perf_shape": "1,1,256,256", "perf_arch": "blackhole"
```

The merge step refuses to combine shards that disagree. Just before committing, the pipeline compares those fields with the directory the file is about to go into, and if they don't match it refuses the whole day (`combo-provenance-mismatch`). I've never seen it fire. That's the point: a loud failure costs me one morning, but a quiet mislabel would poison every comparison against that day.

The same rule decides rollout order. If a change needs new harness behaviour, merge the dashboard first, since the test file is fetched from there. If it only adds matrix jobs, push tt-metal first. Either way, a mismatch fails loudly instead of landing wrong data.

## Run it yourself

**Just want last night's numbers?** No credentials needed:

```
https://raw.githubusercontent.com/Aswincloud/ttnn-performance-dashboard/main/data/latest/latest_<combo>.json
```

`<combo>` is `[p100a_]<bf16|fp32>_<32x32|256x256>`: `bf16_32x32`, `fp32_256x256`, `p100a_bf16_32x32`, and so on. With no board prefix, it's N150.

**Have a card?** Run it locally from a tt-metal checkout:

```bash
cd ~/tt-metal && source python_env/bin/activate
curl -fsSLO https://raw.githubusercontent.com/Aswincloud/ttnn-performance-dashboard/main/test_eltwise_operations.py
curl -fsSLO https://raw.githubusercontent.com/Aswincloud/ttnn-performance-dashboard/main/perf_measurement_script.py
PERF_DTYPE=bf16 PERF_SHAPE=1,1,32,32 python perf_measurement_script.py --in-process
```

Run it from the tt-metal root, whose `pytest.ini` the harness relies on to collect tests.

**Have push access to tt-metal and want CI hardware?** Run on **your own** branch, never on mine. My nightly job force-pushes my branch, so anything you push there disappears overnight. Never touch `main` either. The script below copies my branch to `<your-login>/eltwise-perf` server-side (no clone) and refuses to run on mine or `main`. It uses your local `gh` login, the same way my box does.

```bash
#!/usr/bin/env bash
# Trigger the TTNN eltwise perf sweep on tt-metal and turn it into CSVs.
# Needs: gh CLI logged in with push access to tenstorrent/tt-metal, jq, python3.
set -euo pipefail

TT_REPO=tenstorrent/tt-metal
SOURCE_BRANCH=Aswinmcw/test_eltwise_perf           # copy it; never run on it
TT_BRANCH="${TT_BRANCH:-$(gh api user -q .login)/eltwise-perf}"
RAW_BASE=https://raw.githubusercontent.com/Aswincloud/ttnn-performance-dashboard/main
TT_COMMIT="${TT_COMMIT:-}"                          # optional branch/SHA to measure

case "$TT_BRANCH" in "$SOURCE_BRANCH"|main) echo "use your own branch" >&2; exit 1 ;; esac
SRC_SHA=$(gh api "repos/$TT_REPO/git/ref/heads/$SOURCE_BRANCH" -q .object.sha)
if ! gh api "repos/$TT_REPO/git/ref/heads/$TT_BRANCH" >/dev/null 2>&1; then
  gh api "repos/$TT_REPO/git/refs" -f ref="refs/heads/$TT_BRANCH" -f sha="$SRC_SHA" >/dev/null
elif [ "${REFRESH:-0}" = 1 ]; then
  gh api -X PATCH "repos/$TT_REPO/git/refs/heads/$TT_BRANCH" -f sha="$SRC_SHA" -F force=true >/dev/null
fi

CMD='set -euo pipefail
curl -fsSL '"$RAW_BASE"'/test_eltwise_operations.py -o /work/test_eltwise_operations.py
curl -fsSL '"$RAW_BASE"'/perf_measurement_script.py -o /work/perf_measurement_script.py
cd /work && python perf_measurement_script.py --in-process --shard "$SHARD/$SHARD_TOTAL"'

RUN_ID=$(jq -n --arg ref "$TT_BRANCH" --arg cmd "$CMD" --arg commit "$TT_COMMIT" '{
    ref: $ref, return_run_details: true,
    inputs: ({ arch: "wormhole_b0", "runner-label": "[\"tt-ubuntu-2204-N150-viommu-stable\"]",
               tracy: "true", command: $cmd } + (if $commit != "" then {commit: $commit} else {} end)) }' \
  | gh api -X POST "repos/$TT_REPO/actions/workflows/test-dispatch.yaml/dispatches" --input - \
  | jq -r .workflow_run_id)
echo "run: https://github.com/$TT_REPO/actions/runs/$RUN_ID"

gh run watch "$RUN_ID" -R "$TT_REPO" --interval 60 --exit-status || {
  echo "re-run only the failed jobs with: gh run rerun $RUN_ID -R $TT_REPO --failed" >&2; exit 1; }

OUT="perf-$RUN_ID"; mkdir -p "$OUT/tools"
gh run download "$RUN_ID" -R "$TT_REPO" -p 'eltwise-perf-results-*' -D "$OUT/artifacts"
curl -fsSL "$RAW_BASE/perf_measurement_script.py" -o "$OUT/tools/perf_measurement_script.py"
curl -fsSL "$RAW_BASE/combine_to_csv.py"          -o "$OUT/tools/combine_to_csv.py"
PYTHONPATH="$OUT/tools" python3 "$OUT/tools/combine_to_csv.py" "$OUT/artifacts" "$OUT"
```

You end up with one CSV and one merged JSON per combo in `perf-<run-id>/`. The JSON's `metadata.git_commit_id` is the tt-metal commit that was actually built, so check it there when you pass `TT_COMMIT`: the run page always shows the branch tip instead.

A few things that trip people up:

- **Use the API call, not the web form.** The form's `command` box is a single line. Pasting multiple lines turns the newlines into spaces, so `set -euo pipefail` swallows every command after it.
- **Keep `"$SHARD/$SHARD_TOTAL"` literal.** tt-metal's matrix fills it in for each job.
- **Artifacts expire after about 90 days.** After that, only the merged results in the dashboard repo remain.

## What's still rough

- **The alert emails watch the wrong index.** The Cloudflare Worker's daily cron still reads the original `data/index.json`, whose newest entry is from July. Every result since then lands under `data/workflow/`. So since July the alert job has seen the same newest measurement every morning and correctly decided there was nothing new to send. It's the same class of bug as the others in this post: a component that's quietly sure of something that stopped being true. Pointing it at the per-combo index is next.
- **Day-over-day colouring is noisy.** Kernel times jitter by a few percent, and the table colours cells from about 3%. A rolling median would separate real regressions from weather.

## Takeaway

The pipeline itself was an afternoon's work. The interesting parts were the failures, and how many of them initially told me something false:

- a **conflict** that was really a failed network fetch,
- an **upstream break** that only affected my build flag,
- a **cancellation** that the alerts had been written to skip,
- a **"newest" run** that was three weeks old,
- a test list that said **"known failing"** about tests that never failed.

The security change pushed it the same way. Splitting by privilege didn't just satisfy a policy. It made each piece do one honest thing: the box writes, the public repo reads and verifies, and Cloudflare serves. The numbers on the dashboard are only worth anything if the pipeline behind them can't quietly be wrong. The [code is public](https://github.com/Aswincloud/ttnn-performance-dashboard) if you want every command above, unedited.
