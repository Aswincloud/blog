---
title: "Rebuilding my portfolio with an AI agent: the mistakes were the useful part"
date: 2026-07-16
description: "I rebuilt aswincloud.com pairing with an AI coding agent in my terminal. The interesting part wasn't 'AI wrote my site' — it's the loop that kept it honest: a bug I'd written and never noticed, an animation I swore was running but couldn't actually see, and two dependency bumps that quietly broke the build."
slug: "rebuilding-portfolio-with-ai"
---

My portfolio isn't hosted here in the homelab — it's on the Cloudflare edge, same as the [status page](/posts/status-page-that-survives-home/), for the same reason: a site about me shouldn't go dark when my ISP hiccups. But two pieces of it *do* live on the TrueNAS box in the next room — a self-hosted contact API and a self-hosted [Chatwoot](https://www.chatwoot.com/) chat widget — so it counts as homelab enough to write up here.

Except the gadget isn't the point. I rebuilt the whole thing pairing with an AI coding agent ([Claude Code](https://claude.com/claude-code)) running in my terminal, and the parts worth writing down are the same parts that are always worth writing down: the bugs, the gotchas, and the one workflow rule that kept "an AI helped" from turning into "an AI quietly broke things I didn't check."

I want to be upfront about the AI part, because the honest version is more interesting than the marketing one. It did **not** write my website while I watched. The useful mental model is a very fast, very literal collaborator who will happily do the tedious legwork — wire up the component, run the build, drive a headless browser, open the pull request — but who needs a human to make the calls and, more importantly, needs a human who refuses to accept "it works" without proof. Every good moment below came from me saying some version of *"I don't see it"* or *"that looks risky, check it first."*

## The animation I swore was running

Here's my favourite mistake of the whole rebuild.

The hero section has an aurora background — three big, soft, coloured glows drifting behind the headline. Early on I was asked whether the site had any live motion. I checked the code, saw the drift keyframes were applied to the elements, and said yes, confidently: it's animating.

Then I actually looked at the page. And it wasn't — not in any way a human eye could register. The glows *were* moving. The transform values were changing every frame, exactly as written. But they're ~670px-wide blobs, blurred by 40-plus pixels, at very low opacity, drifting about 40px over six seconds. A faint, enormous, heavily-blurred cloud moving that slowly is *below the threshold you can perceive*. The code was animating. The screen was not.

> "It animates" and "you can see it move" are two different claims. The first is about the code. The second is about a human looking at a screen. On a portfolio — or a status page, or a door sensor that's supposed to announce something — only the second one counts. I'd verified the wrong one.

The fix was unglamorous: raise the opacity, tighten the blur, widen the drift, speed the loop up until the background genuinely breathes. Then, while I was in there, I added the two touches people actually comment on now — a highlight that sweeps across one word in the headline every few seconds, and stat tiles that count up from zero when you scroll to them.

## The count-up that had already finished before you saw it

That count-up shipped with a bug so subtle I only caught it because I'd learned my lesson from the aurora and was *watching the real page* instead of trusting the code.

The numbers were animating from zero to their target — correctly, by the code. But they started climbing the instant the component mounted, and the easing curve front-loads the motion (fast at first, slow at the end). So by the time the tile had finished fading in, the counter was already ~84% of the way to its value. You'd catch it going `9 → 10` and swear it never animated at all.

Same disease as the aurora, different symptom: *technically running, practically invisible.* The fix was to hold the climb until the entrance fade finishes, then count at a steady pace:

```javascript
// Don't start counting until the tile has actually faded in, then use a
// gentler curve so the whole climb is visible — not front-loaded into the
// fade where nobody sees it.
useEffect(() => {
  if (!inView) return;
  const started = performance.now();
  const DELAY = 400;      // let the entrance animation land first
  const DURATION = 1600;  // slow enough to read every tick

  let raf = 0;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - started - DELAY) / DURATION));
    const eased = 1 - Math.pow(1 - t, 3); // ease-out, but not a cliff
    setValue(Math.round(target * eased));
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, [inView, target]);
```

Now you actually watch it tick `1, 2, 4, 6, 8, 10` past. It's a two-line idea. It was invisible for a day because "the animation code runs" had, again, been mistaken for "you can see the animation."

## The bug I'd written myself and never noticed

The self-hosted chat widget is the homelab-iest part of the site. Open it and — as I found out only when someone pointed it out — you couldn't click outside the panel to close it. Every other chat on the internet closes when you click away; mine didn't.

There *was* an outside-click handler already in the page. It simply never did anything. It was guarding on a CSS class — `.woot-widget-bubble--expanded` — to decide "is the panel open?", and that class **does not exist** in the version of the Chatwoot SDK the site actually loads. So the guard's condition was never true, the handler bailed on every single click, and the close never fired.

I'd been reasoning from the class name I *assumed* was there. The fix only came from stopping and inspecting the live widget's real DOM, where the actual open/closed signal turned out to be a `woot--hide` class on a completely different element:

```javascript
document.addEventListener('click', (e) => {
  const holder = document.querySelector('#cw-widget-holder, .woot-widget-holder');
  // woot--hide is present when the panel is CLOSED. No holder, or hidden →
  // nothing to close. (The class I originally checked for never existed in
  // this SDK version, so the old guard was always false and never closed.)
  if (!holder || holder.classList.contains('woot--hide')) return;

  const bubble = document.querySelector('#cw-bubble-holder, .woot-widget-bubble');
  if (bubble && bubble.contains(e.target)) return; // clicked the launcher itself
  if (e.target.closest('.woot-widget-holder')) return; // clicked inside the panel

  window.$chatwoot.toggle('close');
});
```

It's the ping-check trap from the status-page post, wearing a different outfit: **a check that passes for the wrong reason is worse than no check.** There, a `ping` to a proxied host was answered by Cloudflare instead of my origin, so the monitor was green while the house was down. Here, a guard clause matched a class that never appears, so the close silently never happened. Both look fine in the code review. Both are lying.

## Two dependency bumps that did not "just bump"

Two upgrades that looked like routine version bumps and absolutely were not.

**The icon library.** A new major version of the icon set removed *every* brand logo — GitHub, LinkedIn, all of them — for trademark reasons. Not renamed. Gone. So a plain bump broke the production build with missing-export errors for icons that had simply ceased to exist. The build "passed" the version-resolution step and then fell over at compile. The fix was to drop in two tiny inline-SVG components with the same call signature as the old icons, so nothing else in the codebase had to change.

**The linter.** Upgrading to the new major of ESLint dragged in a newer hooks plugin that turns on strict new rules *by default* — and those rules flagged perfectly good code, including the count-up hook above. The tempting moves were both wrong: force it through with a blanket ignore, or let the tool talk me into rewriting working code to satisfy a brand-new opinion. What I actually did was opt out of exactly the two new opinionated rules while keeping every rule that catches real hook bugs — a deliberate, narrow decision, made out loud, rather than a reflexive one.

> A green CI run is necessary, not sufficient. A dependency can install cleanly, satisfy the resolver, pass every automated gate, and still be the wrong thing to merge — because "it installs" tells you nothing about whether the API you were relying on still exists. The automated checks catch what they were told to look for. Whether the upgrade *makes sense* is still a human call.

## The boring loop that made all of it safe

None of the above would have stayed sane — least of all with an eager agent that can generate changes far faster than I can eyeball them — without a strict, boring loop around every single change:

- **Make the change, then *prove* it.** Every visual change got built and driven in a real headless browser, screenshotted, and looked at. Not "the test passes" — "here is the frame where the number is mid-climb." The aurora and the count-up are exactly what this catches: code that runs but doesn't do the thing.
- **A ship-gate before anything merges.** Lint with zero warnings allowed, formatting, a copyright-header check, the unit tests, a security audit, and a production build — all green, locally, before a pull request even opens.
- **One change, one PR.** The shimmer, the chat fix, the performance pass, the accessibility pass — each is its own small, reviewable pull request instead of one heroic "redesign" commit. Easier to review, easier to revert, easier to explain to myself in six months.
- **Correct the record when you're wrong.** The aurora is the template for the whole thing: claim it works, look, discover it doesn't, say so, fix it. That loop only functions if being wrong is cheap and admitting it is routine.

That last one is really the whole post. Pairing with an AI agent didn't remove the need for judgement, skepticism, and proof — it *concentrated* it. The agent will cheerfully tell you the animation is running, because the code says so. Your job is to be the one who looks at the screen and says "no it isn't," and then makes it prove the fix.

The site's live at [aswincloud.com](https://www.aswincloud.com/). If you find a bug I didn't — [tell me](https://www.aswincloud.com/#contact); that's just the next turn of the same loop.
