---
title: "43 red Dependabot PRs, and not one was the dependency's fault"
date: 2026-07-26
description: "My GitHub org had 43 open Dependabot PRs, most of them showing red CI. The obvious story is 'these upgrades break things.' The actual story is that a red check can lie exactly the same way a green one can — and telling the two apart is the whole job."
slug: "43-red-dependabot-prs-none-were-the-dependency"
---

I opened the pull-requests tab across my [GitHub org](https://github.com/Aswincloud) one morning and found **43 open Dependabot PRs**, most of them flying red CI. The tempting read is the cynical one: dependency upgrades are a treadmill, half of them break your build, this is just the tax. Merge the green ones, ignore the rest, move on.

I nearly did exactly that. I'm glad I didn't, because when I actually dug in, the punchline was almost funny: **of ~25 PRs showing failing CI, not one failed because of the dependency it was bumping.**

## What a red check actually told me

Here's the thing I keep having to relearn. I've written before — about [a status page that was green for the wrong reason](/posts/status-page-that-survives-home/) — that a check passing tells you less than you think. This was the mirror image: a check *failing* also tells you less than you think. A red X means "this branch, as it exists right now, doesn't pass." It does **not** mean "the change in this PR is the reason."

Dependabot opens a PR by branching off your default branch at some moment in time and applying one dependency bump. If `main` was healthy at that moment, a red check genuinely implicates the bump. But if `main` itself was *broken* when the branch was cut, every PR branched from that point inherits the breakage — and the red X is pointing at a bug that has nothing to do with the dependency at all.

> A failing check on a stale branch is a photograph of a problem that may already be fixed upstream. You're not looking at your code; you're looking at the past.

So before triaging a single PR, I asked a different question: **when were these branches cut, and what did `main` look like then?**

```bash
# Group the org's Dependabot PRs by the day their branch was created.
# A tight cluster of "failing since <date>" is the tell: they share a cause,
# and that cause is almost certainly the state of main on that date — not
# 25 unrelated dependencies all breaking at once.
gh search prs --owner Aswincloud --author "app/dependabot" --state open \
  --json number,repository,createdAt,title \
  --jq 'group_by(.createdAt[0:10])[] | {day: .[0].createdAt[0:10], count: length}'
```

The failures clustered. A big batch of them, across two different repos, had all branched on the *same day* — a day when, checking the history, both of those repos' `main` branches were themselves red. One had a lint error in a UI banner component that had since been fixed. The other had a broken deploy step, also since fixed. The dependencies were innocent bystanders. The PRs were just **stale** — carrying a months-old breakage that no longer existed on `main`.

## The one-word fix

Once you know a branch is stale rather than broken, the fix is almost insultingly simple: rebase it onto current `main` and let CI run again against reality.

```
@dependabot rebase
```

That comment tells Dependabot to recreate the branch on top of the current default branch and re-run everything. It's the cleanest possible experiment, because it **isolates the variable you care about**: same dependency bump, but now on top of a healthy base. Whatever CI says *after* the rebase is finally an honest verdict on the upgrade itself.

I fired `@dependabot rebase` at every PR in the stale clusters and waited.

## Now the failures meant something

After the rebases, the board sorted itself into two clean piles, and *this* is where the real information was:

- **The ones that went green.** These were never the dependency's fault; they were hostages of a broken base. They rebased, CI passed against current `main`, and I approved them and added them to the merge queue. About 25 PRs. The queue re-runs the required checks one more time before it merges, so "green after rebase" gets a second, serialized confirmation on its way in — I'm not trusting a single snapshot.

- **The ones that stayed red.** *Now* a red X was worth reading, because the only thing that had changed was the base — and it was healthy. These were the genuine major-version incompatibilities: a React major that needed code changes, an ESLint 8→10 jump that broke config in two repos, a Next.js major, a couple of runtime majors (Express 4→5, a Node engine bump) that pass CI but change behavior in ways I want to read before shipping. That's a real short-list — a handful of PRs that actually deserve a human — instead of a wall of 43 red Xs I'd have rubber-stamped or ignored wholesale.

```bash
# Enqueue a verified-safe PR. No --squash flag on purpose: the merge queue owns
# the merge method, and the queue re-runs required checks before it merges — so
# this is a second gate, not a rubber stamp. Nothing here arms auto-merge; I
# still click "Merge when ready" on the majors myself.
gh pr merge <number> --repo Aswincloud/<repo>
```

## The lesson I keep paying tuition on

The failure that looks like the dependency is usually the base. The green check that looks like health is sometimes a ping answered by the wrong host. In both directions, the CI signal is a *starting point for a question*, not the answer — and the actual work is figuring out **why** it's the color it is.

Forty-three red PRs sounds like forty-three problems. It was really two — a lint error and a broken deploy step, both already fixed — wearing forty-three costumes. The costume was the stale branch. `@dependabot rebase` took the costumes off, and then, for the first time, the handful of PRs still standing there in red were telling me the truth.

I did this triage by hand this time. The next post is about what happened when I got tired of doing org-wide chores by hand and [built a reconciler to do them on a schedule](/posts/gh-org-guard-self-healing-governance/) — because "a human notices the board is red and investigates" is not a control you can rely on at 43 PRs, let alone 430.
