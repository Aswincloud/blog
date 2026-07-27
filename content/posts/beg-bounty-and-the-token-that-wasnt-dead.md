---
title: "A stranger emailed me about a leaked token. The scary part was the second one."
date: 2026-07-25
description: "An unsolicited 'security alert' about a secret in one of my public repos turned out to be right — but chasing it down taught me two things worth more than the fix: 'revoked' in a dashboard doesn't mean a key is dead, and the leak I already knew about was hiding a second one I didn't."
slug: "beg-bounty-and-the-token-that-wasnt-dead"
---

I got an email from someone I didn't know, flagging a hardcoded API token in one of my public GitHub repos. It had the shape of the genre: a free-mail sender, a display name dressed up to look like an automated scanner, a helpful offer to tell me more. This is a whole cottage industry — scrape public repos for anything token-shaped, mass-mail the owners, hope a few panic and pay. Most of it is noise.

The problem is that "mostly noise" is not "always wrong." This one was right. There *was* a live token sitting in a public repo. And the interesting part of this story isn't the leak — it's the two things I got wrong while cleaning it up.

## Wrong assumption #1: I thought it was already dead

The token was a [Telegram](https://telegram.org/) bot credential for one of my little side bots. When I first went to triage it, I looked at the repo's secret-scanning alert and saw it had been marked **resolved — "revoked"** months earlier. Case closed, I thought. Old news. Some past version of me had already handled this.

Then I actually tested the key.

```bash
# The only honest way to know if a token is dead: ask the API that owns it.
# 200 + bot JSON  => STILL LIVE.  401 Unauthorized => actually dead.
curl -s "https://api.telegram.org/bot<redacted-token>/getMe"
# {"ok":true,"result":{"id":...,"is_bot":true,"username":"..."}}   <- live.
```

It answered. `ok: true`. The token I'd been told, by my own dashboard, was "revoked" — was fully, cheerfully alive, and had been for months.

> Marking an alert "revoked" in a UI is a note to yourself. It changes a label in a database. It does **not** reach out and invalidate the secret. The only thing that kills a credential is rotating it *at the source that issued it* — here, [BotFather](https://core.telegram.org/bots#botfather). I had confused "I filed the paperwork" with "the threat is gone."

This is the same disease as [the status page that pinged the wrong host](/posts/status-page-that-survives-home/): a check that reports success for a reason unrelated to the thing you care about. There, a ping answered by Cloudflare instead of my origin. Here, a dashboard status that reflects a human clicking a dropdown, not the actual state of the key. Both are green. Both are lying.

So I did it in the correct order, which I'll never do out of order again:

1. **Rotate at the source first.** Revoke the token in BotFather; get the new one.
2. **Confirm the old one is dead.** `getMe` on the old token now returns `401`. *Now* it's actually revoked.
3. **Only then** mark the alert resolved — because now the label is finally true.

## Wrong assumption #2: this was a one-off

Having been humbled once, I stopped trusting my sense of "I'd know if there were others." I ran a sweep across every repo in my [GitHub org](https://github.com/Aswincloud) — not just "is there an open alert," but "is secret scanning even *turned on* here, and are there live keys nobody's looking at."

That last question is the one that mattered, because it exposed the trap: **secret scanning only alerts on repos where it's enabled.** A repo with scanning switched off isn't reported as risky. It's reported as *nothing at all*. Silence. And silence reads exactly like safety.

The sweep found a second live Telegram token — a different bot, a different repo — one where scanning had never been enabled. GitHub had never warned me about it because I'd never asked it to look. If I'd only chased the single token in the stranger's email and stopped, I'd have "fixed the problem" and left an identical one live three repos over.

```bash
# The sweep's real job wasn't "list open alerts" (that only covers repos already
# being watched). It was "which public repos have scanning OFF" — because those
# are the ones that can't generate an alert no matter what's committed to them.
gh api "orgs/<org>/repos?type=public&per_page=100" --paginate \
  --jq '.[] | select(.archived==false)
        | {name, scanning: .security_and_analysis.secret_scanning.status}'
# ...any "status":"disabled" line is a blind spot, not a clean bill of health.
```

Second token: rotate at source, confirm `401`, mark resolved, turn scanning **on** for that repo so the next mistake actually gets caught.

## What I actually changed (so it's not just a story)

Fixing two keys is not a fix. Fixing the *conditions that let two keys sit live* is. So:

- **Secret scanning + push protection on, org-wide** — including a default for new repos, so "I forgot to enable it" stops being a category of failure. Push protection is the good kind of annoying: it blocks the commit that introduces a secret, at push time, before it's ever public.
- **A weekly automated sweep** that re-asks the boring questions — is scanning on everywhere, is push protection on, are there open alerts — and files an issue if the answer drifts. I wrote about the reconcile-don't-configure philosophy behind this in [the org-guard post](/posts/gh-org-guard-self-healing-governance/); secret hygiene is just one more thing that has to be *re-checked on a schedule*, not set once and trusted forever.
- **A written triage runbook**: rotate-at-source → confirm dead → mark resolved, in that order, every time. The order is the whole point.

## The part I want to remember

The stranger's email was, functionally, spam. The genre it belongs to preys on exactly the panic reflex that makes people pay up, and the right response to "pay me to learn more" is to not. But treating the *message* as spam and treating the *claim* as false are two different moves, and only the first one was safe.

The email was worth precisely one thing: a nudge to go look. Everything valuable after that came from me looking properly — testing the key instead of trusting the label, and sweeping for the blind spots instead of fixing the one thing I'd been handed. The token in the email was never the real risk. The real risk was the one I was sure I didn't have.

Everything here is redacted — the tokens are long dead, rotated at the source, confirmed with a `401`. Which is the only version of "revoked" I trust now.
