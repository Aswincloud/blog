---
title: "Governing a one-person GitHub org without locking myself out"
date: 2026-07-27
description: "I wanted every public repo in my org to enforce branch protection and required reviews. The catch: require one approval on a solo org and the owner's own PRs can never be approved — the repo bricks itself. The fix is a governance system that's careful about the exact order it does things."
slug: "gh-org-guard-self-healing-governance"
---

I run a GitHub org with something north of twenty public repos and exactly one human in it: me. I wanted the boring, grown-up guarantees on all of them — no force-pushing `main`, no deleting branches, pull requests required, reviews required, secret scanning on. The kind of thing an org admin sets up once and forgets.

The problem is that "sets up once" is precisely the wrong mental model, and the moment I tried to apply "require one approving review" org-wide, I walked straight into a trap that nearly bricked a repo. That trap, and the way out of it, is the whole reason [gh-org-guard](https://github.com/Aswincloud/gh-org-guard) exists.

## The solo-owner deadlock

Here's the trap, and it's a good one because every individual piece is a best practice.

Require at least one approving review before a PR can merge: sensible. Don't let people approve their own pull requests: obviously sensible — it's the entire point of review. Now put those two rules on a repo where you are the only person with access.

You open a PR. It needs one approval. The only person who can approve is you. You are not allowed to approve your own PR. **The PR can never merge.** The repo is now read-only to its own owner, and the settings that did it are the settings you'd get by clicking every checkbox a security guide told you to click.

> Any system powerful enough to lock a branch is powerful enough to lock *you* out of it. If there's no deliberate escape hatch, you didn't build governance — you built a very compliant brick.

I hit this, backed it out, and realized the fix couldn't be "remember not to turn that rule on." It had to be a system that understands the deadlock and refuses to create it.

## Two baselines: FLOOR and REVIEW

The design that came out of it is two baselines and a strict rule about which one a repo is allowed to be on.

**FLOOR** is the safe-on-anything baseline: block force-push and branch deletion, require a PR, require conversation resolution — but **zero required approvals**. A solo owner can always merge their own work. FLOOR can never deadlock, so it's safe to apply blindly to every repo in the org.

**REVIEW** is FLOOR *plus* the grown-up part: one required approval and a code-owner review. This is the baseline that would have bricked me — *unless* something can supply that approval without me clicking "approve" on my own PR.

So the rule is: a repo is only allowed onto REVIEW once it has both a `CODEOWNERS` file **and** a working auto-approver. If either is missing, it stays on FLOOR. And critically, the reconciler will drop a REVIEW repo *back down* to FLOOR if it ever needs to rewrite one of those files — never leaving a gap where the rule is on but the escape hatch is off.

```
Does the repo have BOTH a CODEOWNERS and a working auto-approver?
        │                                   │
       no                                  yes
        ▼                                   ▼
     FLOOR                               REVIEW
  0 approvals,                      1 approval + code-owner,
  owner can always merge           owner's PR gets auto-approved
```

Plus a break-glass rule I consider non-negotiable: org admins can always bypass. If some required status check gets misconfigured and starts failing forever, I am not locked out of my own repos while I fix it. The escape hatch is load-bearing.

## Why a bot can't just approve the PR

"Fine," you say, "just have a bot approve your PRs." I tried. GitHub has a rule waiting for you here too: **an approval from an app or bot does not count toward a ruleset's required-approval count.** Only a review from a real user with write access counts. A bot can click approve all day; the PR stays blocked.

So the auto-approver uses **two identities on purpose**:

- A **GitHub App token** to *read* team membership — is the author of this PR actually an admin who should get an auto-approval?
- A **real write-collaborator account's token** to *cast* the approval — because only a real user's review satisfies the requirement.

```yaml
# The membership check runs under the App token (it only needs to read teams).
# The approval itself runs under WRITE_ACCESS_PAT — a real user with write
# access — because GitHub silently ignores a bot's approval toward required
# reviews. Two identities, two jobs. It ONLY ever approves; it never merges.
- name: Approve the PR
  if: steps.member.outputs.is_admin == 'true'
  env:
    GH_TOKEN: ${{ secrets.WRITE_ACCESS_PAT }}   # a user, not the app
  run: |
    gh pr review "${PR}" --repo "${REPO}" --approve \
      --body "Auto-approved: @${AUTHOR} is a member of @${ORG}/${TEAM}."
```

Three guardrails on that approver, because an auto-approver is a scary thing to have lying around:

1. **It only approves — it never merges.** I still click "Merge when ready" myself. No auto-merge, ever. The system decides a PR is *allowed* to merge; a human decides *when*.
2. **It won't self-approve.** If the token's user happens to be the PR author, GitHub blocks it anyway, so it detects that case and leaves a comment instead of silently doing nothing.
3. **It approves once per PR, not once per push** — no timeline spam.

## Reconcile, don't configure

The deeper idea — the one this whole project is really about — is in that word from the deadlock section: *once*. Settings configured once **drift**. A new repo starts unprotected. Someone toggles a setting to debug something and forgets to toggle it back. Secret scanning gets left off on the one repo that ends up holding a live token (which is [exactly how I got here](/posts/beg-bounty-and-the-token-that-wasnt-dead/)).

gh-org-guard doesn't configure. It **reconciles**: a scheduled job that, every week, re-asserts the desired state across every public repo. Already correct? No-op. Drifted? Corrected. It's the same discipline I'd just been applying by hand to [a wall of stale Dependabot PRs](/posts/43-red-dependabot-prs-none-were-the-dependency/) — except a schedule doesn't get tired, doesn't skip the boring repo, and doesn't forget that "I set this up in March" is not the same as "this is true today."

Two things make running it safe rather than terrifying:

- **Dry-run by default.** A scheduled run enforces; a manual run only *prints what it would do* unless I explicitly flip a flag. A misclick can't rewrite the whole org.
- **Idempotent everything.** Every step is safe to repeat. "Already in the desired state" is a no-op, not an error — which is what lets it run unattended forever.

```
### org reconcile — DRY-RUN (no changes)
| repo        | action  | note                                   |
|-------------|---------|----------------------------------------|
| blog        | in-sync |                                        |
| new-service | FLOOR   | would add CODEOWNERS; would add caller |
| api         | REVIEW  | raised to require-review               |

review=1 floor=1 in-sync=1 skip=4 blocked=0
```

I eventually packaged it as a composite GitHub Action so it's a few lines of YAML to drop into another org, defaulting to dry-run so nobody's first run is a surprise. But the Action is just packaging. The idea is the thing worth stealing: **posture is a state you continuously reconcile toward, not a checkbox you tick.** A rule you set once and trust forever is just a slower way of finding out it drifted — and if that rule is powerful enough to lock a branch, make very sure it can never lock out the one person holding the keys.
